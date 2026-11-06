// dsh-webview-clipboard client bundle (ModuleLoader format)
//
// macOS + VS Code webview：DSH 页面以跨源 iframe 内嵌时，⌘C/⌘V/⌘X 的
// 原生剪贴板默认动作不会发生，复制/粘贴/剪切失效（Windows 正常）。
// 修复：拦截这三个键，preventDefault 后改用 document.execCommand 显式执行。
// 其余编辑快捷键原生可用，不做处理，避免与编辑器自身实现冲突。
// 仅在「被 Electron 内嵌 + macOS」时启用，其余环境行为不变。
//
// 全平台：DSH 的「复制」按钮走 navigator.clipboard.writeText，VS Code 权限策略
// 会拒绝内层跨源 iframe（microsoft/vscode#182642），按钮直接报失败且不回退。
// 这里包一层 writeText：原生 → 宿主 vscode.env.clipboard → textarea+execCommand。

window.__ModuleLoader__.load({ id: 'dsh-webview-clipboard', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var PLUGIN_VERSION = '0.3.0'

  function inIframe() {
    try { return window.parent !== window } catch (e) { return false }
  }

  function isMac() {
    var ua = navigator.userAgent || ''
    if (/Macintosh|Mac OS X/i.test(ua)) return true
    if (typeof navigator.platform === 'string' && /Mac/i.test(navigator.platform)) return true
    try {
      if (navigator.userAgentData && navigator.userAgentData.platform === 'macOS') return true
    } catch (e) { /* ignore */ }
    return false
  }

  function inElectron() {
    return /Electron\//.test(navigator.userAgent || '')
  }

  /** 是否启用兼容层。 */
  function enabled() {
    return inIframe() && isMac() && inElectron()
  }

  /** 事件目标是否为可编辑元素（paste 只对它们有意义）。 */
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false
    var tag = el.tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT') return true
    return el.isContentEditable === true
  }

  function onKeyDown(e) {
    if (e.defaultPrevented) return                 // 页面自身已处理，尊重之
    if (!enabled()) return
    if (e.isComposing || e.keyCode === 229) return // IME 组合中不干预
    var mod = e.metaKey || e.ctrlKey
    if (!mod || e.altKey || e.shiftKey) return     // 仅裸 ⌘/Ctrl + 字母
    var lower = String(e.key || '').toLowerCase()
    var cmd = null
    if (lower === 'v') cmd = 'paste'
    else if (lower === 'c') cmd = 'copy'
    else if (lower === 'x') cmd = 'cut'
    if (!cmd) return
    if (cmd === 'paste' && !isEditable(e.target)) return
    e.preventDefault()
    try {
      var ok = document.execCommand(cmd)
      if (!ok) console.warn('[dsh-webview-clipboard] execCommand("' + cmd + '") returned false')
    } catch (err) {
      console.warn('[dsh-webview-clipboard] execCommand("' + cmd + '") failed:', err)
    }
  }

  // ── 复制按钮回退（spec 007）───────────────────────────────────────────
  var HOST_ID = 'dsh-vscode-host'
  var SOURCE_ID = 'dsh-webview-clipboard'
  var HOST_TIMEOUT_MS = 1500
  var pending = Object.create(null)   // 无原型：回执 token 不会污染 Object.prototype
  var copySeq = 0
  var nativeWrite = null
  var clipboardRef = null
  var copyInstalled = false

  function makeToken() {
    copySeq += 1
    return 'c' + copySeq + '-' + Date.now()
  }

  /** 结算一次宿主写入；未知 token 直接忽略（页面伪造回执不能误伤其它请求）。 */
  function settleCopy(token, ok) {
    var entry = pending[token]
    if (!entry) return
    delete pending[token]
    try { clearTimeout(entry.timer) } catch (e) { /* ignore */ }
    if (ok) entry.resolve()
    else entry.reject(new Error('clipboard write failed'))
  }

  /** 经外层 webview 让扩展宿主用 vscode.env.clipboard.writeText 写入。 */
  function writeViaHost(text) {
    return new Promise(function (resolve, reject) {
      var token = makeToken()
      pending[token] = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () { settleCopy(token, false) }, HOST_TIMEOUT_MS)
      }
      try {
        // targetOrigin 用 '*'：插件不知道 webview 的 vscode-webview:// origin；
        // 外层只接受本 iframe + DSH origin 的消息（fromOurFrame 双校验）。
        window.parent.postMessage({ source: SOURCE_ID, type: 'clipboard-write', token: token, text: text }, '*')
      } catch (e) {
        settleCopy(token, false)
      }
    })
  }

  /** 兜底：textarea + execCommand（旧宿主不认识 clipboard-write 时仍能复制）。 */
  function execCopy(text) {
    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false
    var area = document.createElement('textarea')
    if (!area) return false
    var body = document.body
    var ok = false
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    area.style.top = '0'
    if (body && typeof body.appendChild === 'function') body.appendChild(area)
    try {
      if (typeof area.select === 'function') area.select()
      if (typeof area.setSelectionRange === 'function') area.setSelectionRange(0, text.length)
      ok = document.execCommand('copy') === true
    } catch (e) {
      ok = false
    } finally {
      if (area.parentNode && typeof area.parentNode.removeChild === 'function') area.parentNode.removeChild(area)
    }
    return ok
  }

  /** 包装后的 writeText：保持 Promise 语义；三层都失败才 reject。 */
  function writeText(text) {
    var value = text == null ? '' : String(text)
    var first
    if (nativeWrite) {
      try {
        first = Promise.resolve(nativeWrite.call(clipboardRef, value)).then(function () { return true }, function () { return false })
      } catch (e) {
        first = Promise.resolve(false)
      }
    } else {
      first = Promise.resolve(false)
    }
    return first.then(function (okFlag) {
      if (okFlag) return
      return writeViaHost(value).catch(function () {
        if (execCopy(value)) return
        throw new Error('clipboard write failed')
      })
    })
  }

  function onHostMessage(e) {
    var data = e && e.data
    if (!data || data.source !== HOST_ID || data.type !== 'clipboard-result') return
    if (typeof data.token !== 'string') return
    settleCopy(data.token, data.ok === true)
  }

  /** 只在被宿主 iframe 内嵌时接管；系统浏览器直开 DSH 行为不变。 */
  function installCopyFallback() {
    if (copyInstalled || !inIframe()) return
    var clip = null
    try { clip = navigator.clipboard } catch (e) { clip = null }
    if (!clip || typeof clip.writeText !== 'function') return
    clipboardRef = clip
    nativeWrite = clip.writeText
    try {
      clip.writeText = writeText
    } catch (e) {
      return   // 只读属性：放弃接管，保留原生行为
    }
    copyInstalled = true
    window.addEventListener('message', onHostMessage, false)
  }

  function apply() {
    installCopyFallback()
    window.addEventListener('keydown', onKeyDown, false)
    window.__dshWebviewClipboard = {
      version: PLUGIN_VERSION,
      enabled: enabled(),
      copyFallback: copyInstalled,
      mac: isMac(),
      electron: inElectron()
    }
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })

