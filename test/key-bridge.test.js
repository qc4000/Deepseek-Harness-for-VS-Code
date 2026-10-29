'use strict';
/**
 * 面板内快捷键转发（spec 008）：纯函数 + webview 中继 + 宿主消息处理。
 * 运行：node test/key-bridge.test.js
 *
 * 覆盖：
 *  1) normalizeCombo：三平台 mod 展开、顺序归一、chord/无修饰键/未知键拒绝；
 *  2) parseForwardKeybindings：六类非法条目被忽略且不拖垮其余条目；
 *  3) buildForwardTable：默认表 + 新增 + 覆盖 + false 禁用；
 *  4) 中继：hello → keys-ack；合法 gesture 转发；非法 gesture 丢弃；F6 交还焦点；
 *  5) 宿主：只按自己的表执行命令（页面给的命令 id 一律不采信）；失败提示一次。
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');
const vm = require('vm');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

// ── vscode 桩 ───────────────────────────────────────────────────────────
const configValues = new Map();
const statusMessages = [];
const executed = [];
const vscodeStub = {
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  FileType: { File: 1, Directory: 2 },
  Uri: { parse: (u) => ({ toString: () => u }), file: (p) => ({ fsPath: p }) },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (k, d) => (configValues.has(k) ? configValues.get(k) : d),
      update: async (k, v) => { configValues.set(k, v); }
    })
  },
  env: { openExternal() {}, remoteName: undefined, clipboard: { writeText: async () => {} } },
  window: {
    setStatusBarMessage: (t) => { statusMessages.push(t); return { dispose() {} }; },
    showInformationMessage: () => {},
    showErrorMessage: () => {},
    showWarningMessage: () => {},
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    getCommands: async () => [],
    executeCommand: (cmd) => {
      executed.push(cmd);
      if (cmd === 'boom.cmd') return Promise.reject(new Error('command not found'));
      return Promise.resolve();
    }
  }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

const DSH_ORIGIN = 'http://127.0.0.1:3080';
const HOST_ID = 'dsh-vscode-host';
const KEYS_ID = 'dsh-vscode-keys';
const PLATFORM = process.platform;
const sigOf = (combo) => I.gestureSignature(I.comboToGesture(combo, PLATFORM));
const flush = () => new Promise((r) => setImmediate(r));

/** 把面板内联中继脚本装进一个 vm「webview 域」。 */
function makeRealm() {
  const html = I.buildIframeHtml(DSH_ORIGIN, 1, 'revealAndOpen');
  const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)[1];

  const frameMessages = [];
  const toHost = [];
  const winListeners = [];
  const timers = [];
  const calls = { blur: 0, focus: 0 };
  let timerSeq = 1;

  const frameWindow = { postMessage: (payload, origin) => frameMessages.push({ payload, origin }) };
  const frame = {
    contentWindow: frameWindow,
    style: {},
    blur: () => { calls.blur += 1; },
    addEventListener: () => {}
  };
  const stage = { clientWidth: 800, style: {}, focus: () => { calls.focus += 1; } };
  const win = {
    addEventListener: (type, fn) => winListeners.push({ type, fn }),
    removeEventListener: () => {},
    setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; },
    clearTimeout: () => {}
  };
  const sandbox = {
    window: win,
    document: {
      documentElement: { clientWidth: 800 },
      getElementById: (id) => (id === 'dsh-frame' ? frame : id === 'dsh-stage' ? stage : null)
    },
    acquireVsCodeApi: () => ({ postMessage: (m) => toHost.push(m) }),
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    console: { warn() {}, error() {}, log() {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'iframe-relay.js' });

  return {
    toHost,
    frameMessages,
    calls,
    fromPlugin: (data, overrides = {}) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data,
      source: overrides.source === undefined ? frameWindow : overrides.source,
      origin: overrides.origin === undefined ? DSH_ORIGIN : overrides.origin
    })),
    fromHost: (data) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data,
      origin: 'vscode-webview://x',
      source: null
    }))
  };
}

(async () => {
  console.log('[1] normalizeCombo：平台展开与非法输入');
  {
    ok(I.normalizeCombo('mod+shift+p', 'linux') === 'ctrl+shift+p', 'linux：mod → ctrl');
    ok(I.normalizeCombo('mod+shift+p', 'win32') === 'ctrl+shift+p', 'win32：mod → ctrl');
    ok(I.normalizeCombo('mod+shift+p', 'darwin') === 'meta+shift+p', 'darwin：mod → meta');
    ok(I.normalizeCombo('Shift+Ctrl+P', 'linux') === 'ctrl+shift+p', '顺序/大小写归一');
    ok(I.normalizeCombo('mod+`', 'linux') === 'ctrl+backquote', '符号主键归一为 code 名');
    ok(I.normalizeCombo('f6', 'linux') === 'f6', '功能键允许无修饰键');
    ok(I.normalizeCombo('ctrl+k ctrl+s', 'linux') === null, '两段式（chord）拒绝');
    ok(I.normalizeCombo('p', 'linux') === null, '无修饰键单字母拒绝');
    ok(I.normalizeCombo('enter', 'linux') === null, '无修饰键 Enter 拒绝（不抢输入框）');
    ok(I.normalizeCombo('ctrl+foo', 'linux') === null, '未知主键拒绝');
    ok(I.normalizeCombo('ctrl+a+b', 'linux') === null, '两个主键拒绝');
    ok(I.normalizeCombo('x'.repeat(80), 'linux') === null, '超长组合拒绝');
    ok(I.normalizeCombo(42, 'linux') === null, '非字符串拒绝');
  }

  console.log('[2] gesture 签名与还原');
  {
    const g = I.comboToGesture('mod+shift+p', 'linux');
    ok(g.code === 'KeyP' && g.ctrl === true && g.shift === true && g.meta === false, '组合 → 物理键 gesture');
    const sig = I.gestureSignature(g);
    ok(sig === 'KeyP|1|0|0|1', '签名格式与页面插件一致');
    ok(I.signatureToCombo(sig) === 'ctrl+shift+p', '签名 → 可读组合');
    ok(I.signatureToCombo('KeyP|1|0|0') === '', '缺字段的签名还原失败');
  }

  console.log('[3] parseForwardKeybindings：非法条目逐条忽略');
  {
    const raw = {
      'ctrl+shift+y': 'workbench.action.togglePanel',
      'ctrl+shift+f': false,
      'ctrl+h': true,
      'ctrl+': 'workbench.action.quickOpen',
      'ctrl+x': 'Bad Command Id',
      'ctrl+k ctrl+s': 'workbench.action.files.save'
    };
    // 原型键必须是「自有属性」才进得了 Object.keys（直接写字面量会改掉原型）。
    Object.defineProperty(raw, '__proto__', { value: 'workbench.action.undo', enumerable: true, configurable: true });
    const parsed = I.parseForwardKeybindings(raw, 'linux');
    ok(parsed.entries.length === 1 && parsed.entries[0].command === 'workbench.action.togglePanel', '合法条目保留');
    ok(parsed.disabled.length === 1 && parsed.disabled[0] === 'ctrl+shift+f', 'false 进入禁用表');
    ok(parsed.invalid.length === 5, 'true/空主键/非法 id/chord/原型键全部记为非法');
    const notObject = I.parseForwardKeybindings('nope', 'linux');
    ok(notObject.invalid.length === 1, '非对象整体拒绝');
    const many = {};
    for (const mod of ['ctrl+shift+', 'ctrl+alt+', 'ctrl+meta+']) {
      for (let c = 0; c < 26; c++) many[mod + String.fromCharCode(97 + c)] = 'workbench.action.togglePanel';
    }
    const capped = I.parseForwardKeybindings(many, 'linux');
    ok(capped.entries.length === I.FORWARD_MAX_ENTRIES, '超过 64 条的部分被拒（保留 ' + capped.entries.length + ' 条）');
    ok(capped.invalid.length === 78 - I.FORWARD_MAX_ENTRIES, '超出部分计入非法清单');
  }

  console.log('[4] buildForwardTable：默认表 + 新增 + 覆盖 + 禁用');
  {
    const base = I.buildForwardTable('linux', {});
    ok(base.active.length === I.DEFAULT_FORWARD_KEYS.length, '默认表条目数一致');
    ok(base.active.every((item) => item.origin === 'default'), '默认来源标记正确');
    ok(base.table[sigOf('mod+shift+p')] === true, '默认表写进页面用的签名表');
    ok(base.active.some((item) => item.combo === 'ctrl+shift+f'), '第二批含全局搜索（是否让位由页面判定）');

    const custom = I.buildForwardTable('linux', {
      'ctrl+shift+y': 'workbench.action.togglePanel',
      'mod+shift+p': 'workbench.action.files.openFile',
      'ctrl+shift+f': false
    });
    const added = custom.active.find((item) => item.combo === 'ctrl+shift+y');
    ok(added && added.origin === 'config', '新增键进入生效表');
    const overridden = custom.active.find((item) => item.combo === 'ctrl+shift+p');
    ok(overridden && overridden.command === 'workbench.action.files.openFile' && overridden.origin === 'config', '同名覆盖默认命令');
    ok(custom.disabled.indexOf('ctrl+shift+f') !== -1, 'false 进入禁用清单');
    ok(!custom.active.some((item) => item.combo === 'ctrl+shift+f'), '被禁用的键不在生效表');
    ok(custom.active.length === I.DEFAULT_FORWARD_KEYS.length, '净条数不变（新增 1 / 禁用 1）');
    ok(custom.active.every((item) => item.combo !== undefined), '每个条目都有可读组合');
  }

  console.log('[5] forwardKeysState：总开关关闭时不下发表');
  {
    const on = I.forwardKeysState();
    ok(on.enabled === true && Object.keys(on.table).length > 0, '默认开启且有表');
    ok(on.releaseKey === 'F6|0|0|0|0', '焦点交还键默认 F6');

    configValues.set(I.FORWARD_KEYS_KEY, false);
    const off = I.forwardKeysState();
    ok(off.enabled === false && Object.keys(off.table).length === 0, '关闭后空表');
    ok(off.releaseKey === null, '关闭后不再交还焦点');
    configValues.delete(I.FORWARD_KEYS_KEY);
  }

  console.log('[6] 中继：hello → keys-ack 带表；合法 gesture 转发');
  {
    const wv = makeRealm();
    wv.fromPlugin({ source: KEYS_ID, type: 'hello' });
    const ack = wv.frameMessages.filter((m) => m.payload.type === 'keys-ack');
    ok(ack.length === 1, 'hello 回一条 keys-ack');
    ok(ack[0].payload.source === HOST_ID, '回执带宿主标识');
    ok(ack[0].payload.table[sigOf('mod+shift+p')] === true, '回执表含默认键位');
    ok(ack[0].payload.releaseKey === 'F6|0|0|0|0', '回执带焦点交还键');
    ok(ack[0].payload.table[sigOf('mod+shift+p')] !== 'workbench.action.showCommands', '表里不含命令 id（页面无法指定命令）');

    wv.fromPlugin({ source: KEYS_ID, type: 'key', gesture: { code: 'KeyP', ctrl: true, meta: false, alt: false, shift: true } });
    const fwd = wv.toHost.filter((m) => m.type === 'dsh-forwarded-key');
    ok(fwd.length === 1, '合法 gesture 转发到宿主');
    ok(fwd[0].gesture.code === 'KeyP' && fwd[0].gesture.ctrl === true, 'gesture 原样转发');
    ok(Object.keys(fwd[0].gesture).length === 5, '只带 5 个白名单字段');
  }

  console.log('[7] 中继：非法 gesture / 来源不符一律丢弃');
  {
    const wv = makeRealm();
    wv.fromPlugin({ source: KEYS_ID, type: 'key', gesture: { code: 'KeyP', ctrl: true, meta: false, alt: false, shift: true, command: 'workbench.action.files.save' } });
    ok(wv.toHost.filter((m) => m.type === 'dsh-forwarded-key').length === 0, '夹带 command 字段整条丢弃（AC-6）');
    wv.fromPlugin({ source: KEYS_ID, type: 'key', gesture: { code: 'Key'+'P'.repeat(30), ctrl: true, meta: false, alt: false, shift: true } });
    ok(wv.toHost.filter((m) => m.type === 'dsh-forwarded-key').length === 0, '超长 code 丢弃');
    wv.fromPlugin({ source: KEYS_ID, type: 'key', gesture: { code: 'KeyP', ctrl: 'yes', meta: false, alt: false, shift: true } });
    ok(wv.toHost.filter((m) => m.type === 'dsh-forwarded-key').length === 0, '修饰键非布尔丢弃');
    wv.fromPlugin({ source: KEYS_ID, type: 'key', gesture: { code: 'KeyP', ctrl: true, meta: false, alt: false, shift: true } }, { origin: 'http://evil.example' });
    ok(wv.toHost.filter((m) => m.type === 'dsh-forwarded-key').length === 0, '错误 origin 丢弃');
    wv.fromPlugin({ source: 'dsh-vscode-file-links', type: 'key', gesture: { code: 'KeyP', ctrl: true, meta: false, alt: false, shift: true } });
    ok(wv.toHost.filter((m) => m.type === 'dsh-forwarded-key').length === 0, '错误 source 丢弃');
  }

  console.log('[8] 中继：F6 交还焦点（blur iframe + 聚焦 stage）');
  {
    const wv = makeRealm();
    wv.fromPlugin({ source: KEYS_ID, type: 'focus-release' });
    ok(wv.calls.blur === 1, '调用 frame.blur()');
    ok(wv.calls.focus === 1, '把焦点落到本页 stage（否则字母会进编辑器）');
    ok(wv.toHost.filter((m) => m.type === 'dsh-focus-released').length === 1, '回报宿主');
  }

  console.log('[9] 中继：状态回报只保留白名单字段');
  {
    const wv = makeRealm();
    wv.fromPlugin({
      source: KEYS_ID,
      type: 'keys-status',
      degraded: true,
      active: 3,
      shadowed: [
        { sig: 'KeyF|0|1|0|1', command: 'session.fork' },
        { sig: 'not-a-signature', command: 'x' },
        { sig: 'KeyP|1|0|0|1', command: 'Bad Id' }
      ],
      command: 'workbench.action.files.save'
    });
    const status = wv.toHost.filter((m) => m.type === 'dsh-keys-status');
    ok(status.length === 1, '状态转发一次');
    ok(status[0].degraded === true, '降级标记保留');
    ok(status[0].shadowed.length === 2, '非法签名被丢弃，非法命令 id 清空');
    ok(status[0].shadowed[1].command === '', '非法 DSH 命令 id 不透传');
    ok(status[0].command === undefined, '不夹带额外字段');
  }

  console.log('[10] 中继：配置热更新换表且不重载');
  {
    const wv = makeRealm();
    const before = wv.toHost.length;
    wv.fromHost({ type: 'dsh-keys-config', enabled: true, table: { 'KeyY|1|0|0|1': true }, releaseKey: 'F9|0|0|0|0' });
    const ack = wv.frameMessages.filter((m) => m.payload.type === 'keys-ack');
    ok(ack[ack.length - 1].payload.table['KeyY|1|0|0|1'] === true, '新表已下发给页面');
    ok(ack[ack.length - 1].payload.releaseKey === 'F9|0|0|0|0', '交还键跟着换');
    ok(wv.toHost.length === before, '不产生额外宿主消息');

    wv.fromHost({ type: 'dsh-keys-config', enabled: false, table: {}, releaseKey: null });
    const count = wv.frameMessages.length;
    wv.fromPlugin({ source: KEYS_ID, type: 'hello' });
    ok(wv.frameMessages.length === count, '关闭后不再回 keys-ack');
  }

  console.log('[11] 宿主：只按自己的表执行命令');
  {
    const before = executed.length;
    I.handleWebviewMessage({ type: 'dsh-forwarded-key', gesture: { code: 'KeyP', ctrl: true, meta: false, alt: false, shift: true } });
    await flush();
    ok(executed.length === before + 1 && executed[executed.length - 1] === 'workbench.action.showCommands', 'mod+shift+p → 命令面板');

    I.handleWebviewMessage({ type: 'dsh-forwarded-key', gesture: { code: 'KeyP', ctrl: true, meta: false, alt: false, shift: true, command: 'workbench.action.files.save' } });
    await flush();
    ok(executed.length === before + 1, '夹带 command 的 gesture 不执行（AC-6）');

    const statusBefore = statusMessages.length;
    I.handleWebviewMessage({ type: 'dsh-forwarded-key', gesture: { code: 'KeyQ', ctrl: true, meta: true, alt: true, shift: true } });
    await flush();
    ok(executed.length === before + 1, '不在表里的组合不执行');
    ok(statusMessages.length === statusBefore + 1 && statusMessages[statusMessages.length - 1].includes('未被转发'), '未知组合给一次可见提示');

    I.handleWebviewMessage({ type: 'dsh-forwarded-key', gesture: { code: 'KeyQ', ctrl: true, meta: true, alt: true, shift: true } });
    await flush();
    ok(statusMessages.length === statusBefore + 1, '同一组合不重复提示');
  }

  console.log('[12] 宿主：命令不存在时提示一次');
  {
    configValues.set(I.FORWARD_MAP_KEY, { 'ctrl+shift+y': 'boom.cmd' });
    const before = statusMessages.length;
    I.handleWebviewMessage({ type: 'dsh-forwarded-key', gesture: { code: 'KeyY', ctrl: true, meta: false, alt: false, shift: true } });
    await flush();
    const msg = statusMessages[statusMessages.length - 1];
    ok(statusMessages.length === before + 1 && msg.includes('boom.cmd') && msg.includes('dshPanel.forwardKeybindings'), '失败提示含命令 id 与出路');
    I.handleWebviewMessage({ type: 'dsh-forwarded-key', gesture: { code: 'KeyY', ctrl: true, meta: false, alt: false, shift: true } });
    await flush();
    ok(statusMessages.length === before + 1, '同一命令不重复提示');
    configValues.delete(I.FORWARD_MAP_KEY);
  }

  console.log('[13] 宿主：焦点交还只提示一次；状态回报被收敛');
  {
    const before = statusMessages.length;
    I.handleWebviewMessage({ type: 'dsh-focus-released' });
    I.handleWebviewMessage({ type: 'dsh-focus-released' });
    ok(statusMessages.length === before + 1, '交还提示只弹一次');
    ok(statusMessages[statusMessages.length - 1].includes('点击面板'), '提示说明怎么回到面板');

    const status = I.normalizeKeysStatus({ degraded: false, shadowed: [{ sig: 'KeyF|0|1|0|1', command: 'session.fork' }] });
    ok(status.shadowed.length === 1 && status.shadowed[0].combo === 'meta+shift+f', '让位清单转成可读组合');
    ok(I.normalizeKeysStatus(null) === null, '非法状态返回 null');
  }

  console.log('[14] 既有中继不回归');
  {
    const wv = makeRealm();
    wv.fromPlugin({ source: 'dsh-vscode-file-links', type: 'hello', version: '0.1.0' });
    ok(wv.frameMessages.some((m) => m.payload.type === 'ack' && m.payload.fileLinks === true), '文件链接握手仍正常');
    wv.fromPlugin({ source: 'dsh-webview-clipboard', type: 'clipboard-write', token: 'tk', text: 'x' });
    ok(wv.toHost.filter((m) => m.type === 'dsh-clipboard-write').length === 1, '剪贴板中继仍正常');
  }

  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
