// dsh-vscode-layout client bundle (ModuleLoader format)
//
// 作用：DSH Web GUI 是三栏 grid（左栏 = `div._sidebarCol`，宽度写在内联的
// grid-template-columns 里），外层 VS Code 扩展与 DSH 页面跨源、拿不到 DOM，
// 因此本插件把左侧栏的**实时宽度**与**折叠状态**用 postMessage 上报给宿主，
// 宿主据此把侧栏那一段像素"移出可视区"（父容器视口裁剪）。
//
// 三条约束（与 dsh-vscode-file-links 一致）：
// 1. 只在宿主完成握手（ack）后开始测量；独立浏览器 / 其它宿主里完全不动作；
// 2. 只读：getBoundingClientRect / 属性读取，不改 DOM、不拦任何事件；
// 3. 读不到就不上报（宿主据此保持原样并提示），绝不猜测宽度。

window.__ModuleLoader__.load({ id: 'dsh-vscode-layout', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var PLUGIN_VERSION = '0.1.0'
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

  /** 读取宽度：优先元素几何，回退到 frame 的 grid 第一段。失败返回 null。 */
  function measure(el) {
    var width = 0
    try {
      if (typeof el.getBoundingClientRect === 'function') {
        width = Number(el.getBoundingClientRect().width)
      }
    } catch (e) { width = 0 }
    if (!(width > 0)) {
      var frame = frameOf(el)
      try {
        if (frame && typeof window.getComputedStyle === 'function') {
          var cols = String(window.getComputedStyle(frame).gridTemplateColumns || '').split(' ')
          width = parseFloat(cols[0] || '0') || 0
        }
      } catch (e) { width = 0 }
    }
    if (!isFinite(width) || width < 0) return null
    return { sidebarWidth: Math.round(width * 10) / 10, collapsed: isCollapsed(el) }
  }

  /** 上报一次（宽度/折叠状态变化才发）。 */
  function report() {
    rafPending = false
    if (disposed || !acked) return
    var el = target
    if (!el) el = findTarget()
    if (!el) return
    target = el
    var m = measure(el)
    if (!m) return
    if (last && Math.abs(last.sidebarWidth - m.sidebarWidth) < MIN_DELTA && last.collapsed === m.collapsed) return
    last = m
    post({ type: 'layout', sidebarWidth: m.sidebarWidth, collapsed: m.collapsed })
  }

  /** 合并到下一帧上报（拖动时不必每个像素发一条）。 */
  function schedule() {
    if (disposed || !acked || rafPending) return
    rafPending = true
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(report)
    } else {
      window.setTimeout(report, 16)
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
      schedule()
    }
  }

  function apply(ctx) {
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
