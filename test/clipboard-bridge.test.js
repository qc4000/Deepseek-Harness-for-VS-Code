'use strict';
/**
 * 面板内 DSH 复制按钮的剪贴板桥测试（spec 007）。
 * 运行：node test/clipboard-bridge.test.js
 *
 * 覆盖：
 *  1) 中继脚本：合法 clipboard-write 转发、origin/source 双校验、超长拒绝并回执；
 *  2) 宿主回执回传 iframe（clipboard-result）；
 *  3) handleWebviewMessage：写入 vscode.env.clipboard、ok:true/false、失败提示只一次；
 *  4) 不破坏既有中继（外链 / 文件链接）行为。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Module = require('module');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

// ── vscode 桩（宿主侧）──
const statusMessages = [];
const written = [];
const clipboardStub = {
  writeText: async (text) => {
    written.push(text);
    if (text === 'BOOM') throw new Error('clipboard unavailable');
  }
};
const vscodeStub = {
  FileType: { File: 1, Directory: 2 },
  Uri: { parse: (u) => ({ toString: () => u }), file: (p) => ({ fsPath: p }) },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (k, d) => d })
  },
  env: { openExternal: () => {}, remoteName: undefined, clipboard: clipboardStub },
  window: {
    setStatusBarMessage: (t) => { statusMessages.push(t); return { dispose() {} }; },
    showInformationMessage: () => {}, showErrorMessage: () => {}, showWarningMessage: () => {}
  },
  commands: { registerCommand: () => ({ dispose() {} }) }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

const DSH_ORIGIN = 'http://127.0.0.1:3080';
const PLUGIN_ID = 'dsh-webview-clipboard';
const HOST_ID = 'dsh-vscode-host';
const { CLIPBOARD_MAX_TEXT } = I;

/** 把面板内联中继脚本装进一个 vm「webview 域」。 */
function makeWebviewRealm(mode) {
  const html = I.buildIframeHtml(DSH_ORIGIN, 1, mode);
  const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)[1];

  const frameMessages = [];
  const toHost = [];
  const loadHandlers = [];
  const winListeners = [];
  const timers = [];
  let timerSeq = 1;

  const frameWindow = { postMessage: (payload, origin) => frameMessages.push({ payload, origin }) };
  const frame = {
    contentWindow: frameWindow,
    style: {},
    addEventListener: (type, fn) => { if (type === 'load') loadHandlers.push(fn); }
  };
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
    console: { warn() {}, error() {}, log() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'iframe-relay.js' });

  return {
    frameMessages,
    toHost,
    frameWindow,
    /** 模拟 DSH 页面内插件 → webview。 */
    fromPlugin: (data, overrides = {}) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data,
      source: overrides.source === undefined ? frameWindow : overrides.source,
      origin: overrides.origin === undefined ? DSH_ORIGIN : overrides.origin
    })),
    /** 模拟扩展宿主 → webview。 */
    fromHost: (data) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data,
      origin: 'vscode-webview://x',
      source: null
    }))
  };
}

const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log('[1] 中继转发合法的 clipboard-write');
  {
    const wv = makeWebviewRealm('revealAndOpen');
    wv.fromPlugin({ source: PLUGIN_ID, type: 'clipboard-write', token: 'tk1', text: 'console.log(1)' });
    const forwarded = wv.toHost.filter((m) => m.type === 'dsh-clipboard-write');
    ok(forwarded.length === 1, '恰好一条 dsh-clipboard-write');
    ok(forwarded[0].token === 'tk1' && forwarded[0].text === 'console.log(1)', 'token/text 原样转发');

    console.log('[2] 来源校验：origin / source 不符不转发');
    wv.fromPlugin({ source: PLUGIN_ID, type: 'clipboard-write', token: 'tk2', text: 'x' }, { origin: 'http://evil.example' });
    ok(wv.toHost.filter((m) => m.type === 'dsh-clipboard-write').length === 1, '错误 origin 不转发');
    wv.fromPlugin({ source: 'dsh-vscode-file-links', type: 'clipboard-write', token: 'tk3', text: 'x' });
    ok(wv.toHost.filter((m) => m.type === 'dsh-clipboard-write').length === 1, '错误 source 不转发');

    console.log('[3] 超长文本：不转发，回 ok:false');
    const before = wv.toHost.length;
    wv.fromPlugin({ source: PLUGIN_ID, type: 'clipboard-write', token: 'tk4', text: 'x'.repeat(CLIPBOARD_MAX_TEXT + 1) });
    ok(wv.toHost.length === before, '超长消息不进宿主');
    const failed = wv.frameMessages.filter((m) => m.payload.type === 'clipboard-result' && m.payload.token === 'tk4');
    ok(failed.length === 1 && failed[0].payload.ok === false, '向插件回 ok:false');

    console.log('[4] 宿主回执回传 iframe');
    wv.fromHost({ type: 'dsh-clipboard-result', token: 'tk1', ok: true });
    const back = wv.frameMessages.filter((m) => m.payload.type === 'clipboard-result' && m.payload.token === 'tk1');
    ok(back.length === 1 && back[0].payload.source === HOST_ID && back[0].payload.ok === true, '结果带宿主标识与 ok');
    ok(back[0].origin === DSH_ORIGIN, '回传使用精确 targetOrigin');
  }

  console.log('[5] handleWebviewMessage：写入宿主剪贴板');
  {
    const hostMessages = [];
    const webview = { postMessage: (m) => hostMessages.push(m) };
    I.handleWebviewMessage({ type: 'dsh-clipboard-write', token: 'h1', text: '粘贴内容' }, webview);
    await flush();
    ok(written[written.length - 1] === '粘贴内容', '调用 vscode.env.clipboard.writeText');
    const reply = hostMessages.find((m) => m.type === 'dsh-clipboard-result' && m.token === 'h1');
    ok(reply && reply.ok === true, '回执 ok:true');
  }

  console.log('[6] 写入失败：回 ok:false 且提示一次');
  {
    const hostMessages = [];
    const webview = { postMessage: (m) => hostMessages.push(m) };
    I.handleWebviewMessage({ type: 'dsh-clipboard-write', token: 'h2', text: 'BOOM' }, webview);
    await flush();
    const reply = hostMessages.find((m) => m.type === 'dsh-clipboard-result' && m.token === 'h2');
    ok(reply && reply.ok === false, '回执 ok:false');
    ok(statusMessages.some((t) => t.includes('复制失败') && t.includes('Ctrl+C')), '状态栏提示含出路');

    const count = statusMessages.length;
    I.handleWebviewMessage({ type: 'dsh-clipboard-write', token: 'h3', text: 'BOOM' }, webview);
    await flush();
    ok(statusMessages.length === count, '同类失败不再刷屏');
  }

  console.log('[7] 超长文本：宿主也拒绝');
  {
    const hostMessages = [];
    const webview = { postMessage: (m) => hostMessages.push(m) };
    const before = written.length;
    I.handleWebviewMessage({ type: 'dsh-clipboard-write', token: 'h4', text: 'x'.repeat(CLIPBOARD_MAX_TEXT + 1) }, webview);
    await flush();
    ok(written.length === before, '超长文本不写剪贴板');
    const reply = hostMessages.find((m) => m.type === 'dsh-clipboard-result' && m.token === 'h4');
    ok(reply && reply.ok === false, '回执 ok:false');
  }

  console.log('[8] 既有中继不回归');
  {
    const wv = makeWebviewRealm('revealAndOpen');
    wv.fromPlugin({ source: 'dsh-vscode-file-links', type: 'hello', version: '0.1.0' });
    ok(wv.frameMessages.some((m) => m.payload.type === 'ack' && m.payload.fileLinks === true), '文件链接握手仍正常');
  }

  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
