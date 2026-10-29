// dsh-vscode-keys client bundle (ModuleLoader format)
//
// 作用：DSH 页面被 Deepseek-Harness-for-VS-Code 扩展以跨源 iframe 内嵌时，
// 焦点在页面里按下的「工作台级快捷键」不会冒泡到 VS Code（跨源 iframe 的 keydown
// 只派发给自己的 document），因此 Ctrl/Cmd+Shift+P、Ctrl/Cmd+P 等在面板内全部失效。
//
// 链路：本插件捕获命中转发表的按键 → window.parent（webview 中继）→ 扩展宿主
//       vscode.commands.executeCommand(...) → VS Code 侧执行。
//
// 四条底线（与 dsh-vscode-file-links 一致）：
// 1. 只在宿主下发 keys-ack 后接管；独立浏览器 / 其它宿主里完全不介入；
// 2. **DSH 优先**：按键组合若出现在 DSH 的快捷键目录（catalog / fixedCatalog）里，
//    一律不拦截、不 preventDefault，交给 DSH 自己处理；目录随用户改绑实时刷新；
// 3. 只按宿主下发的表命中，且只上报「物理键事实」——命令 id 由宿主按自己的表查，
//    页面无法让宿主执行任意命令；
// 4. 不做 DOM 写入、不拦点击；任何异常都退化为「不拦截」，页面行为保持原样。

window.__ModuleLoader__.load({ id: 'dsh-vscode-keys', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var PLUGIN_VERSION = '0.2.1'
  var HOST_ID = 'dsh-vscode-host'
  var SELF_ID = 'dsh-vscode-keys'
  var HELLO_INTERVAL_MS = 400
  var HELLO_MAX_TRIES = 25
  // 物理键 code 的形状（KeyP / Backquote / Digit1 / F6 …）。
  var CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,15}$/
  // 让位清单上限：只用于诊断展示，不参与转发判定。
  var SHADOW_MAX = 32

  var rootCtx = null
  var acked = false
  // 宿主下发的转发表：签名 → true（只用于命中判断，不含命令 id）。
  var table = null
  // 焦点交还键的签名（空 = 不启用）。
  var releaseKey = null
  var helloTimer = null
  var helloTries = 0
  // DSH 快捷键目录索引：签名 → 命令 id。
  var dshIndex = null
  var dshIndexSubs = []
  var degraded = false
  // 诊断用：最近一次读到的目录规模（0 = 快照为空或不可读）。
  var catalogRows = 0
  var fixedRows = 0
  // 诊断用：最近一次读到的原始目录快照（不参与命中判定）。
  var dshCatalog = null

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

  function stopHello() {
    if (helloTimer !== null) {
      window.clearInterval(helloTimer)
      helloTimer = null
    }
  }

  /** 周期打招呼，直到拿到转发表（插件可能在 webview 就绪前后任意时刻加载）。 */
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

  /** 物理键 + 修饰键 → 签名（与宿主 `gestureSignature` 完全一致）。 */
  function signatureOf(code, ctrl, meta, alt, shift) {
    return code + '|' + (ctrl ? 1 : 0) + '|' + (meta ? 1 : 0) + '|' + (alt ? 1 : 0) + '|' + (shift ? 1 : 0)
  }

  /** DSH 归一化绑定 → 签名（DSH 的 modifiers 已展开 primary 为 control/meta）。 */
  function bindingSignature(binding) {
    if (!binding || typeof binding !== 'object') return ''
    var code = typeof binding.code === 'string' ? binding.code : ''
    if (!CODE_RE.test(code)) return ''
    var mods = Array.isArray(binding.modifiers) ? binding.modifiers : []
    function has(name) {
      for (var i = 0; i < mods.length; i++) {
        if (mods[i] === name) return true
      }
      return false
    }
    return signatureOf(code, has('control'), has('meta'), has('alt'), has('shift'))
  }

  function clearIndexSubs() {
    for (var i = 0; i < dshIndexSubs.length; i++) {
      try { dshIndexSubs[i]() } catch (e) { /* 已失效的订阅：忽略 */ }
    }
    dshIndexSubs = []
  }

  /**
   * 重建 DSH 键位索引（catalog 可编辑绑定 + fixedCatalog 固定动作）。
   * 服务缺失 / 快照形态不符时置 degraded（宿主据此给一次性可见提示），
   * 但仍然按宿主的表转发——绝不因为读不到目录就让快捷键彻底失效。
   */
  function refreshDshIndex() {
    var svc = serviceOf('shortcuts')
    if (!svc) {
      dshIndex = null
      degraded = true
      return
    }
    var catalog = null
    try {
      catalog = svc.catalog && typeof svc.catalog.getSnapshot === 'function' ? svc.catalog.getSnapshot() : null
    } catch (e) { catalog = null }
    if (!Array.isArray(catalog)) {
      dshIndex = null
      degraded = true
      return
    }
    var index = Object.create(null)
    function addBinding(binding, id) {
      var sig = bindingSignature(binding)
      if (sig !== '' && index[sig] === undefined) index[sig] = String(id)
    }
    catalogRows = catalog.length
    dshCatalog = catalog
    for (var i = 0; i < catalog.length; i++) {
      var row = catalog[i]
      if (row && row.binding) addBinding(row.binding, row.id)
    }
    var fixed = null
    try {
      fixed = svc.fixedCatalog && typeof svc.fixedCatalog.getSnapshot === 'function' ? svc.fixedCatalog.getSnapshot() : null
    } catch (e2) { fixed = null }
    fixedRows = Array.isArray(fixed) ? fixed.length : 0
    if (Array.isArray(fixed)) {
      for (var j = 0; j < fixed.length; j++) {
        var frow = fixed[j]
        if (!frow || !Array.isArray(frow.bindings)) continue
        for (var k = 0; k < frow.bindings.length; k++) addBinding(frow.bindings[k], frow.id)
      }
    }
    dshIndex = index
    degraded = false
    // 用户改绑 DSH 键位 / 插件装载新命令后，让位判定与诊断清单立即跟随（无需重启）。
    clearIndexSubs()
    var onCatalogChange = function () { refreshDshIndex(); publishStatus() }
    try {
      if (svc.catalog && typeof svc.catalog.subscribe === 'function') {
        dshIndexSubs.push(svc.catalog.subscribe(onCatalogChange))
      }
      if (svc.fixedCatalog && typeof svc.fixedCatalog.subscribe === 'function') {
        dshIndexSubs.push(svc.fixedCatalog.subscribe(onCatalogChange))
      }
    } catch (e3) { /* 订阅不可用：只在握手/配置变更时刷新 */ }
  }

  /** 本次按下的组合是否被 DSH 占用；返回 DSH 命令 id 或空串。 */
  function dshOwner(sig) {
    if (!dshIndex) return ''
    var id = dshIndex[sig]
    return typeof id === 'string' ? id : ''
  }

  /** 让位清单（诊断用）：转发表里被 DSH 占用的组合。 */
  function shadowedList() {
    var out = []
    if (!table || !dshIndex) return out
    for (var sig in table) {
      if (!Object.prototype.hasOwnProperty.call(table, sig)) continue
      var owner = dshOwner(sig)
      if (owner !== '' && out.length < SHADOW_MAX) out.push({ sig: sig, command: owner })
    }
    return out
  }

  /** 回报运行状态：宿主据此在 keyStatus 里展示降级/让位，并给一次性提示。 */
  function publishStatus() {
    if (!acked) return
    var shadowed = shadowedList()
    postToHost({
      type: 'keys-status',
      degraded: degraded,
      active: table ? Object.keys(table).length : 0,
      shadowed: shadowed
    })
  }

  function onHostMessage(event) {
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || typeof data !== 'object' || data.source !== HOST_ID) return
    if (data.type !== 'keys-ack') return
    var next = data.table && typeof data.table === 'object' ? data.table : {}
    acked = true
    stopHello()
    table = next
    releaseKey = typeof data.releaseKey === 'string' && data.releaseKey !== '' ? data.releaseKey : null
    refreshDshIndex()
    publishStatus()
  }

  /** 是否打开了 DSH 的弹窗（含快捷键设置的「按键录制」）。弹窗内不接管键盘。 */
  function modalOpen() {
    try {
      if (typeof document === 'undefined' || !document.querySelector) return false
      return document.querySelector('[aria-modal="true"]') !== null
    } catch (e) { return false }
  }

  /** 捕获阶段之外（冒泡）监听：让 DSH 自己的监听器先有机会消费，我们只在剩余情况里接管。 */
  function onKeyDown(event) {
    if (!acked || !table) return
    if (event.isComposing || event.keyCode === 229) return   // IME 组合中不干预
    if (event.repeat) return                                 // 长按不重复触发
    if (event.defaultPrevented) return                       // 页面自己已处理，尊重之
    if (modalOpen()) return                                  // 弹窗（如 DSH 的按键录制）内不抢键
    var code = typeof event.code === 'string' ? event.code : ''
    if (!CODE_RE.test(code)) return
    var sig = signatureOf(code, event.ctrlKey, event.metaKey, event.altKey, event.shiftKey)
    if (releaseKey !== null && sig === releaseKey) {
      // 焦点交还：交出去之后按键才会由 workbench 处理（含 chord 与自定义键位）。
      event.preventDefault()
      event.stopPropagation()
      postToHost({ type: 'focus-release' })
      return
    }
    if (!Object.prototype.hasOwnProperty.call(table, sig)) return
    if (dshOwner(sig) !== '') return                         // DSH 优先：不拦、不 preventDefault
    event.preventDefault()
    event.stopPropagation()
    postToHost({
      type: 'key',
      // 只上报物理键事实；命令 id 由宿主按自己的表查（页面无法指定任意命令）。
      gesture: {
        code: code,
        ctrl: !!event.ctrlKey,
        meta: !!event.metaKey,
        alt: !!event.altKey,
        shift: !!event.shiftKey
      }
    })
  }

  function apply(ctx) {
    rootCtx = ctx || null
    function arm() {
      if (!inIframe()) return   // 独立浏览器：完全不介入，也不打招呼
      window.addEventListener('message', onHostMessage, false)
      window.addEventListener('keydown', onKeyDown, false)
      startHello()
    }
    function disarm() {
      window.removeEventListener('message', onHostMessage, false)
      window.removeEventListener('keydown', onKeyDown, false)
      stopHello()
      clearIndexSubs()
    }
    if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { arm(); return disarm })
    else arm()
    // 供排障使用：控制台可查 __dshVscodeKeys.status() / bindings() / owner(sig)
    window.__dshVscodeKeys = {
      version: PLUGIN_VERSION,
      status: function () {
        return {
          acked: acked,
          degraded: degraded,
          keys: table ? Object.keys(table).length : 0,
          releaseKey: releaseKey,
          catalogRows: catalogRows,
          fixedRows: fixedRows,
          dshBindings: dshIndex ? Object.keys(dshIndex).length : 0,
          shadowed: shadowedList()
        }
      },
      /** 强制重读 DSH 键位目录（排查「改绑后没让位」时手动刷一次）。 */
      refresh: function () { refreshDshIndex(); publishStatus(); return window.__dshVscodeKeys.status() },
      /** 我们当前认为被 DSH 占用的签名列表（形如 Comma|1|0|0|1）。 */
      bindings: function () { return dshIndex ? Object.keys(dshIndex).sort() : null },
      /** 查某个签名被哪个 DSH 命令占用；未占用返回空串。 */
      owner: function (sig) { return dshOwner(String(sig)) },
      /** DSH 目录里所有「有绑定」的行：用于确认某命令到底绑了什么键。 */
      rows: function () {
        var out = []
        if (!dshCatalog) return out
        for (var i = 0; i < dshCatalog.length; i++) {
          var row = dshCatalog[i]
          if (!row || !row.binding) continue
          out.push({
            id: String(row.id),
            binding: row.binding,
            keys: row.keys,
            modified: row.modified === true,
            issue: row.issue === undefined ? null : row.issue
          })
        }
        return out
      },
      /** DSH 持久化的键位偏好原文（localStorage `dsh.keybindings.v1`）。 */
      prefs: function () {
        try {
          return window.localStorage ? window.localStorage.getItem('dsh.keybindings.v1') : null
        } catch (e) { return null }
      }
    }
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })
