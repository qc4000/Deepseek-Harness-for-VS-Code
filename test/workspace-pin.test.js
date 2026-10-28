'use strict';
/**
 * 面板打开时把 DSH 工作区指向当前 VS Code 文件夹（spec 006）回归测试。
 * 运行：node test/workspace-pin.test.js
 *
 * 覆盖：
 *  1) 插件包静态契约：文件齐全、package.json/cordis.patch.yml 声明、客户端不碰 DOM/localStorage；
 *  2) 宿主纯函数：workspacePinPath / workspacePinEnabled / 路径形状校验（空窗口、开关、非法输入）；
 *  3) 中继脚本：独立消息类型下发、来源与 origin 校验、8s 超时上报、结果字段白名单与截断；
 *  4) 客户端仿真：未握手惰性、握手后 create + openWorkspace、已就位不动作、服务缺失/失败可见；
 *  5) 宿主安装：落盘到 web profile、登记 bundles、版本一致幂等。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const { spawnSync } = require('child_process');
const Module = require('module');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

// ── vscode 桩 ──
const config = {};
const folders = { value: [] };
const warnings = [];
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-pin-'));
process.env.DSH_HOME = profileRoot;
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (Object.prototype.hasOwnProperty.call(config, k) ? config[k] : d) }),
    get workspaceFolders() { return folders.value.length ? folders.value : undefined; }
  },
  env: { remoteName: undefined },
  window: {
    showWarningMessage: async (msg) => { warnings.push(msg); return undefined; },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    setStatusBarMessage: () => ({ dispose() {} })
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

const PLUGIN = 'dsh-vscode-workspace';
const PLUGIN_DIR = path.join(__dirname, '..', 'dsh-plugins', PLUGIN);
const DSH_ORIGIN = 'http://127.0.0.1:3080';
const PLUGIN_ID = 'dsh-vscode-workspace';
const HOST_ID = 'dsh-vscode-host';

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

// =====================================================================
// 1. 插件包静态契约
// =====================================================================
console.log('[1] 插件包静态契约（文件 / 声明 / 零干预约束）');
{
  for (const rel of ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js']) {
    ok(fs.existsSync(path.join(PLUGIN_DIR, rel)), `插件文件存在：${rel}`);
  }
  let pkg = {};
  try { pkg = JSON.parse(readIfExists(path.join(PLUGIN_DIR, 'package.json')) || '{}'); } catch (e) { pkg = {}; }
  ok(pkg.name === PLUGIN, 'package.json name 与目录名一致');
  ok(/^\d+\.\d+\.\d+$/.test(String(pkg.version)), '版本号可解析');
  ok(pkg.type === 'module' && pkg.main === 'lib/index.js', 'ESM 宿主半区入口正确');
  ok(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', '声明 web 客户端半区（DSH 才会加载）');
  ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'bundle.patch 指向 cordis.patch.yml');
  ok(!pkg.dependencies, '不声明 dependencies（npm 上没有该包）');

  const patch = readIfExists(path.join(PLUGIN_DIR, 'cordis.patch.yml'));
  ok(/-\s*insert:/.test(patch) && patch.includes("name: '" + PLUGIN + "'"), 'cordis.patch.yml 注册行与包名一致');

  const hostHalf = readIfExists(path.join(PLUGIN_DIR, 'lib', 'index.js'));
  ok(hostHalf.includes("export const name = '" + PLUGIN + "'"), '宿主半区导出的 name 与包名一致');

  const client = readIfExists(path.join(PLUGIN_DIR, 'lib', 'client.js'));
  ok(client.includes("__ModuleLoader__.load({ id: '" + PLUGIN + "'"), '客户端以 ModuleLoader 格式注册且 id 与包名一致');
  ok(!/localStorage\s*\./.test(client), '客户端不读写 localStorage（状态不落 DSH 页面存储）');
  ok(!/document\.createElement|innerHTML\s*=/.test(client), '客户端不创建/改写 DOM（忠实窗口）');
  ok(!/addEventListener\(\s*['"]click['"]/.test(client), '客户端不拦点击等交互事件（忠实窗口）');

  if (client) {
    const chk = spawnSync(process.execPath, ['--check', path.join(PLUGIN_DIR, 'lib', 'client.js')], { encoding: 'utf8' });
    ok(chk.status === 0, '客户端脚本通过 node --check');
  }
}

// =====================================================================
// 2. 宿主纯函数
// =====================================================================
console.log('[2] 宿主纯函数：开关、空窗口、路径形状');
{
  ok(typeof I.workspacePinPath === 'function', 'workspacePinPath 可测（挂在 __internals）');
  ok(typeof I.workspacePinEnabled === 'function', 'workspacePinEnabled 可测（挂在 __internals）');
  ok(typeof I.isValidWorkspacePinPath === 'function', 'isValidWorkspacePinPath 可测（挂在 __internals）');

  delete config['dshPanel.pinWorkspaceToVSCode'];
  ok(I.workspacePinEnabled() === true, '默认开启');
  config['dshPanel.pinWorkspaceToVSCode'] = false;
  ok(I.workspacePinEnabled() === false, '配置 false 时关闭');
  delete config['dshPanel.pinWorkspaceToVSCode'];

  folders.value = [];
  ok(I.workspacePinPath() === '', '空窗口不下发路径（不钉 ~ 或任意目录）');

  folders.value = [{ uri: { fsPath: '/mnt/work/proj-b' } }];
  ok(I.workspacePinPath() === '/mnt/work/proj-b', '有文件夹时返回第一个文件夹路径');

  config['dshPanel.pinWorkspaceToVSCode'] = false;
  ok(I.workspacePinPath() === '', '开关关闭时不下发路径');
  delete config['dshPanel.pinWorkspaceToVSCode'];

  folders.value = [{ uri: { fsPath: 'x'.repeat(5000) } }];
  ok(I.workspacePinPath() === '', '超长路径拒绝下发');
  folders.value = [{ uri: { fsPath: '/mnt/work/\u0000bad' } }];
  ok(I.workspacePinPath() === '', '含控制字符的路径拒绝下发');
  folders.value = [{ uri: { fsPath: 'https://example.com/x' } }];
  ok(I.workspacePinPath() === '', '带 scheme 的 URL 不是本地路径');
  folders.value = [{ uri: { fsPath: '   ' } }];
  ok(I.workspacePinPath() === '', '纯空白路径拒绝下发');

  ok(I.isValidWorkspacePinPath('/mnt/work/proj') === true, '常规 POSIX 路径合法');
  ok(I.isValidWorkspacePinPath('C:\\work\\proj') === true, 'Windows 盘符路径合法');
  ok(I.isValidWorkspacePinPath('') === false, '空串非法');
  ok(I.isValidWorkspacePinPath(12) === false, '非字符串非法');
  folders.value = [];
}

// =====================================================================
// 3. 中继脚本（跑真实注入脚本）
// =====================================================================
/** 构造一个「webview 域」：跑真实中继脚本 + 假 DOM。 */
function makeRealm(opts) {
  const o = opts || {};
  const html = I.buildIframeHtml(DSH_ORIGIN, 1, 'revealAndOpen', { policy: 'auto', override: null }, o.pinPath);
  const m = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html);
  const script = m ? m[1] : '';

  const toHost = [];
  const frameMessages = [];
  const loadHandlers = [];
  const winListeners = [];
  const timers = [];
  let timerSeq = 1;

  function el(id) {
    return {
      id,
      style: { setProperty() {}, getPropertyValue() { return ''; } },
      clientWidth: 800,
      clientHeight: 600,
      className: '',
      textContent: '',
      dataset: {},
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      addEventListener() {},
      appendChild() {},
      contentWindow: null
    };
  }

  const frame = el('dsh-frame');
  frame.contentWindow = { postMessage: (payload, origin) => frameMessages.push({ payload, origin }) };
  frame.addEventListener = (type, fn) => { if (type === 'load') loadHandlers.push(fn); };

  const sandbox = {
    window: {
      addEventListener: (type, fn) => winListeners.push({ type, fn }),
      removeEventListener: () => {},
      setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; },
      clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
      getComputedStyle: () => ({ gridTemplateColumns: '' })
    },
    document: {
      getElementById: (id) => ({
        'dsh-stage': el('dsh-stage'), 'dsh-clip': el('dsh-clip'), 'dsh-sidebar-toggle': el('dsh-sidebar-toggle'),
        'dsh-toolbar': el('dsh-toolbar'), 'dsh-frame': frame
      }[id] || null),
      documentElement: { clientWidth: 800 }
    },
    acquireVsCodeApi: () => ({
      postMessage: (msg) => toHost.push(msg),
      setState: () => {},
      getState: () => null
    }),
    setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'workspace-pin-relay.js' });

  function dispatch(data, origin, source) {
    for (const l of winListeners.slice()) {
      if (l.type === 'message') l.fn({ data: Object.assign({ source: PLUGIN_ID }, data), origin, source });
    }
  }

  return {
    html,
    script,
    toHost,
    frameMessages,
    pins: () => frameMessages.filter((x) => x.payload && x.payload.type === 'workspace-pin'),
    fireLoad: () => loadHandlers.forEach((fn) => fn()),
    runTimers: (which) => {
      for (const t of timers.slice()) {
        if (which !== undefined && t.ms !== which) continue;
        const i = timers.findIndex((x) => x.id === t.id);
        if (i >= 0) timers.splice(i, 1);
        try { t.fn(); } catch (e) { console.error(e); }
      }
    },
    fromPlugin: (data) => dispatch(data, DSH_ORIGIN, frame.contentWindow),
    fromEvilOrigin: (data) => dispatch(data, 'http://evil.example.com', frame.contentWindow),
    fromOtherPlugin: (data) => dispatch(Object.assign({ source: 'dsh-vscode-file-links' }, data), DSH_ORIGIN, frame.contentWindow)
  };
}

console.log('[3] 中继脚本：握手、来源校验、超时与结果白名单');
{
  const r = makeRealm({ pinPath: '/mnt/work/proj-b' });
  ok(r.html.includes('workspace-pin'), '面板 HTML 注入 workspace-pin 协议');
  ok(r.html.includes('/mnt/work/proj-b'), '注入当前工作区路径');

  r.fromPlugin({ type: 'hello' });
  const pins = r.pins();
  ok(pins.length === 1 && pins[0].payload.path === '/mnt/work/proj-b', '插件 hello → 下发 workspace-pin（含路径）');
  ok(pins[0].payload.source === HOST_ID, '下发消息带宿主身份标记');

  const evil = makeRealm({ pinPath: '/mnt/work/proj-b' });
  evil.fromEvilOrigin({ type: 'hello' });
  ok(evil.pins().length === 0, 'origin 不符 → 不下发（跨站消息不认）');

  const other = makeRealm({ pinPath: '/mnt/work/proj-b' });
  other.fromOtherPlugin({ type: 'hello' });
  // 同一 iframe 内的 hello 共用一次握手应答（ackFrame）：多发给本插件也无害，
  // 但它不会把别人的消息当成自己的结果。
  ok(other.pins().length === 1, '其它插件的 hello 同样触发下发（同源页面内广播）');
  ok(!other.toHost.some((m) => m.type === 'dsh-workspace-pin-result'), '其它插件的消息不会被当成工作区结果上报');

  const off = makeRealm({ pinPath: null });
  off.fromPlugin({ type: 'hello' });
  ok(off.pins().length === 0, '开关关闭 / 空窗口（无路径）→ 完全不下发');

  const timeout = makeRealm({ pinPath: '/mnt/work/proj-b' });
  timeout.fireLoad();
  timeout.fromPlugin({ type: 'hello' });
  timeout.runTimers(8000);
  ok(timeout.toHost.some((m) => m.type === 'dsh-workspace-pin-unavailable'), '8s 未回执 → 上报「插件未生效」');

  const result = makeRealm({ pinPath: '/mnt/work/proj-b' });
  result.fireLoad();
  result.fromPlugin({ type: 'hello' });
  result.fromPlugin({ type: 'workspace-pin-result', status: 'failed', reason: 'x'.repeat(500) });
  const reported = result.toHost.filter((m) => m.type === 'dsh-workspace-pin-result');
  ok(reported.length === 1 && reported[0].status === 'failed', '插件结果转发给宿主');
  ok(typeof reported[0].reason === 'string' && reported[0].reason.length <= 200, 'reason 截断到 200 字以内');
  result.runTimers(8000);
  ok(!result.toHost.some((m) => m.type === 'dsh-workspace-pin-unavailable'), '已收到结果后不再报超时');

  const bogus = makeRealm({ pinPath: '/mnt/work/proj-b' });
  bogus.fireLoad();
  bogus.fromPlugin({ type: 'hello' });
  bogus.fromPlugin({ type: 'workspace-pin-result', status: 'hacked' });
  ok(!bogus.toHost.some((m) => m.type === 'dsh-workspace-pin-result'), 'status 不在白名单 → 丢弃');

  const win = makeRealm({ pinPath: 'C:\\\\work\\\\proj "quoted"' });
  ok(win.html.includes('workspace-pin'), '含反斜杠/引号的路径仍生成页面');
  let parsed = true;
  try { new vm.Script(win.script); } catch (e) { parsed = false; }
  ok(parsed, '注入脚本可被解析（jsonForScript 未破坏语法）');
  win.fromPlugin({ type: 'hello' });
  ok(win.pins().length === 1 && win.pins()[0].payload.path === 'C:\\\\work\\\\proj "quoted"', '特殊字符路径原样下发');
}

// =====================================================================
// 4. 客户端仿真（vm + 假 ctx）
// =====================================================================
const clientSource = readIfExists(path.join(PLUGIN_DIR, 'lib', 'client.js'));

/**
 * 造一个 DSH 客户端域。
 * @param {{targetPath?:string, mainCwd?:string, ready?:boolean, missing?:string, createThrows?:boolean}} o
 */
function makeClientEnv(o) {
  const opts = o || {};
  const posted = [];
  const timers = [];
  const calls = { create: [], open: [] };
  let timerSeq = 1;

  const win = {
    name: HOST_ID,
    addEventListener: (type, fn) => winListeners.push({ type, fn }),
    removeEventListener: () => {},
    postMessage: (payload) => posted.push(payload),
    setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; },
    setInterval: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
  };
  win.parent = { isParent: true, postMessage: (payload) => posted.push(payload) };
  const winListeners = [];

  const document = { addEventListener() {}, removeEventListener() {} };

  const mainCwd = opts.mainCwd === undefined ? '/mnt/work/proj-a' : opts.mainCwd;
  // 快照阶段可运行时切换：验证「先 loading、后 ready」时插件不会抢跑。
  let phaseState = opts.ready !== false ? 'ready' : 'loading';
  const sessions = {
    list: {
      getSnapshot: () => ({
        phase: phaseState,
        ids: ['s1'],
        byId: { s1: { id: 's1', cwd: mainCwd, retainedBy: { mainView: 1 } } }
      })
    }
  };
  const workspaces = {
    list: { getSnapshot: () => ({ phase: phaseState, items: [] }) },
    create: async (input) => {
      calls.create.push(input);
      if (opts.createThrows) throw new Error('workspace/create 失败：目录不存在');
      return { workspaceId: 'ws-b', path: input.path, created: true };
    }
  };
  const uiWorkspace = {
    openWorkspace: async (id) => { calls.open.push(id); }
  };

  const ctx = { effect: (fn) => { fn(); } };
  if (opts.missing !== 'workspaces') ctx.workspaces = workspaces;
  if (opts.missing !== 'uiWorkspace') ctx.uiWorkspace = uiWorkspace;
  ctx.sessions = sessions;

  const sandbox = { window: win, document, console, Promise };
  vm.createContext(sandbox);
  let pluginExports = null;
  sandbox.window.__ModuleLoader__ = { load: ({ id, factory }) => { pluginExports = factory(() => {}); } };
  if (clientSource) vm.runInContext(clientSource, sandbox, { filename: 'dsh-vscode-workspace/client.js' });
  if (pluginExports) pluginExports.apply(ctx);

  function hostMessage(data, source) {
    const event = { source: source === undefined ? win.parent : source, data: Object.assign({ source: HOST_ID }, data) };
    for (const l of winListeners.slice()) if (l.type === 'message') l.fn(event);
  }
  function runTimers(which) {
    for (const t of timers.slice()) {
      if (which !== undefined && t.ms !== which) continue;
      const i = timers.findIndex((x) => x.id === t.id);
      if (i >= 0) timers.splice(i, 1);
      try { t.fn(); } catch (e) { console.error(e); }
    }
  }
  return { posted, calls, hostMessage, runTimers, markReady: () => { phaseState = 'ready'; } };
}

/** 推进微任务 + 轮询定时器，让插件的异步流程落地。 */
async function settle(env) {
  for (let i = 0; i < 6; i += 1) {
    env.runTimers(200);
    await new Promise((r) => setImmediate(r));
  }
}

(async function run() {
  console.log('[4] 客户端仿真：握手、切换、失败可见');
  {
    const idle = makeClientEnv({});
    ok(idle.posted.some((m) => m.type === 'hello'), '插件主动打招呼（hello）');
    ok(idle.calls.create.length === 0 && idle.calls.open.length === 0, '未握手前完全不动作（不注册、不切换）');

    const env = makeClientEnv({});
    env.hostMessage({ type: 'workspace-pin', path: '/mnt/work/proj-b' });
    await settle(env);
    ok(env.calls.create.length === 1 && env.calls.create[0].path === '/mnt/work/proj-b', '握手后按宿主路径注册工作区（幂等 create）');
    ok(env.calls.open.length === 1 && env.calls.open[0] === 'ws-b', '注册成功后切到该工作区');
    ok(env.posted.some((m) => m.type === 'workspace-pin-result' && m.status === 'done'), '回报 done');

    const already = makeClientEnv({ mainCwd: '/mnt/work/proj-b' });
    already.hostMessage({ type: 'workspace-pin', path: '/mnt/work/proj-b' });
    await settle(already);
    ok(already.calls.open.length === 0, '主视图已在该工作区 → 不切换（不新建多余会话）');
    ok(already.calls.create.length === 0, '主视图已在该工作区 → 连注册都不必做');
    ok(already.posted.some((m) => m.type === 'workspace-pin-result' && m.status === 'already'), '回报 already');

    const noUi = makeClientEnv({ missing: 'uiWorkspace' });
    noUi.hostMessage({ type: 'workspace-pin', path: '/mnt/work/proj-b' });
    await settle(noUi);
    ok(noUi.posted.some((m) => m.type === 'workspace-pin-result' && m.status === 'unsupported'), '服务缺失 → 上报 unsupported（旧版 dsh）');
    ok(noUi.calls.create.length === 0, '服务缺失时不尝试注册');

    const failing = makeClientEnv({ createThrows: true });
    failing.hostMessage({ type: 'workspace-pin', path: '/mnt/work/proj-b' });
    await settle(failing);
    const failed = failing.posted.filter((m) => m.type === 'workspace-pin-result' && m.status === 'failed');
    ok(failed.length === 1, '注册失败 → 上报 failed（不抛到页面）');
    ok(typeof failed[0].reason === 'string' && failed[0].reason.length > 0, '失败带原因文本');

    const slow = makeClientEnv({ ready: false });
    slow.hostMessage({ type: 'workspace-pin', path: '/mnt/work/proj-b' });
    ok(slow.calls.create.length === 0, 'DSH 快照未就绪时不抢跑');
    await settle(slow);
    ok(slow.calls.create.length === 0, '仍未就绪 → 继续等待（不放弃、不乱切）');
    slow.markReady();
    await settle(slow);
    ok(slow.calls.create.length === 1, '就绪后再注册（轮询等待，而不是放弃）');

    const dup = makeClientEnv({});
    dup.hostMessage({ type: 'workspace-pin', path: '/mnt/work/proj-b' });
    dup.hostMessage({ type: 'workspace-pin', path: '/mnt/work/proj-b' });
    await settle(dup);
    ok(dup.calls.create.length === 1 && dup.calls.open.length === 1, '重复下发只执行一次（幂等）');

    const spoof = makeClientEnv({});
    spoof.hostMessage({ type: 'workspace-pin', path: '/mnt/work/proj-b' }, { isParent: false });
    await settle(spoof);
    ok(spoof.calls.create.length === 0, '非父级窗口下发的路径不认（来源校验）');

    const badPath = makeClientEnv({});
    badPath.hostMessage({ type: 'workspace-pin', path: 'x'.repeat(5000) });
    await settle(badPath);
    ok(badPath.calls.create.length === 0, '非法路径（超长）不动作');
  }

  // =====================================================================
  // 5. 宿主安装
  // =====================================================================
  console.log('[5] 宿主安装：落盘 / 登记 / 幂等');
  {
    ok(typeof I.ensureWorkspacePlugin === 'function', 'ensureWorkspacePlugin 可测');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-profile-'));
    const changed = await I.ensureWorkspacePlugin(profile);
    ok(changed === true, '首次安装报告「已变更」（需重启 dsh web 生效）');
    const base = path.join(profile, 'node_modules', PLUGIN);
    ok(fs.existsSync(path.join(base, 'lib', 'client.js')) && fs.existsSync(path.join(base, 'cordis.patch.yml')), '插件文件落盘到 web profile');
    const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
    ok((pkg.dsh.profile.bundles || []).includes(PLUGIN), '登记到 dsh.profile.bundles');
    ok(!pkg.dependencies || !pkg.dependencies[PLUGIN], '不写入 dependencies（npm 上没有该包）');
    ok((await I.ensureWorkspacePlugin(profile)) === false, '版本一致 → 幂等（不重复写盘）');
  }

  console.log(`\n全部通过：${passed} 项断言 ✓`);
})().catch((e) => { console.error(e); process.exit(1); });
