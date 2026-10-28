// dsh-vscode-file-links client bundle (ModuleLoader format)
//
// 作用：DSH 对话里「工作区文件/文件夹链接」由宿主渲染成一个 <button>
// （className 含 CSS Modules 的 fileLink——0.2.1-rc.2 实测在 dsh-client-ui-tool 的
// 工具卡片里，title 为目标路径），点击时 DSH 自身会在右侧边栏打开该文件。
// 当 DSH 页面被 Deepseek-Harness-for-VS-Code 扩展以跨源 iframe 内嵌时，
// 我们希望这次点击改为「在 VS Code 资源管理器中定位并打开」。
//
// 链路：本插件捕获点击 → window.parent.postMessage → webview 中继 → 扩展宿主
//       → revealInExplorer / 打开文件（或变更 diff）→ 回执沿原路返回。
//
// diff 模式（规格 005）：宿主 ack 里带 `diff: true` 时，点击会额外带「会话 + 轮」
// 坐标（`change`），宿主据此在 VS Code 里打开该轮的并排 diff；取数超过默认超时时
// 宿主会先回 `reveal-ack`，本插件据此把等待放宽到 DIFF_WAIT_MS，避免超时回放导致
// 「diff 与 DSH 侧栏同时打开」。拿不到坐标就不带（宿主会退回 HEAD 对比）。
// 坐标提取有两条退路（2026-10-28 真机排查后加）：会话服务优先属性访问（真机客户端
// 上下文里 `ctx.get('uiSession')` 不一定解析得到）；轮次在自身祖先没有
// `data-chat-turn` 时，退而取文档中「前一个」带标记的行。
//
// 三条底线（安全 + 兼容）：
// 1. 只在宿主完成握手（ack）后接管；独立浏览器 / 其它宿主里完全不介入；
// 2. 只有宿主确认「能在当前 VS Code 工作区里打开」才吞掉这次点击；否则回放原始
//    点击，保持 DSH 自身行为（在 DSH 侧边栏打开）——绝不出现「点了没反应」；
// 3. 带修饰键（Ctrl/Cmd/Shift/Alt）的点击一律不接管，随时可强制走 DSH 行为。

window.__ModuleLoader__.load({ id: 'dsh-vscode-file-links', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var PLUGIN_VERSION = '0.2.5'
  // 父级 webview（VS Code 扩展）的身份标记：iframe name 属性 + 消息 source 字段。
  var HOST_ID = 'dsh-vscode-host'
  var SELF_ID = 'dsh-vscode-file-links'
  var HELLO_INTERVAL_MS = 400
  var HELLO_MAX_TRIES = 25
  var REVEAL_TIMEOUT_MS = 2500
  // 宿主回「已接单」（reveal-ack）后的等待上限，必须与扩展的 DIFF_TIMEOUT_MS 一致。
  var DIFF_WAIT_MS = 6000
  var PATH_MAX_LENGTH = 4096
  // DSH 会话流里的轮标记（每个消息节点外面那层）：取它才能定位「点击属于哪一轮」。
  var TURN_ATTR = 'data-chat-turn'
  var MAX_TURN = 1000000
  var MAX_SESSION_ID = 128
  // 形如 `_fileLink_<hash>` 的 CSS Modules 类名：哈希后缀随版本变化，
  // 因此按 token 里的局部名匹配，不绑定完整类名。
  var FILE_LINK_CLASS = 'fileLink'

  var acked = false
  var replaying = false
  var helloTimer = null
  var helloTries = 0
  // 宿主是否要轮级变更（diffAndOpen 模式）；老宿主不带该字段时为 false。
  var diffMode = false
  // 客户端根上下文：用于读「当前会话 id」（取不到就不带坐标，不阻断点击）。
  var rootCtx = null
  var pending = {}

  /** 是否被宿主内嵌（独立浏览器里 parent === self）。 */
  function inIframe() {
    try { return window.parent !== window } catch (e) { return false }
  }

  /** 父级是否为 VS Code 扩展的 webview（iframe name 标记，仅用于判断要不要打招呼）。 */
  function hostHinted() {
    try { return window.name === HOST_ID } catch (e) { return false }
  }

  /** 向父级（webview）发消息：附带自身身份标记。 */
  function postToHost(payload) {
    payload.source = SELF_ID
    payload.version = PLUGIN_VERSION
    try {
      // 目标 origin 无法从 iframe 内可靠得知（跨源），固定用户点击产生的路径本身
      // 也不敏感；宿主侧按 event.source + event.origin 双重校验，只认自己的 iframe。
      window.parent.postMessage(payload, '*')
    } catch (e) { /* 父级不可达：静默失败，行为回落到 DSH 自身 */ }
  }

  /** 停止握手重试。 */
  function stopHello() {
    if (helloTimer !== null) {
      window.clearInterval(helloTimer)
      helloTimer = null
    }
  }

  /** 周期性向宿主打招呼，直到拿到 ack（插件可能在 webview 就绪前后任意时刻加载）。 */
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

  /** 事件目标是否为 DSH 渲染的文件链接按钮（含点击落在内部图标/文字上的情形）。 */
  function fileLinkButtonOf(node) {
    if (!node || typeof node.closest !== 'function') return null
    var button = node.closest('button')
    if (!button) return null
    var cls = button.getAttribute('class') || ''
    var parts = cls.split(/\s+/)
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf(FILE_LINK_CLASS) >= 0) return button
    }
    return null
  }

  /** 友好的本地路径形状检查：排除 URL、多行文本、超长字符串。 */
  function looksLikePath(value) {
    if (typeof value !== 'string') return false
    var v = value.trim()
    if (v.length === 0 || v.length > PATH_MAX_LENGTH) return false
    if (v.indexOf('\n') >= 0 || v.indexOf('\r') >= 0 || v.indexOf('\u0000') >= 0) return false
    // 带 scheme 的 URL（http://、data: 等）不是本地路径；Windows 盘符 `C:\` 不受影响。
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false
    return true
  }

  /**
   * 取出链接目标路径：DSH 把路径写在 title 上；带图片预览的链接没有 title，
   * 退回到链接文字（模型书写的 Markdown label，通常就是同样的相对路径）。
   */
  function pathOfButton(button) {
    var title = button.getAttribute('title')
    if (typeof title === 'string' && looksLikePath(title)) return title.trim()
    var text = button.textContent || ''
    if (looksLikePath(text)) return text.trim()
    return ''
  }

  function nextToken() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }

  /**
   * 祖先里没有轮标记时的退路：取文档中「位于该链接之前」的最后一个带标记的行。
   * DSH 的行按轮顺序排列，链接若落在没有标记的包装层里，它逻辑上属于最近的
   * 前一个轮；只读页面上现成的标记（spec 005 第 9 节），不改 DOM。
   * @param {Node} node
   * @returns {number} 轮次；取不到返回 0
   */
  function nearestTurnBefore(node) {
    if (!document || typeof document.querySelectorAll !== 'function') return 0
    if (!node || typeof node.compareDocumentPosition !== 'function') return 0
    var rows
    try {
      rows = document.querySelectorAll('[' + TURN_ATTR + ']')
    } catch (e) { return 0 }
    var best = 0
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i]
      if (!row || row === node) continue
      var rel = 0
      try {
        rel = node.compareDocumentPosition(row)
      } catch (e2) { return 0 }
      // 4 = DOCUMENT_POSITION_FOLLOWING：后面的行不属于本次点击，且行序单调，可提前停。
      if (rel & 4) break
      // 2 = DOCUMENT_POSITION_PRECEDING：取最后一个前序标记行。
      if (rel & 2) {
        var rowRaw = row.getAttribute ? row.getAttribute(TURN_ATTR) : null
        if (typeof rowRaw === 'string' && /^\d+$/.test(rowRaw)) {
          var rowTurn = parseInt(rowRaw, 10)
          if (rowTurn >= 1 && rowTurn <= MAX_TURN) best = rowTurn
        }
      }
    }
    return best
  }

  /**
   * 点击所属轮：向上找带轮标记的元素（DSH 每条消息外面那层有 data-chat-turn）；
   * 自身祖先没有时，退而取文档中前一个带标记的行（链接落在无标记包装层里的情形）。
   * 都找不到就不带坐标（宿主退回 HEAD 对比），不阻断点击。
   */
  function turnOf(node) {
    var el = node
    var guard = 0
    while (el && el.nodeType === 1 && guard < 64) {
      guard += 1
      var raw = el.getAttribute ? el.getAttribute(TURN_ATTR) : null
      if (typeof raw === 'string' && /^\d+$/.test(raw)) {
        var turn = parseInt(raw, 10)
        if (turn >= 1 && turn <= MAX_TURN) return turn
      }
      el = el.parentElement
    }
    return nearestTurnBefore(node)
  }

  /**
   * 取客户端上下文里的服务：优先属性访问（真机客户端上下文里 `ctx.get('uiSession')`
   * 不一定解析得到——dsh 自家客户端插件取这两个服务一律用属性），再退回 `ctx.get`。
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
   * 当前主视图会话 id（DSH 会话流按主视图保留计数标出当前会话）。
   * 取不到返回空串：宁可退回 HEAD 对比，也不能猜错会话。
   */
  function currentSessionId() {
    if (!rootCtx) return ''
    try {
      var ui = serviceOf('uiSession')
      if (ui && ui.current) {
        var snap = typeof ui.current.getSnapshot === 'function' ? ui.current.getSnapshot() : ui.current.value
        var key = snap && (snap.key || snap.sessionId || (snap.binding && snap.binding.sessionId))
        if (typeof key === 'string' && key !== '' && key.length <= MAX_SESSION_ID) return key
      }
    } catch (e) { /* 老版本没有该服务 */ }
    try {
      var sessions = serviceOf('sessions')
      var list = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null
      var byId = list && list.byId
      if (byId) {
        for (var id in byId) {
          if (!Object.prototype.hasOwnProperty.call(byId, id)) continue
          var row = byId[id]
          if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0 && id.length <= MAX_SESSION_ID) return id
        }
      }
    } catch (e2) { /* 取不到就不带 */ }
    return ''
  }
  
  /** diff 模式下的轮坐标：会话或轮任一缺失就返回 null。 */
  function coordsOf(button) {
    if (!diffMode) return null
    var turn = turnOf(button)
    if (turn === 0) return null
    var sessionId = currentSessionId()
    if (sessionId === '') return null
    return { sessionId: sessionId, turn: turn }
  }
  
  /**
   * 回放原始点击：宿主不能处理（不在工作区内 / 面板未接管）时，让 DSH 自己把文 件
   * 打开在 DSH 侧边栏，保持既有行为。click() 是同步派发，用 replaying 标记避免
   * 再次被本插件捕获。
   */
  function replayClick(button) {
    if (!button || typeof button.click !== 'function') return
    replaying = true
    try {
      button.click()
    } catch (e) { /* 按钮已卸载等情况：忽略 */ }
    replaying = false
  }
  
  function requestReveal(button, path, change) {
    var token = nextToken()
    pending[token] = {
      el: button,
      // 宿主取轮级数据可能比默认超时慢：收到 reveal-ack 后才把等待放宽。
      timer: window.setTimeout(function () {
        delete pending[token]
        // 宿主没回执（面板关闭 / 扩展未升级）：回放点击，行为退回 DSH 自身。
        replayClick(button)
      }, REVEAL_TIMEOUT_MS)
    }
    var message = { type: 'reveal', token: token, path: path }
    if (change) message.change = change
    postToHost(message)
  }
  
  /** 宿主已接单（开始取数）：把这一次的等待放宽到 DIFF_WAIT_MS，避免超时双开。 */
  function extendWait(token) {
    var entry = pending[token]
    if (!entry || entry.extended) return
    entry.extended = true
    window.clearTimeout(entry.timer)
    entry.timer = window.setTimeout(function () {
      delete pending[token]
      replayClick(entry.el)
    }, DIFF_WAIT_MS)
  }
  
  function onClickCapture(event) {
    if (!acked || replaying) return
    if (event.defaultPrevented) return
    // 修饰键点击 = 用户明确要求走 DSH 自身行为（在 DSH 侧边栏打开）。
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    var button = fileLinkButtonOf(event.target)
    if (!button) return
    var path = pathOfButton(button)
    if (path === '') return
    // 先吞掉这次点击（阻止 React 的委托 handler 调用 DSH 的 openFile），
    // 再由宿主回执决定是否回放；其它 DOM 监听器不受影响。
    event.preventDefault()
    event.stopPropagation()
    requestReveal(button, path, coordsOf(button))
  }
  
  function onHostMessage(event) {
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || typeof data !== 'object' || data.source !== HOST_ID) return
    if (data.type === 'ack') {
      // 宿主用同一个 `ack` 类型发两种回执：文件链接的（带 fileLinks/mode/diff）与
      // 侧栏布局测量的（只有 layout:true）。必须分开——布局那条没有 diff 字段，若走
      // 同一分支会把 diffMode 覆盖成 false，之后所有点击都不带轮坐标
      // （真机踩坑：这就是「点击只开原文、从不出现轮级 diff」的根因）。
      var layoutOnly = data.layout === true && data.fileLinks === undefined
        && data.mode === undefined && data.diff === undefined
      if (layoutOnly) return
      // 宿主明确声明「已启用接管」；fileLinks 缺省视为启用（老宿主不带该字段） 。
      if (data.fileLinks === false) { stopHello(); return }
      acked = true
      // 只有宿主明确声明才发轮坐标（老宿主不认识 change 字段）。
      diffMode = data.diff === true
      stopHello()
      return
    }
    if (data.type === 'reveal-ack' && typeof data.token === 'string') {
      extendWait(data.token)
      return
    }
    if (data.type === 'reveal-result' && typeof data.token === 'string') {
      var entry = pending[data.token]
      if (!entry) return
      delete pending[data.token]
      window.clearTimeout(entry.timer)
      if (data.ok !== true) replayClick(entry.el)
    }
  }
  
  function apply(ctx) {
    rootCtx = ctx || null
    function arm() {
      document.addEventListener('click', onClickCapture, true)
      window.addEventListener('message', onHostMessage, false)
      startHello()
    }
    function disarm() {
      document.removeEventListener('click', onClickCapture, true)
      window.removeEventListener('message', onHostMessage, false)
      stopHello()
      for (var token in pending) {
        if (Object.prototype.hasOwnProperty.call(pending, token)) {
          window.clearTimeout(pending[token].timer)
        }
      }
      pending = {}
    }
    if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { arm(); return disarm })
    else arm()
    // 供排障使用：控制台可查 __dshVscodeFileLinks.acked() / .diffMode
    window.__dshVscodeFileLinks = {
      version: PLUGIN_VERSION,
      hostHint: hostHinted(),
      diffMode: function () { return diffMode },
      acked: function () { return acked }
    }
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })
