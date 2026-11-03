'use strict';
/**
 * 内置插件 dsh-vscode-open-external 的回归测试（插件 0.2.0 / 外链设置）。
 * 运行：node test/open-external-plugin.test.js
 *
 * 背景：DSH 的「登录 DeepSeek 账号」由客户端 `BrowserLogin` 驱动：
 *   window.open('about:blank') 预开页 → 拿到 Host 授权链接后 popup.location.replace(url)。
 * 面板把 DSH 以跨源 iframe 内嵌进 VS Code webview，而 webview 不允许新开窗口
 * （window.open 返回 null），于是登录页永远不出现——Remote-WSL / Remote-SSH 里
 * 远端又没有图形浏览器，用户无法登录。
 *
 * 修复（0.1.0）：内置插件接管 window.open（只在宿主握手后），把 http(s) 链接经 webview
 * 中继交给扩展宿主 `vscode.env.openExternal`，在**客户端**（如 Windows）浏览器打开；
 * about:blank 预开页返回可导航的桩对象，把后续 replace/assign/href 的跳转目标转交宿主。
 *
 * 扩展（0.2.0）：`<a target="_blank">` / 修饰键 / 中键不经过 window.open，webview 的
 * sandbox 又没有 allow-popups，所以它们点了没反应。插件在 capture 阶段补一层 click /
 * auxclick 桥：只转交「新窗口 / 新标签」意图，DSH 自己 preventDefault 的点击仍归 DSH；
 * `target="_self"`（含没写 target）一律不碰。
 *
 * 覆盖：
 *  1) 插件文件完整性与声明（package.json / cordis.patch.yml / 宿主半身）
 *  2) 客户端逻辑：握手前不接管；ack 后 about:blank 桩对象 + 链接转交 + 非法输入回退
 *  3) webview 中继：ack 携带 openExternal/externalLinks、open 消息转发、边界校验、off 模式仍可登录
 *  4) 扩展宿主：dsh-open-link 只放行 http(s)，调用 vscode.env.openExternal
 *  5) click / auxclick 桥：意图判定、DSH 已接管时让位、去重、关闭开关
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Module = require('module');
const os = require('os');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

// ── vscode 桩（宿主侧）──
const openedExternal = [];
const configValues = {};
const vscodeStub = {
  FileType: { File: 1, Directory: 2 },
  Uri: {
    file: (p) => ({ scheme: 'file', fsPath: path.resolve(p), toString: () => 'file://' + p }),
    joinPath: (base, ...segs) => vscodeStub.Uri.file(path.resolve(base.fsPath, ...segs)),
    parse: (u) => ({ toString: () => u, _url: u })
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (k, d) => (Object.prototype.hasOwnProperty.call(configValues, k) ? configValues[k] : d)
    }),
    fs: { stat: async () => ({ type: 1 }) }
  },
  env: {
    remoteName: undefined,
    openExternal: (uri) => { openedExternal.push(String(uri)); return Promise.resolve(true); },
    asExternalUri: async (uri) => uri
  },
  window: { setStatusBarMessage: () => ({ dispose() {} }), showInformationMessage: () => {}, showErrorMessage: () => {}, showWarningMessage: () => {} },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-open-ext-home-'));
const realHomedir = os.homedir;
os.homedir = () => tmpHome;

const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

const DSH_ORIGIN = 'http://127.0.0.1:3080';
const PLUGIN_SRC_FILE = path.join(__dirname, '..', 'dsh-plugins', 'dsh-vscode-open-external', 'lib', 'client.js');

/** 把插件 client.js 装进一个 vm「DSH 页面域」。 */
function makePageRealm(options = {}) {
  const parentMessages = [];
  const winListeners = [];
  const docListeners = [];
  const intervals = new Map();
  let seq = 1;
  const nativeOpenCalls = [];
  const parent = { postMessage: (payload, origin) => parentMessages.push({ payload, origin }) };

  const doc = {
    addEventListener: (type, fn, capture) => { docListeners.push({ type, fn, capture: !!capture }); },
    removeEventListener: (type, fn, capture) => {
      for (let i = docListeners.length - 1; i >= 0; i -= 1) {
        const l = docListeners[i];
        if (l.type === type && l.fn === fn && l.capture === !!capture) docListeners.splice(i, 1);
      }
    }
  };
  // 页面默认的 DSH 源：同源链接必须被插件跳过。
  const location = { href: DSH_ORIGIN + '/', origin: DSH_ORIGIN };
  const win = {
    parent,
    location,
    navigator: {
      userAgent: options.userAgent
        || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
    },
    addEventListener: (type, fn) => { winListeners.push({ type, fn }); },
    removeEventListener: (type, fn) => {
      for (let i = winListeners.length - 1; i >= 0; i -= 1) {
        if (winListeners[i].type === type && winListeners[i].fn === fn) winListeners.splice(i, 1);
      }
    },
    setInterval: (fn, ms) => { const id = seq++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { fn(); return 0; },
    open: (...args) => { nativeOpenCalls.push(args); return { native: true }; }
  };
  const modules = [];
  win.__ModuleLoader__ = { load: (def) => modules.push(def) };
  const sandbox = { window: win, document: doc, console, setTimeout: win.setTimeout, URL };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PLUGIN_SRC_FILE, 'utf8'), sandbox, { filename: 'open-external-client.js' });

  const disposers = [];
  const applyPlugin = () => {
    const module = { exports: {} };
    const factory = modules[0].factory;
    const out = factory(() => ({}));
    const exportsObj = out || module.exports;
    exportsObj.apply({ effect: (fn) => { disposers.push(fn()); } });
    return exportsObj;
  };
  return {
    win,
    parentMessages,
    nativeOpenCalls,
    docListeners,
    moduleId: modules[0] && modules[0].id,
    applyPlugin,
    disposers,
    /** 触发 document 上的 click / auxclick 监听（capture 顺序由插入顺序决定）。 */
    fire: (type, event) => docListeners.filter((l) => l.type === type).forEach((l) => l.fn(event)),
    /** 模拟宿主 → 页面消息。 */
    fromHost: (data, overrides = {}) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data,
      source: overrides.source === undefined ? parent : overrides.source
    })),
    runIntervals: () => { for (const v of intervals.values()) v.fn(); }
  };
}

/** 最小 <a> 桩：插件只用到 tagName / nodeType / getAttribute / hasAttribute / parentNode。 */
function makeAnchor(attrs) {
  return {
    nodeType: 1,
    tagName: 'A',
    attrs: Object.assign({}, attrs),
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    parentNode: null
  };
}

/** 最小点击事件桩（可模拟 DSH 在 capture 之后 preventDefault / stopPropagation）。 */
function makeClickEvent(anchor, options = {}) {
  return {
    type: options.type || 'click',
    button: options.button === undefined ? 0 : options.button,
    ctrlKey: !!options.ctrlKey,
    metaKey: !!options.metaKey,
    shiftKey: !!options.shiftKey,
    altKey: !!options.altKey,
    isTrusted: options.isTrusted === undefined ? true : options.isTrusted,
    defaultPrevented: false,
    propagationStopped: false,
    target: anchor,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    composedPath() { return [anchor]; }
  };
}

/** profile 里已经落盘的 open 消息（不含 hello）。 */
function openMessages(realm) {
  return realm.parentMessages.filter((m) => m.payload.type === 'open');
}

(async function run() {
  console.log('[1] 内置插件文件与声明');
  {
    const files = I.openExternalPluginFiles();
    ok(Object.keys(files).length === 4, '包含 package.json / cordis.patch.yml / lib/index.js / lib/client.js');
    const pkg = JSON.parse(files['package.json']);
    ok(pkg.name === 'dsh-vscode-open-external', 'package.json name 正确');
    ok(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', 'dsh.client.platform = web（浏览器侧插件）');
    ok(pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', '声明 bundle patch 文件');
    ok(/id:\s*vscode-open-external/.test(files['cordis.patch.yml']) && /name:\s*'dsh-vscode-open-external'/.test(files['cordis.patch.yml']), 'cordis.patch.yml 注册行完整');
    ok(/export const name = 'dsh-vscode-open-external'/.test(files['lib/index.js']), '宿主半身导出 name 与包名一致');
    ok(I.OPEN_EXTERNAL_PLUGIN_NAME === 'dsh-vscode-open-external' && I.OPEN_EXTERNAL_PLUGIN_SOURCE === I.OPEN_EXTERNAL_PLUGIN_NAME, '扩展侧常量与插件名一致');
    ok(/__ModuleLoader__\.load\(\{\s*id:\s*'dsh-vscode-open-external'/.test(files['lib/client.js']), 'client bundle 使用 ModuleLoader 格式且 id 正确');
  }

  console.log('[2] 客户端逻辑：握手前不接管');
  {
    const realm = makePageRealm();
    ok(realm.moduleId === 'dsh-vscode-open-external', '注册的模块 id 正确');
    realm.applyPlugin();
    ok(realm.parentMessages.some((m) => m.payload.type === 'hello' && m.payload.source === 'dsh-vscode-open-external'), '加载后向宿主打招呼（hello）');
    realm.win.open('https://example.com/a', '_blank');
    ok(realm.nativeOpenCalls.length === 1 && realm.nativeOpenCalls[0][0] === 'https://example.com/a', '未 ack 前 window.open 走原生实现（不接管）');
  }

  console.log('[3] 客户端逻辑：ack 后接管 about:blank 预开页与 http(s) 链接');
  {
    const realm = makePageRealm();
    realm.applyPlugin();
    realm.fromHost({ source: 'dsh-vscode-host', type: 'ack', openExternal: true, fileLinks: true });
    ok(realm.win.__dshVscodeOpenExternal.acked() === true, 'ack 后进入接管状态');

    // DSH BrowserLogin：先 window.open('about:blank') 预开页
    const popup = realm.win.open('about:blank', '_blank');
    ok(popup && popup.closed === false, 'about:blank 返回可用的桩对象（closed=false）');
    popup.opener = null;
    ok(popup.opener === null, 'opener 可被置空（DSH 会做这一步）');
    ok(typeof popup.location.replace === 'function' && typeof popup.close === 'function', '桩对象提供 location.replace 与 close');

    // 拿到授权链接后 replace → 应转交宿主用系统浏览器打开
    popup.location.replace('https://platform.deepseek.com/authorize?state=abc&client_id=dsh');
    const opens = realm.parentMessages.filter((m) => m.payload.type === 'open');
    ok(opens.length === 1 && opens[0].payload.url === 'https://platform.deepseek.com/authorize?state=abc&client_id=dsh', 'location.replace 的授权链接转交宿主');
    ok(opens[0].payload.source === 'dsh-vscode-open-external', '转交消息带插件身份标记');
    ok(opens[0].payload.kind === 'login', 'about:blank 桩导航标记 kind=login（登录固定系统浏览器）');

    // href 赋值 / assign 同样转交
    popup.location.href = 'https://platform.deepseek.com/authorize?state=def';
    ok(realm.parentMessages.filter((m) => m.payload.type === 'open').length === 2, 'location.href 赋值同样转交');
    popup.close();
    ok(popup.closed === true, 'close() 后 closed=true（DSH 成功路径会关闭预开页）');

    // 直接 window.open(http 链接)：转交并返回 null（等价于弹出被拦截）
    const ret = realm.win.open('https://platform.deepseek.com/account', '_blank', 'noopener');
    ok(ret === null, '直接打开 http(s) 链接返回 null（不再依赖 webview 弹窗）');
    ok(realm.parentMessages.filter((m) => m.payload.type === 'open').length === 3, '直接打开 http(s) 链接也转交宿主');
    ok(realm.parentMessages.filter((m) => m.payload.type === 'open')[2].payload.kind === 'popup', '直接 window.open 标记 kind=popup');
  }

  console.log('[4] 客户端逻辑：非法输入回退原生行为');
  {
    const realm = makePageRealm();
    realm.applyPlugin();
    realm.fromHost({ source: 'dsh-vscode-host', type: 'ack', openExternal: true });
    realm.win.open('mailto:a@b.com');
    ok(realm.nativeOpenCalls.length === 1 && realm.nativeOpenCalls[0][0] === 'mailto:a@b.com', '非 http(s) scheme 回退原生');
    realm.win.open('javascript:alert(1)');
    ok(realm.nativeOpenCalls.length === 2, 'javascript: 回退原生（不转交宿主）');
    realm.win.open('https://example.com/' + 'x'.repeat(9000));
    ok(realm.nativeOpenCalls.length === 3, '超长链接回退原生');
    ok(realm.parentMessages.filter((m) => m.payload.type === 'open').length === 0, '以上均未转交宿主');
    // 非本宿主来源的 ack 不认
    const realm2 = makePageRealm();
    realm2.applyPlugin();
    realm2.fromHost({ source: 'evil-host', type: 'ack', openExternal: true });
    realm2.win.open('https://example.com/a');
    ok(realm2.nativeOpenCalls.length === 1, '非本宿主 ack 不接管');
    // ack 缺少 openExternal 标记时不接管
    const realm3 = makePageRealm();
    realm3.applyPlugin();
    realm3.fromHost({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true });
    realm3.win.open('https://example.com/a');
    ok(realm3.nativeOpenCalls.length === 1, '无 openExternal 标记的 ack 不接管');
  }

  console.log('[5] webview 中继：ack 与 open 转发');
  {
    const html = I.buildIframeHtml(DSH_ORIGIN, 1, 'revealAndOpen');
    const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)[1];
    const frameMessages = [];
    const toHost = [];
    const loadHandlers = [];
    const winListeners = [];
    const timers = [];
    let timerSeq = 1;
    const frameWindow = { postMessage: (payload, origin) => frameMessages.push({ payload, origin }) };
    const frame = { contentWindow: frameWindow, style: {}, addEventListener: (type, fn) => { if (type === 'load') loadHandlers.push(fn); } };
    const win = {
      addEventListener: (type, fn) => winListeners.push({ type, fn }),
      removeEventListener: () => {},
      setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; },
      clearTimeout: () => {}
    };
    const sandbox = {
      window: win,
      document: { getElementById: (id) => (id === 'dsh-frame' ? frame : null) },
      acquireVsCodeApi: () => ({ postMessage: (m) => toHost.push(m) }),
      setTimeout: win.setTimeout,
      clearTimeout: win.clearTimeout,
      console
    };
    vm.createContext(sandbox);
    vm.runInContext(script, sandbox, { filename: 'iframe-relay.js' });

    const fromPlugin = (data, overrides = {}) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data,
      source: overrides.source === undefined ? frameWindow : overrides.source,
      origin: overrides.origin === undefined ? DSH_ORIGIN : overrides.origin
    }));
    const fireLoad = () => loadHandlers.forEach((fn) => fn());

    fireLoad();
    const acks = frameMessages.filter((m) => m.payload.type === 'ack');
    ok(acks.length >= 1 && acks[0].payload.openExternal === true, 'iframe load 的 ack 携带 openExternal=true');
    ok(acks[0].payload.externalLinks === true, '默认 systemBrowser 的 ack 携带 externalLinks=true');
    ok(acks[0].payload.fileLinks === true && acks[0].origin === DSH_ORIGIN, '既有 fileLinks 语义与精确 origin 保持不变');

    fromPlugin({ source: 'dsh-vscode-open-external', type: 'hello' });
    ok(frameMessages.filter((m) => m.payload.type === 'ack').length >= 2, '外链插件 hello 也会收到 ack');

    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'https://platform.deepseek.com/authorize?state=x' });
    ok(toHost.length === 1 && toHost[0].type === 'dsh-open-link' && toHost[0].url === 'https://platform.deepseek.com/authorize?state=x', 'open 消息转发为宿主的 dsh-open-link');
    ok(toHost[0].kind === 'popup', '旧插件缺 kind 时按 popup 处理（系统浏览器）');

    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'https://example.com/doc', kind: 'link' });
    ok(toHost.length === 2 && toHost[1].kind === 'link', 'click 桥的 kind=link 原样透传');
    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'https://example.com/login', kind: 'login' });
    ok(toHost.length === 3 && toHost[2].kind === 'login', '登录 kind=login 原样透传');
    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'https://example.com/x', kind: 'evil' });
    ok(toHost.length === 4 && toHost[3].kind === 'popup', '非法 kind 收敛为 popup');

    // 宿主热更新：off ↔ systemBrowser 不重载 iframe，只重发 ack。
    const toWebview = (data) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data, origin: 'vscode-webview://x', source: null
    }));
    toWebview({ type: 'dsh-external-links-config', enabled: false });
    const offAck = frameMessages.filter((m) => m.payload.type === 'ack').pop();
    ok(offAck && offAck.payload.externalLinks === false, '配置 off 后重发 ack externalLinks=false');
    toWebview({ type: 'dsh-external-links-config', enabled: true });
    const onAck = frameMessages.filter((m) => m.payload.type === 'ack').pop();
    ok(onAck && onAck.payload.externalLinks === true, '配置重新开启后重发 ack externalLinks=true');

    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'javascript:alert(1)' });
    ok(toHost.length === 4, '非 http(s) 链接被拒绝');
    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'https://x.test/' + 'y'.repeat(9000) });
    ok(toHost.length === 4, '超长链接被拒绝');
    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'https://evil.test/a' }, { origin: 'http://evil.example.com' });
    ok(toHost.length === 4, 'origin 不符的 open 被丢弃');
    fromPlugin({ source: 'dsh-vscode-open-external', type: 'open', url: 'https://evil.test/a' }, { source: { evil: true } });
    ok(toHost.length === 4, 'source 不是本 iframe 的 open 被丢弃');
    fromPlugin({ source: 'other', type: 'open', url: 'https://evil.test/a' });
    ok(toHost.length === 4, '其它插件 source 的 open 被丢弃');
  }

  console.log('[6] webview 中继：文件链接 off 时仍允许登录链接');
  {
    configValues['dshPanel.externalLinkAction'] = 'off';
    const html = I.buildIframeHtml(DSH_ORIGIN, 1, 'off');
    delete configValues['dshPanel.externalLinkAction'];
    const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)[1];
    const frameMessages = [];
    const toHost = [];
    const loadHandlers = [];
    const winListeners = [];
    const frameWindow = { postMessage: (payload, origin) => frameMessages.push({ payload, origin }) };
    const frame = { contentWindow: frameWindow, style: {}, addEventListener: (type, fn) => { if (type === 'load') loadHandlers.push(fn); } };
    const win = {
      addEventListener: (type, fn) => winListeners.push({ type, fn }),
      removeEventListener: () => {},
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout: () => {}
    };
    const sandbox = {
      window: win,
      document: { getElementById: (id) => (id === 'dsh-frame' ? frame : null) },
      acquireVsCodeApi: () => ({ postMessage: (m) => toHost.push(m) }),
      setTimeout: win.setTimeout,
      clearTimeout: win.clearTimeout,
      console
    };
    vm.createContext(sandbox);
    vm.runInContext(script, sandbox, { filename: 'iframe-relay.js' });
    loadHandlers.forEach((fn) => fn());
    const ack = frameMessages.filter((m) => m.payload.type === 'ack')[0];
    ok(ack && ack.payload.fileLinks === false, 'off 模式的 ack 明确 fileLinks=false（文件链接插件保持惰性）');
    ok(ack && ack.payload.openExternal === true, 'off 模式的 ack 仍允许外链/登录链接');
    ok(ack && ack.payload.externalLinks === false, 'externalLinkAction=off 时 ack 明确 externalLinks=false');
    winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data: { source: 'dsh-vscode-open-external', type: 'open', url: 'https://platform.deepseek.com/authorize' },
      source: frameWindow,
      origin: DSH_ORIGIN
    }));
    ok(toHost.length === 1 && toHost[0].type === 'dsh-open-link', 'off 模式仍转发登录链接');
  }

  console.log('[7] 扩展宿主：dsh-open-link 只放行 http(s) 并打开系统浏览器');
  {
    openedExternal.length = 0;
    const wv = { postMessage: () => {} };
    I.handleWebviewMessage({ type: 'dsh-open-link', url: 'https://platform.deepseek.com/authorize?state=abc' }, wv);
    ok(openedExternal.length === 1 && openedExternal[0] === 'https://platform.deepseek.com/authorize?state=abc', 'http(s) 链接调用 vscode.env.openExternal');
    I.handleWebviewMessage({ type: 'dsh-open-link', url: 'javascript:alert(1)' }, wv);
    ok(openedExternal.length === 1, '非 http(s) 链接被拒绝');
    I.handleWebviewMessage({ type: 'dsh-open-link', url: 'file:///etc/passwd' }, wv);
    ok(openedExternal.length === 1, 'file: 链接被拒绝');
    I.handleWebviewMessage({ type: 'dsh-open-link' }, wv);
    I.handleWebviewMessage(null, wv);
    ok(openedExternal.length === 1, '缺失 url / 空消息安全忽略');
  }

  console.log('[8] click 桥：未 ack / externalLinks=false 不介入');
  {
    const a = makeAnchor({ href: 'https://example.com/a', target: '_blank' });
    const r1 = makePageRealm();
    r1.applyPlugin();
    const e1 = makeClickEvent(a);
    r1.fire('click', e1);
    await Promise.resolve();
    ok(openMessages(r1).length === 0 && !e1.defaultPrevented, '未 ack 不接管');
    ok(r1.docListeners.length === 0, '未 ack 不绑定 document 监听');

    r1.fromHost({ source: 'dsh-vscode-host', type: 'ack', openExternal: true, externalLinks: false });
    const e2 = makeClickEvent(a);
    r1.fire('click', e2);
    await Promise.resolve();
    ok(openMessages(r1).length === 0, 'externalLinks=false 不接管');
    ok(r1.docListeners.length === 0, '关闭时保持零监听');

    // 配置热更新：false → true 重新绑定，true → false 立即移除（不重载页面）。
    r1.fromHost({ source: 'dsh-vscode-host', type: 'ack', openExternal: true, externalLinks: true });
    ok(r1.docListeners.filter((l) => l.type === 'click').length === 1, '热更新开启后重新绑定 click');
    r1.fromHost({ source: 'dsh-vscode-host', type: 'ack', openExternal: true, externalLinks: false });
    ok(r1.docListeners.length === 0, '热更新关闭后移除监听');
  }

  console.log('[9] click 桥：新窗口 / 新标签意图');
  {
    const realm = makePageRealm();
    realm.applyPlugin();
    realm.fromHost({ source: 'dsh-vscode-host', type: 'ack', openExternal: true, externalLinks: true });
    ok(realm.docListeners.filter((l) => l.type === 'click').length === 1, 'ack 后绑定 click');
    ok(realm.docListeners.filter((l) => l.type === 'auxclick').length === 1, 'ack 后绑定 auxclick');

    // 普通左键 target=_blank：先让 DSH 跑；未 preventDefault 才转交。
    const blank = makeAnchor({ href: 'https://example.com/doc', target: '_blank' });
    const e1 = makeClickEvent(blank);
    realm.fire('click', e1);
    ok(openMessages(realm).length === 0, '微任务前不抢跑（等 DSH 自己处理）');
    await Promise.resolve();
    ok(openMessages(realm).length === 1, 'target=_blank 普通左键转交宿主');
    ok(openMessages(realm)[0].payload.kind === 'link', 'click 桥标记 kind=link');
    ok(e1.propagationStopped === false, '延迟转交不阻断事件冒泡');

    // DSH 已 preventDefault（侧栏浏览器）→ 让位。
    const handled = makeAnchor({ href: 'https://example.com/handled', target: '_blank' });
    const e2 = makeClickEvent(handled);
    realm.fire('click', e2);
    e2.preventDefault();
    await Promise.resolve();
    ok(openMessages(realm).length === 1, 'DSH 已 preventDefault 时让位（侧栏行为不变）');

    // 只 stopPropagation、不 preventDefault → 微任务仍能转交。
    const stopped = makeAnchor({ href: 'https://example.com/stopped', target: '_blank' });
    const e3 = makeClickEvent(stopped);
    realm.fire('click', e3);
    e3.stopPropagation();
    await Promise.resolve();
    ok(openMessages(realm).length === 2 && openMessages(realm)[1].payload.url === 'https://example.com/stopped', 'stopPropagation 不阻止转交');

    // 修饰键：立即接管（DSH 对修饰键明确让位）。
    const mod = makeAnchor({ href: 'https://example.com/mod', target: '_blank' });
    const e4 = makeClickEvent(mod, { ctrlKey: true });
    realm.fire('click', e4);
    ok(e4.defaultPrevented && e4.propagationStopped, 'Ctrl+click 立即 preventDefault + stopPropagation');
    ok(openMessages(realm).length === 3, 'Ctrl+click 按新标签意图转交');

    // 中键：新标签意图。
    const middle = makeAnchor({ href: 'https://example.com/middle', target: '_blank' });
    const e5 = makeClickEvent(middle, { type: 'auxclick', button: 1 });
    realm.fire('auxclick', e5);
    ok(e5.defaultPrevented && openMessages(realm).length === 4, '中键立即接管');

    // _parent / _top / 具名 target：sandbox 里本来打不开，立即转交。
    for (const target of ['_parent', '_top', 'named']) {
      const a = makeAnchor({ href: 'https://example.com/' + target, target });
      const e = makeClickEvent(a);
      realm.fire('click', e);
      ok(e.defaultPrevented, target + ' 立即接管');
    }
    ok(openMessages(realm).length === 7, '_parent / _top / 具名 target 都转交');

    // window.open 与 click 同 URL：600ms 内去重。
    realm.win.open('https://example.com/dup', '_blank');
    const dup = makeAnchor({ href: 'https://example.com/dup', target: '_blank' });
    const e6 = makeClickEvent(dup);
    realm.fire('click', e6);
    await Promise.resolve();
    ok(openMessages(realm).filter((m) => m.payload.url === 'https://example.com/dup').length === 1, 'window.open 与 click 同 URL 只发一条');
  }

  console.log('[10] click 桥：不接管的情况（含 _self / 同源 / 下载 / 非法 scheme）');
  {
    const realm = makePageRealm();
    realm.applyPlugin();
    realm.fromHost({ source: 'dsh-vscode-host', type: 'ack', openExternal: true, externalLinks: true });
    const before = openMessages(realm).length;

    const cases = [
      ['target=_self', makeAnchor({ href: 'https://example.com/self', target: '_self' })],
      ['无 target', makeAnchor({ href: 'https://example.com/none' })],
      ['同源绝对链接', makeAnchor({ href: DSH_ORIGIN + '/settings', target: '_blank' })],
      ['相对链接', makeAnchor({ href: '/settings', target: '_blank' })],
      ['#hash', makeAnchor({ href: '#top', target: '_blank' })],
      ['download', makeAnchor({ href: 'https://example.com/f', target: '_blank', download: '' })],
      ['mailto', makeAnchor({ href: 'mailto:a@b.com', target: '_blank' })],
      ['javascript', makeAnchor({ href: 'javascript:alert(1)', target: '_blank' })],
      ['file', makeAnchor({ href: 'file:///etc/passwd', target: '_blank' })],
      ['超长', makeAnchor({ href: 'https://example.com/' + 'x'.repeat(9000), target: '_blank' })]
    ];
    for (const [name, a] of cases) {
      const e = makeClickEvent(a);
      realm.fire('click', e);
      await Promise.resolve();
      ok(openMessages(realm).length === before, name + ' 不接管');
      ok(!e.defaultPrevented, name + ' 不 preventDefault（保持原行为）');
    }

    // target=_self / 无 target：即使带修饰键或中键也不接管（严格保持原行为）。
    const selfCtrl = makeAnchor({ href: 'https://example.com/self-ctrl', target: '_self' });
    const eSelfCtrl = makeClickEvent(selfCtrl, { ctrlKey: true });
    realm.fire('click', eSelfCtrl);
    const noTargetMeta = makeAnchor({ href: 'https://example.com/no-target-meta' });
    const eNoTargetMeta = makeClickEvent(noTargetMeta, { metaKey: true });
    realm.fire('click', eNoTargetMeta);
    const selfMiddle = makeAnchor({ href: 'https://example.com/self-middle', target: '_self' });
    const eSelfMiddle = makeClickEvent(selfMiddle, { type: 'auxclick', button: 1 });
    realm.fire('auxclick', eSelfMiddle);
    await Promise.resolve();
    ok(openMessages(realm).length === before, 'target=_self / 无 target 的修饰键与中键也不接管');
    ok(!eSelfCtrl.defaultPrevented && !eNoTargetMeta.defaultPrevented && !eSelfMiddle.defaultPrevented, '这些点击不 preventDefault');

    // Alt+click 保留浏览器下载语义；macOS Ctrl+click 不抢右键菜单。
    const alt = makeAnchor({ href: 'https://example.com/alt', target: '_blank' });
    const eAlt = makeClickEvent(alt, { altKey: true });
    realm.fire('click', eAlt);
    await Promise.resolve();
    ok(openMessages(realm).length === before && !eAlt.defaultPrevented, 'Alt+click 不接管');

    // 脚本合成点击（非 trusted）不转交。
    const untrusted = makeAnchor({ href: 'https://example.com/untrusted', target: '_blank' });
    const eUntrusted = makeClickEvent(untrusted, { isTrusted: false });
    realm.fire('click', eUntrusted);
    await Promise.resolve();
    ok(openMessages(realm).length === before, '非 trusted 点击不接管');
  }

  console.log('[11] click 桥：卸载清理');
  {
    const realm = makePageRealm();
    realm.applyPlugin();
    realm.fromHost({ source: 'dsh-vscode-host', type: 'ack', openExternal: true, externalLinks: true });
    ok(realm.docListeners.length > 0, '启用后存在 document 监听');
    realm.disposers.forEach((fn) => { if (typeof fn === 'function') fn(); });
    ok(realm.docListeners.length === 0, '卸载后移除 document 监听');
    const e = makeClickEvent(makeAnchor({ href: 'https://example.com/z', target: '_blank' }));
    realm.fire('click', e);
    await Promise.resolve();
    ok(openMessages(realm).length === 0, '卸载后不再转交');
  }

  console.log('[12] macOS：Ctrl+click 不抢右键菜单，⌘+click 接管');
  {
    const realm = makePageRealm({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
    });
    realm.applyPlugin();
    realm.fromHost({ source: 'dsh-vscode-host', type: 'ack', openExternal: true, externalLinks: true });
    const a = makeAnchor({ href: 'https://example.com/mac', target: '_blank' });
    const eCtrl = makeClickEvent(a, { ctrlKey: true });
    realm.fire('click', eCtrl);
    await Promise.resolve();
    ok(openMessages(realm).length === 0 && !eCtrl.defaultPrevented, 'macOS Ctrl+click 不接管');
    const eMeta = makeClickEvent(a, { metaKey: true });
    realm.fire('click', eMeta);
    ok(eMeta.defaultPrevented && openMessages(realm).length === 1, 'macOS ⌘+click 接管');
  }

  console.log('[13] 独立浏览器（parent === self）完全不介入');
  {
    const realm = makePageRealm();
    realm.win.parent = realm.win;
    realm.applyPlugin();
    ok(realm.parentMessages.length === 0, 'parent===self 不发 hello');
    ok(realm.docListeners.length === 0, '独立浏览器不绑定 click 监听');
    realm.win.open('https://example.com/free');
    ok(realm.nativeOpenCalls.length === 1 && realm.nativeOpenCalls[0][0] === 'https://example.com/free', '独立浏览器 window.open 保持原生');
  }

  const disposers = [];
  for (const p of []) { if (typeof p === 'function') disposers.push(p()); }
  os.homedir = realHomedir;
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  os.homedir = realHomedir;
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
