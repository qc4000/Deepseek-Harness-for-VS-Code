// dsh-vscode-layout client bundle (ModuleLoader format)
//
// 作用：DSH Web GUI 是三栏 grid（左栏 = `div._sidebarCol`，宽度写在内联的
// grid-template-columns 里），外层 VS Code 扩展与 DSH 页面跨源、拿不到 DOM，
// 因此本插件把左侧栏的**实时宽度**与**折叠状态**用 postMessage 上报给宿主，
// 宿主据此把侧栏那一段像素"移出可视区"（父容器视口裁剪）。
//
// 测量口径（spec 015）：优先读 frame 的 grid **第一轨道**，不可解析才回退侧栏矩形。
// dsh 0.2.2 起 <768px 是抽屉态：侧栏变成绝对定位浮层（矩形仍是 280，收起只
// translate(-100%)），而 grid 第一轨道为 0 —— 按矩形裁剪会把对话区左侧切掉，
// 且裁剪量会反过来改变 iframe 宽度（= DSH 视口）形成 2-周期振荡（488–711px 实测闪烁）。
// 抽屉态同时上报 `drawer: true`，宿主据此把顶部按钮改成请求 DSH 原生展开/收起。
//
// 三条约束（与 dsh-vscode-file-links 一致）：
// 1. 只在宿主完成握手（ack）后开始测量与响应；独立浏览器 / 其它宿主里完全不动作；
// 2. 不改 DOM、不拦任何事件；唯一写动作是宿主显式请求（layout-toggle）时调用一次
//    DSH 公开服务 `ctx.layout.toggleSidebar()`（与 dsh-vscode-workspace 同类先例）；
// 3. 读不到就不上报（宿主据此保持原样并提示），绝不猜测宽度。

window.__ModuleLoader__.load({ id: 'dsh-vscode-layout', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var PLUGIN_VERSION = '0.2.0'
  var HOST_ID = 'dsh-vscode-host'
  var SELF_ID = 'dsh-vscode-layout'
  var HELLO_INTERVAL_MS = 400
  var HELLO_MAX_TRIES = 25
  var DISCOVERY_INTERVAL_MS = 500
  var DISCOVERY_MAX_TRIES = 60
  var POLL_INTERVAL_MS = 500
  var MIN_DELTA = 0.5

  var acked = false
  var disposed = false
  var helloTimer = null
  var helloTries = 0
  var discoveryTimer = null
  var discoveryTries = 0
  var pollTimer = null
  var resizeObserver = null
  var attrObserver = null
  var rafPending = false
  var target = null
  var last = null
  // 客户端上下文（apply 时保存）：抽屉态转调需要它取 ctx.layout 服务。
  var rootCtx = null

  /** 向父级（webview）发消息：附带自身身份标记。 */
  function post(payload) {
    payload.source = SELF_ID
    payload.version = PLUGIN_VERSION
    try {
      // 跨源下拿不到父级 origin；宿主侧按 event.source + event.origin 双重校验。
      window.parent.postMessage(payload, '*')
    } catch (e) { /* 父级不可达：静默失败，宿主保持原样 */ }
  }

  function stopHello() {
    if (helloTimer !== null) {
      window.clearInterval(helloTimer)
      helloTimer = null
    }
  }

  /** 周期打招呼，直到拿到 ack（插件可能在宿主就绪前后任意时刻加载）。 */
  function startHello() {
    if (disposed || acked || helloTimer !== null) return
    post({ type: 'hello' })
    helloTries += 1
    if (helloTries >= HELLO_MAX_TRIES) return
    helloTimer = window.setInterval(function () {
      if (disposed || acked || helloTries >= HELLO_MAX_TRIES) { stopHello(); return }
      helloTries += 1
      post({ type: 'hello' })
    }, HELLO_INTERVAL_MS)
  }

  /** 左侧栏元素：CSS Modules 类名形如 `pI_x6G_sidebarCol`，按局部名后缀匹配。 */
  function findTarget() {
    try {
      var el = document.querySelector('[class*="_sidebarCol"]')
      if (el) return el
      var frame = document.querySelector('[class*="_frame"]')
      if (frame && frame.firstElementChild) {
        var cls = String(frame.firstElementChild.className || '')
        if (cls.indexOf('sidebarCol') >= 0) return frame.firstElementChild
      }
    } catch (e) { /* 选择器不支持等：当作未找到 */ }
    return null
  }

  function frameOf(el) {
    return el && el.parentElement ? el.parentElement : null
  }

  function isCollapsed(el) {
    var frame = frameOf(el)
    try {
      return !!(frame && typeof frame.hasAttribute === 'function' && frame.hasAttribute('data-sidebar-collapsed'))
    } catch (e) {
      return false
    }
  }

  /** frame 是否处于 dsh 0.2.2+ 的抽屉态（`<768px`：侧栏为浮层、grid 首轨 0）。 */
  function isDrawerFrame(frame) {
    try {
      return !!(frame && typeof frame.hasAttribute === 'function' && frame.hasAttribute('data-sidebar-drawer'))
    } catch (e) { return false }
  }

  /** 当前目标元素（或现查一次）所处 frame 的抽屉态。 */
  function drawerNow() {
    return isDrawerFrame(frameOf(target || findTarget()))
  }

  /**
   * 取客户端上下文里的服务：先属性访问（真机客户端上下文里 `ctx.get(name)` 不一定
   * 解析得到——dsh 自家客户端插件取服务一律用属性），再退回 `ctx.get`。
   * @param {string} name
   * @returns {any} 取不到返回 null
   */
  function serviceOf(name) {
    if (!rootCtx) return null
    try {
      var own = rootCtx[name]
      if (own !== undefined && own !== null) return own
    } catch (e) { /* 上下文代理可能拒绝访问：走下一条退路 */ }
    try {
      if (typeof rootCtx.get === 'function') {
        var got = rootCtx.get(name)
        if (got !== undefined && got !== null) return got
      }
    } catch (e2) { /* 服务未就绪：走下一条退路 */ }
    return null
  }

  /**
   * 读取宽度：**首选 frame 的 grid 第一轨道**（抽屉态为 0、导轨 56、展开 264–420），
   * 计算值不可解析时才回退侧栏矩形（004 老口径，兼旧环境）。
   * 失败返回 null。
   */
  function measure(el) {
    var frame = frameOf(el)
    var width = null
    try {
      if (frame && typeof window.getComputedStyle === 'function') {
        var cols = String(window.getComputedStyle(frame).gridTemplateColumns || '').split(' ')
        var track = parseFloat(cols[0])
        // 为什么轨道优先：抽屉态侧栏是绝对定位浮层，矩形宽仍是 280（收起只 translate），
        // 只有轨道才是它对布局的真实占位——按矩形裁剪会切掉对话区（spec 015）。
        if (track >= 0 && isFinite(track)) width = track
      }
    } catch (e) { width = null }
    if (width === null) {
      try {
        if (typeof el.getBoundingClientRect === 'function') {
          width = Number(el.getBoundingClientRect().width)
        }
      } catch (e2) { width = null }
    }
    if (width === null || !isFinite(width) || width < 0) return null
    return {
      sidebarWidth: Math.round(width * 10) / 10,
      collapsed: isCollapsed(el),
      drawer: isDrawerFrame(frame)
    }
  }

  /** 上报一次（默认宽度/折叠状态变化才发；force 时无论是否变化都发）。 */
  function report(force) {
    rafPending = false
    if (disposed || !acked) return
    var el = target
    if (!el) el = findTarget()
    if (!el) return
    target = el
    var m = measure(el)
    if (!m) return
    if (!force && last && Math.abs(last.sidebarWidth - m.sidebarWidth) < MIN_DELTA
      && last.collapsed === m.collapsed && last.drawer === m.drawer) return
    last = m
    post({ type: 'layout', sidebarWidth: m.sidebarWidth, collapsed: m.collapsed, drawer: m.drawer })
  }

  /** 合并到下一帧上报（拖动时不必每个像素发一条）。 */
  function schedule() {
    if (disposed || !acked || rafPending) return
    rafPending = true
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(function () { report(false) })
    } else {
      window.setTimeout(function () { report(false) }, 16)
    }
  }

  function stopWatch() {
    if (resizeObserver) {
      try { resizeObserver.disconnect() } catch (e) { /* noop */ }
      resizeObserver = null
    }
    if (attrObserver) {
      try { attrObserver.disconnect() } catch (e) { /* noop */ }
      attrObserver = null
    }
    if (pollTimer !== null) {
      try { window.clearInterval(pollTimer) } catch (e) { /* noop */ }
      pollTimer = null
    }
  }

  function watch(el) {
    stopWatch()
    target = el
    // 拖动 / 折叠动画都会改变左栏宽度 → ResizeObserver 逐帧通知
    try {
      if (typeof window.ResizeObserver === 'function') {
        resizeObserver = new window.ResizeObserver(function () { schedule() })
        resizeObserver.observe(el)
      }
    } catch (e) { resizeObserver = null }
    // 折叠状态是 frame 上的属性，宽度变化不一定同帧可见 → 额外监听属性
    try {
      if (typeof window.MutationObserver === 'function') {
        var frame = frameOf(el)
        if (frame) {
          attrObserver = new window.MutationObserver(function () { schedule() })
          attrObserver.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-animating'] })
        }
      }
    } catch (e) { attrObserver = null }
    // 兜底轮询：DSH 若换了实现（无 CSS 过渡/无观察器）也不会漏掉
    pollTimer = window.setInterval(function () { schedule() }, POLL_INTERVAL_MS)
    schedule()
  }

  function stopDiscovery() {
    if (discoveryTimer !== null) {
      clearTimeout(discoveryTimer)
      discoveryTimer = null
    }
  }

  /** SPA 首帧可能还没有 sidebarCol：轮询等待，超时后停止（宿主会提示不可用）。 */
  function startDiscovery() {
    stopDiscovery()
    if (disposed) return
    var el = findTarget()
    if (el) { watch(el); return }
    discoveryTries += 1
    if (discoveryTries > DISCOVERY_MAX_TRIES) return
    discoveryTimer = setTimeout(function () {
      discoveryTimer = null
      startDiscovery()
    }, DISCOVERY_INTERVAL_MS)
  }

  function onMessage(event) {
    if (disposed) return
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || typeof data !== 'object' || data.source !== HOST_ID) return
    if (data.type === 'ack') {
      if (data.layout === false) { stopHello(); return }
      acked = true
      stopHello()
      startDiscovery()
      return
    }
    if (data.type === 'request-layout') {
      // 宿主刚做了预测，需要一次权威值校正：即使与上次一样也要发。
      report(true)
      return
    }
    if (data.type === 'layout-toggle') {
      // 抽屉态下宿主按钮/命令的转调请求（spec 015）：未握手不响应；只在抽屉态执行
      // （grid 态宿主按裁剪语义切换，不会发这条）。任何结果都回执，绝不静默。
      if (!acked) return
      if (!drawerNow()) {
        post({ type: 'layout-toggle-result', ok: false, reason: 'not-drawer' })
        return
      }
      var layout = serviceOf('layout')
      if (!layout || typeof layout.toggleSidebar !== 'function') {
        post({ type: 'layout-toggle-result', ok: false, reason: 'unsupported' })
        return
      }
      try {
        layout.toggleSidebar()
        post({ type: 'layout-toggle-result', ok: true })
      } catch (e) {
        post({ type: 'layout-toggle-result', ok: false, reason: 'failed' })
      }
    }
  }

  function apply(ctx) {
    rootCtx = ctx || null
    function arm() {
      window.addEventListener('message', onMessage, false)
      startHello()
    }
    function disarm() {
      disposed = true
      window.removeEventListener('message', onMessage, false)
      stopHello()
      stopDiscovery()
      stopWatch()
      target = null
      last = null
    }
    if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { arm(); return disarm })
    else arm()
    // 排障用：控制台可查 __dshVscodeLayout.acked()
    window.__dshVscodeLayout = {
      version: PLUGIN_VERSION,
      acked: function () { return acked }
    }
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })
