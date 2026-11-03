// dsh-vscode-open-external client bundle (ModuleLoader format)
//
// 作用：DSH 页面被 Deepseek-Harness-for-VS-Code 扩展以跨源 iframe 内嵌时，
// 页面里的 window.open 打不开真正的浏览器窗口（VS Code webview 不允许新开窗口）。
// DSH 的「登录 DeepSeek 账号」正是这个路径（packages/client/ui-settings-account 的
// BrowserLogin：先 window.open('about:blank') 预开页，拿到授权链接后再 replace 过去），
// 于是登录流程会卡在「没有自动打开新页面？」。
//
// 0.2.0 起还补上 `<a target="_blank">` / 修饰键 / 中键这一层：它们不经过 window.open，
// 而 webview 的 sandbox 没有 allow-popups，默认动作会被静默拦掉（表现为「点了没反应」）。
// 插件在 capture 阶段只识别「新窗口 / 新标签」意图，把链接交给 webview 中继，再由宿主
// 按 `dshPanel.externalLinkAction` 选择系统浏览器或 VS Code 内置浏览器。
//
// 链路：本插件接管 window.open + click/auxclick → 授权/外链经 window.parent.postMessage
//       交给 webview 中继 → 扩展宿主按设置 openExternal / simpleBrowser.show。
//
// 四条底线：
// 1. 只在宿主完成握手（ack）后接管；独立浏览器 / 其它宿主里完全不介入；
// 2. 只转交 http/https 链接（超长、非法 scheme 一律回退原生行为）；
// 3. about:blank 预开页返回一个可导航的桩对象，把后续 location.replace/assign/href
//    的跳转目标转交宿主——与 DSH 官方 BrowserLogin 的用法一一对应；
// 4. click 桥只补 DSH 没接管的点击：DSH 已 preventDefault 的普通左键仍走 DSH 侧栏；
//    `target="_self"`（含没写 target）不碰，保持 DSH 当前行为。

window.__ModuleLoader__.load({ id: 'dsh-vscode-open-external', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var PLUGIN_VERSION = '0.2.0'
  var HOST_ID = 'dsh-vscode-host'
  var SELF_ID = 'dsh-vscode-open-external'
  var HELLO_INTERVAL_MS = 400
  var HELLO_MAX_TRIES = 25
  var URL_MAX_LENGTH = 8192
  // window.open 与 click 可能对同一次用户操作各发一条：短时间去重，避免开两个窗口。
  var DEDUPE_MS = 600
  var pendingPopup = null

  var acked = false
  var linksEnabled = false
  var clickInstalled = false
  var helloTimer = null
  var helloTries = 0
  var originalOpen = null
  var patched = false
  var lastHandOffUrl = ''
  var lastHandOffAt = 0

  // macOS 的 Ctrl+click 是右键菜单；只有 ⌘/Shift 才是「新标签/新窗口」。
  var macPlatform = (function () {
    try {
      var ua = window.navigator && window.navigator.userAgent ? window.navigator.userAgent : ''
      return /Mac|iPhone|iPad|iPod/i.test(ua)
    } catch (e) { return false }
  })()

  /** 是否被宿主内嵌（独立浏览器里 parent === self）。 */
  function inIframe() {
    try { return window.parent !== window } catch (e) { return false }
  }

  /** 向父级（webview）发消息：附带自身身份标记。 */
  function postToHost(payload) {
    payload.source = SELF_ID
    payload.version = PLUGIN_VERSION
    try {
      window.parent.postMessage(payload, '*')
    } catch (e) { /* 父级不可达：静默失败 */ }
  }

  function stopHello() {
    if (helloTimer !== null) {
      window.clearInterval(helloTimer)
      helloTimer = null
    }
  }

  function startHello() {
    if (!inIframe() || acked || helloTimer !== null) return
    postToHost({ type: 'hello' })
    helloTries += 1
    if (helloTries >= HELLO_MAX_TRIES) return
    helloTimer = window.setInterval(function () {
      if (acked || helloTries >= HELLO_MAX_TRIES) { stopHello(); return }
      helloTries += 1
      postToHost({ type: 'hello' })
    }, HELLO_INTERVAL_MS)
  }

  /**
   * 把链接交给宿主。非 http/https、超长、非法 URL 返回 false（调用方回退原生行为）。
   * @param {string} url
   * @param {'login'|'popup'|'link'} kind
   * @returns {boolean}
   */
  function handOff(url, kind) {
    if (typeof url !== 'string') return false
    var u = url.trim()
    if (u.length === 0 || u.length > URL_MAX_LENGTH) return false
    try {
      var parsed = new URL(u)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      u = parsed.href
    } catch (e) { return false }
    var now = Date.now()
    if (u === lastHandOffUrl && now - lastHandOffAt < DEDUPE_MS) return true
    lastHandOffUrl = u
    lastHandOffAt = now
    var normalized = kind === 'login' ? 'login' : (kind === 'link' ? 'link' : 'popup')
    postToHost({ type: 'open', url: u, kind: normalized })
    return true
  }

  /**
   * DSH 登录流程先 window.open('about:blank') 预开页，拿到授权链接后再
   * popup.location.replace(url)。这里返回可导航的桩对象，把跳转目标转交宿主；
   * popup.closed / close() / opener 等常见访问保持可用，避免 DSH 逻辑报错。
   */
  function makePopupStub() {
    var stub = {
      closed: false,
      opener: null,
      focus: function () {},
      blur: function () {},
      postMessage: function () {},
      close: function () { stub.closed = true }
    }
    function navigate(target) {
      // 登录授权页固定交系统浏览器：内置浏览器里的 OAuth 回调不可靠。
      if (handOff(target, 'login')) pendingPopup = null
    }
    stub.location = {
      replace: navigate,
      assign: navigate,
      reload: function () {},
      toString: function () { return 'about:blank' },
      get href() { return 'about:blank' },
      set href(target) { navigate(target) },
      get origin() { return 'null' }
    }
    pendingPopup = stub
    return stub
  }

  function isAboutBlank(value) {
    return value === '' || value === 'about:blank'
  }

  function patchedOpen(url, target, features) {
    try {
      if (acked) {
        var raw = typeof url === 'string' ? url : ''
        if (isAboutBlank(raw)) {
          return makePopupStub()
        }
        // 直接 window.open（如 DSH 的 linkOpening=new-tab）按 popup 处理：
        // off 时仍走系统浏览器，保持 0.1.0 的既有行为。
        if (handOff(raw, 'popup')) return null
      }
    } catch (e) { /* 任何异常都回退原生行为 */ }
    return originalOpen.apply(window, arguments)
  }

  function installPatch() {
    if (patched) return
    originalOpen = window.open
    try {
      window.open = patchedOpen
      patched = true
    } catch (e) {
      originalOpen = null
    }
  }

  function removePatch() {
    if (!patched) return
    try { window.open = originalOpen } catch (e) { /* 页面正在卸载：忽略 */ }
    patched = false
    originalOpen = null
    pendingPopup = null
  }

  /** 从事件路径里找最近的 <a href>（兼容 shadow DOM）。 */
  function findAnchor(event) {
    var path = typeof event.composedPath === 'function' ? event.composedPath() : null
    if (path) {
      for (var i = 0; i < path.length; i += 1) {
        var item = path[i]
        if (item && item.nodeType === 1 && item.tagName === 'A' &&
            typeof item.hasAttribute === 'function' && item.hasAttribute('href')) return item
      }
    }
    var node = event.target
    while (node) {
      if (node.nodeType === 1 && node.tagName === 'A' &&
          typeof node.hasAttribute === 'function' && node.hasAttribute('href')) return node
      node = node.parentNode
    }
    return null
  }

  /**
   * 解析 <a> 的外部目标：只认 http(s)、非同源、非 download、非 #hash、长度受限。
   * 返回 null 表示「保持 DSH 原行为」。
   * @param {Element} anchor
   * @returns {string|null}
   */
  function externalHref(anchor) {
    if (typeof anchor.hasAttribute === 'function' && anchor.hasAttribute('download')) return null
    var raw = typeof anchor.getAttribute === 'function' ? anchor.getAttribute('href') : ''
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > URL_MAX_LENGTH) return null
    try {
      var u = new URL(raw, window.location.href)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
      // 同源（含相对路径、#hash）是 DSH 自己的内部导航，不能碰。
      if (u.origin === window.location.origin) return null
      return u.href
    } catch (e) { return null }
  }

  function targetOf(anchor) {
    var target = typeof anchor.getAttribute === 'function' ? anchor.getAttribute('target') : ''
    return typeof target === 'string' ? target.trim().toLowerCase() : ''
  }

  /** 立即接管：阻断默认动作，再交给宿主。 */
  function takeOver(event, url) {
    try { event.preventDefault() } catch (e) { /* 合成事件可能没有 */ }
    try { event.stopPropagation() } catch (e) { /* 同上 */ }
    handOff(url, 'link')
  }

  /**
   * target=_blank 的普通左键先让 DSH 自己处理（侧栏浏览器 / window.open）。
   * 微任务里检查 defaultPrevented：DSH 已接管就跳过，没接管才由我们转交。
   * 默认动作本来就被 sandbox 拦掉，晚一步不会造成导航。
   */
  function deferToHost(event, url) {
    Promise.resolve().then(function () {
      if (!event.defaultPrevented) handOff(url, 'link')
    })
  }

  /**
   * click / auxclick 的统一入口。
   * @param {Event} event
   * @param {boolean} middle 是否为 auxclick 的中键
   */
  function onActivate(event, middle) {
    if (!acked || !linksEnabled) return
    if (event.defaultPrevented) return
    if (event.isTrusted === false) return
    if (middle) {
      if (event.button !== 1) return
    } else if (event.button !== 0) {
      return
    }
    var anchor = findAnchor(event)
    if (!anchor) return
    var url = externalHref(anchor)
    if (!url) return
    var target = targetOf(anchor)
    // target=_self / 没写 target：按规格不接管（含修饰键与中键），保持 DSH 当前行为。
    if (target === '' || target === '_self') return
    var ctrlNewTab = event.ctrlKey && !macPlatform
    var modified = event.metaKey || event.shiftKey || ctrlNewTab
    // Alt+click 在浏览器里常被当作「下载链接」，不抢。
    if (event.altKey && !modified) return
    // macOS 的 Ctrl+click 是右键菜单，别改成新标签。
    if (macPlatform && event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) return

    if (modified || middle) {
      takeOver(event, url)
      return
    }
    if (target === '_blank') {
      deferToHost(event, url)
      return
    }
    // _parent / _top / 具名 target：sandbox 里本来打不开，直接接管。
    takeOver(event, url)
  }

  function onClick(event) {
    onActivate(event, false)
  }

  function onAuxClick(event) {
    onActivate(event, true)
  }

  function installClickPatch() {
    if (clickInstalled) return
    try {
      document.addEventListener('click', onClick, true)
      document.addEventListener('auxclick', onAuxClick, true)
      clickInstalled = true
    } catch (e) { /* 文档不可用：保持惰性 */ }
  }

  function removeClickPatch() {
    if (!clickInstalled) return
    try {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('auxclick', onAuxClick, true)
    } catch (e) { /* 页面正在卸载：忽略 */ }
    clickInstalled = false
  }

  function onHostMessage(event) {
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || typeof data !== 'object' || data.source !== HOST_ID) return
    if (data.type === 'ack' && data.openExternal === true) {
      acked = true
      stopHello()
      installPatch()
      // externalLinks 缺省（旧宿主）按 false：点击桥保持惰性，不改变既有行为。
      linksEnabled = data.externalLinks === true
      if (linksEnabled) installClickPatch()
      else removeClickPatch()
    }
  }

  function apply(ctx) {
    function arm() {
      window.addEventListener('message', onHostMessage, false)
      startHello()
    }
    function disarm() {
      window.removeEventListener('message', onHostMessage, false)
      stopHello()
      removePatch()
      removeClickPatch()
    }
    if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { arm(); return disarm })
    else arm()
    // 供排障使用：控制台可查 __dshVscodeOpenExternal.acked() / .links()
    window.__dshVscodeOpenExternal = {
      version: PLUGIN_VERSION,
      acked: function () { return acked },
      links: function () { return linksEnabled }
    }
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })
