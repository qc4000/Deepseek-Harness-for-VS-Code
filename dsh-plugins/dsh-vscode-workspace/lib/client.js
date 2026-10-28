// dsh-vscode-workspace client bundle (ModuleLoader format)
//
// 作用：DSH Web GUI 的「当前工作区」由页面自己恢复（客户端持久选择 → 最近活跃工作区），
// 跟进程 cwd 无关；扩展虽然已把进程 cwd 设成 VS Code 文件夹、也调了 workspace/create
// 登记，但面板打开时仍可能停在别的项目上。本插件在页面侧把当前工作区切到宿主正在
// 打开的那个文件夹。
//
// 链路：本插件 hello → window.parent（webview 中继）→ 回 workspace-pin（带宿主路径）
//       → ctx.workspaces.create({ path })（幂等注册）→ ctx.uiWorkspace.openWorkspace(id)
//       → 回报 workspace-pin-result（done/already/unsupported/failed）→ 宿主按需提示。
//
// 三条底线（与 dsh-vscode-file-links 一致）：
// 1. 只在宿主握手后动作；独立浏览器 / 其它宿主里完全不介入；
// 2. 只用 DSH 公开客户端服务：不改 DOM、不注入样式、不拦交互、不写 localStorage；
// 3. 已在该工作区就什么都不做（不新建多余会话）；任何失败都回报宿主，绝不静默。

window.__ModuleLoader__.load({ id: 'dsh-vscode-workspace', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var PLUGIN_VERSION = '0.1.0'
  // 父级 webview（VS Code 扩展）的身份标记，与中继脚本里的 HOST_ID 一致。
  var HOST_ID = 'dsh-vscode-host'
  var SELF_ID = 'dsh-vscode-workspace'
  var HELLO_INTERVAL_MS = 400
  var HELLO_MAX_TRIES = 25
  // DSH 页面刚加载时工作区/会话快照还在 loading：等它就绪再判定，避免误判成「不在目标工作区」。
  var READY_POLL_MS = 200
  var READY_MAX_TRIES = 75
  var PATH_MAX_LENGTH = 4096
  var REASON_MAX_LENGTH = 200

  var rootCtx = null
  // 是否已收到宿主下发的目标路径（收到后就不再打招呼）。
  var asked = false
  // 是否已做出判定（成功/失败/不支持都算），保证只执行一次。
  var applied = false
  var helloTimer = null
  var helloTries = 0

  /** 是否被宿主内嵌（独立浏览器里 parent === self）。 */
  function inIframe() {
    try { return window.parent !== window } catch (e) { return false }
  }

  /** 向父级（webview）发消息：附带自身身份标记。 */
  function postToHost(payload) {
    payload.source = SELF_ID
    payload.version = PLUGIN_VERSION
    try {
      // 跨源下拿不到父级 origin；宿主侧按 event.source + event.origin 双重校验。
      window.parent.postMessage(payload, '*')
    } catch (e) { /* 父级不可达：静默失败，页面行为不变 */ }
  }

  /** 停止握手重试。 */
  function stopHello() {
    if (helloTimer !== null) {
      window.clearInterval(helloTimer)
      helloTimer = null
    }
  }

  /** 周期打招呼，直到拿到目标路径（插件可能在 webview 就绪前后任意时刻加载）。 */
  function startHello() {
    if (!inIframe() || asked || helloTimer !== null) return
    postToHost({ type: 'hello' })
    helloTries += 1
    if (helloTries >= HELLO_MAX_TRIES) return
    helloTimer = window.setInterval(function () {
      if (asked || helloTries >= HELLO_MAX_TRIES) { stopHello(); return }
      helloTries += 1
      postToHost({ type: 'hello' })
    }, HELLO_INTERVAL_MS)
  }

  /**
   * 取客户端上下文里的服务：优先属性访问（真机客户端上下文里 `ctx.get(name)`
   * 不一定解析得到——dsh 自家客户端插件取服务一律用属性），再退回 `ctx.get`。
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

  /** 友好的本地路径形状检查（与中继脚本的校验保持一致）。 */
  function looksLikePath(value) {
    if (typeof value !== 'string') return false
    var v = value.trim()
    if (v.length === 0 || v.length > PATH_MAX_LENGTH) return false
    if (/[\u0000-\u001f\u007f]/.test(v)) return false
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false
    return true
  }

  /** 取某服务的列表快照（服务缺失/未实现时返回 null）。 */
  function snapshotOf(service) {
    try {
      if (service && service.list && typeof service.list.getSnapshot === 'function') {
        return service.list.getSnapshot()
      }
    } catch (e) { /* 快照未就绪 */ }
    return null
  }

  /**
   * 当前主视图会话的 cwd：优先 uiSession.current（新版），再退回
   * `retainedBy.mainView`（DSH 用保留计数标出主视图会话）。
   * @returns {string} 取不到返回空串（宁可多切一次，也不猜错工作区）
   */
  function mainViewCwd(snap) {
    var byId = snap && snap.byId
    if (!byId) return ''
    try {
      var ui = serviceOf('uiSession')
      var current = ui && ui.current && typeof ui.current.getSnapshot === 'function' ? ui.current.getSnapshot() : null
      var key = current && (current.key || current.sessionId || (current.binding && current.binding.sessionId))
      if (typeof key === 'string' && byId[key] && typeof byId[key].cwd === 'string') return byId[key].cwd
    } catch (e) { /* 老版本没有该服务：走保留计数 */ }
    for (var id in byId) {
      if (!Object.prototype.hasOwnProperty.call(byId, id)) continue
      var row = byId[id]
      if (row && row.retainedBy && row.retainedBy.mainView > 0 && typeof row.cwd === 'string') return row.cwd
    }
    return ''
  }

  function messageOf(error) {
    if (!error) return '未知错误'
    var text = typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
    return text.slice(0, REASON_MAX_LENGTH)
  }

  /** 回报判定结果；宿主据此决定是否给用户提示。 */
  function report(status, reason) {
    var payload = { type: 'workspace-pin-result', status: status }
    if (reason !== undefined) payload.reason = String(reason).slice(0, REASON_MAX_LENGTH)
    postToHost(payload)
  }

  /**
   * 等 workspaces/sessions 两路快照就绪后再判定：否则 DSH 还在 loading 时
   * 主视图 cwd 必然取不到，会误判成「不在目标工作区」而多开一个会话。
   */
  function waitReady(target, tries) {
    if (applied) return
    var workspaces = serviceOf('workspaces')
    var sessions = serviceOf('sessions')
    var wsnap = snapshotOf(workspaces)
    var ssnap = snapshotOf(sessions)
    var ready = wsnap !== null && ssnap !== null && wsnap.phase === 'ready' && ssnap.phase === 'ready'
    if (!ready) {
      if (tries >= READY_MAX_TRIES) {
        applied = true
        report('failed', '等待 DSH 工作区列表就绪超时')
        return
      }
      window.setTimeout(function () { waitReady(target, tries + 1) }, READY_POLL_MS)
      return
    }

    applied = true
    // 已经在这个工作区：什么都不做（AC-2），连注册都省掉。
    if (mainViewCwd(ssnap) === target) {
      report('already')
      return
    }

    var ui = serviceOf('uiWorkspace')
    Promise.resolve()
      .then(function () { return workspaces.create({ path: target }) })
      .then(function (value) {
        // 只认 { workspaceId } 的对象形态；字符串/空值一律当作契约不符。
        var id = value && (value.workspaceId || (value.workspace && value.workspace.workspaceId))
        if (typeof id !== 'string' || id === '') throw new Error('workspace/create 未返回 workspaceId')
        return Promise.resolve(ui.openWorkspace(id))
      })
      .then(function () { report('done') })
      .catch(function (error) { report('failed', messageOf(error)) })
  }

  /** 收到宿主下发的目标路径：先校验服务契约，再进入等待就绪的流程。 */
  function pin(target) {
    if (applied) return
    var workspaces = serviceOf('workspaces')
    var ui = serviceOf('uiWorkspace')
    var sessions = serviceOf('sessions')
    var capable = workspaces && typeof workspaces.create === 'function' && workspaces.list
      && ui && typeof ui.openWorkspace === 'function'
      && sessions && sessions.list
    if (!capable) {
      // 旧版 dsh 没有这两个客户端服务：明确上报，宿主据此提示「请手动选择」。
      applied = true
      report('unsupported')
      return
    }
    waitReady(target, 0)
  }

  function onHostMessage(event) {
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || typeof data !== 'object' || data.source !== HOST_ID) return
    if (data.type !== 'workspace-pin') return
    if (asked || applied) return
    if (!looksLikePath(data.path)) return
    asked = true
    stopHello()
    pin(String(data.path).trim())
  }

  function apply(ctx) {
    rootCtx = ctx || null
    function arm() {
      window.addEventListener('message', onHostMessage, false)
      startHello()
    }
    function disarm() {
      window.removeEventListener('message', onHostMessage, false)
      stopHello()
    }
    if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { arm(); return disarm })
    else arm()
    // 供排障使用：控制台可查 __dshVscodeWorkspace.applied()
    window.__dshVscodeWorkspace = {
      version: PLUGIN_VERSION,
      watched: function () { return asked },
      applied: function () { return applied }
    }
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })
