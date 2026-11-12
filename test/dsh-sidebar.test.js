'use strict';
/**
 * 面板内隐藏/显示 DSH 左侧栏（spec 004）回归测试。
 * 运行：node test/dsh-sidebar.test.js
 *
 * 覆盖：
 *  1) 面板结构：工具条按钮 + stage/clip 分层，裁剪量与缩放解耦；
 *  2) 初始策略 auto/show/hide × 宽度 → 隐藏与否；
 *  3) 测量消费：280/420/56/0、`+4` 手柄余量、异常值丢弃；
 *  4) 按钮与宿主消息：切换、持久化上报、配置变更、未测量时不裁剪并上报；
 *  5) 内置测量插件：文件齐全/语法/声明、安装幂等、`show` 策略不安装；
 *  6) 插件客户端仿真：握手前静默、握手后上报、变化重报、折叠标记。
 *
 * spec 015（dsh 0.2.2 抽屉态回归）新增：
 *  7) 收敛扫描：真实中继 + 真实插件按 dsh 0.2.2 布局模型迭代「视口 = 面板宽 + crop」，
 *     全宽度无 2-周期振荡、收敛值分段 0/56/284、裁剪永不超过侧栏占位（不切对话区）；
 *  8) 抽屉态中继：轨道 0 不裁剪、按钮/命令转调 `layout-toggle`、不写手动覆盖、回执补发
 *     `request-layout`、失败透传 `dsh-sidebar-toggle-failed`、缺 `drawer` 字段走 004 老语义；
 *  9) 插件侧：grid 首轨优先测量（矩形 280 不算数）+ 矩形回退、`drawer` 上报、转调
 *     （未握手/非抽屉/服务缺失/抛错四种出口）；
 * 10) 扩展宿主：转调失败提示每窗口一次 + reason 白名单。
 *
 * spec 016（拖动/缩放残留闪烁 + 诊断日志）新增：
 * 11) 插件诊断环形日志（形状/上限/clear）、`innerWidth` 上报、翻转风暴自动取证与 10s 限流；
 * 12) 缩放实测校准：crop = round((轨道+手柄余量) × ratio)，ratio 缺失/越界回退 1，抽屉态仍 0；
 * 13) auto 策略拖动去抖：150ms 静默后按最终宽度只翻一次，覆盖/show 不参与；
 * 14) 诊断链路：layout-diag 合并宿主日志上报、导出请求 600ms 合并/超时兜底、ratio 回退留痕；
 * 15) 扩展宿主：normalizeSidebarDiag 白名单净化、输出面板写入、状态栏一次提示、命令与兜底文案；
 * 16) 收敛扫描扩到 4 档缩放比例（0.75/0.875/1/1.25）仍无 2-周期、分段期望 round(轨道×s)。
 *
 * spec 017（手动选择跨断点保持）新增：
 * 17) 抽屉态点「显示/隐藏」同时写覆盖（dsh-sidebar-state）并同步页面内 sidebarOverride；
 *     拉宽到 900/1200 后仍按用户选择（不再被 auto/去抖重算冲掉），拉回抽屉态展示仍按 collapsed；
 *     grid 态手动显示后拖动同样保持。
 *
 * spec 018（调试日志落盘）新增：
 * 18) dshPanel.debugLogToFile 默认关（不建文件）、开启后诊断包与事件写入
 *     <HOME>/.dsh-debug/dsh-vscode-debug.log、落盘前 token 脱敏、超 2MB 轮转 .log.1、
 *     命令「打开调试日志」打开/给开启指引、目录不可写时提示一次且不影响输出面板。
 *
 * spec 019（事件流自动落盘）新增：
 * 19) 关闭时零开销（不建队列/不起定时器/不发消息）、开启后按批（1s、单包 ≤200）推送
 *     layout/recompute 等现场并一次追加到文件、热开关立即生效、条目白名单净化、[env] 环境行。
 *
 * spec 020（比例配对）新增：
 * 20) 缩放比例只在「request-layout 应答 + 面板宽未变」时采信；自发上报/拖动中的样本作废，
 *     沿用上次可信值（初始 1），避免把拖动幅度误算成比例；字号变化后重校。
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
// 扩展侧状态栏提示捕获（spec 015 AC-4：转调失败提示要能被断言）。
const statusBarMessages = [];
// spec 016：信息提示、输出面板、命令注册捕获（诊断导出链路要能被断言）。
const infoMessages = [];
const outputChannels = [];
const registeredCmds = {};
let profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sidebar-'));
process.env.DSH_HOME = profileRoot;
// 调试日志落盘（spec 018/021）用到 os.homedir()：测试里把它指到临时目录。
// 注意 Windows 的 os.homedir() 读 USERPROFILE（不是 HOME）——两个都设，CI 的 windows 矩阵才稳。
function setTestHome(dir) {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}
setTestHome(profileRoot);
const shownDocs = [];
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (Object.prototype.hasOwnProperty.call(config, k) ? config[k] : d) }),
    workspaceFolders: []
  },
  env: { remoteName: undefined },
  window: {
    showWarningMessage: async (m) => { infoMessages.push(m); return undefined; },
    showInformationMessage: async (m) => { infoMessages.push(m); return undefined; },
    showErrorMessage: async (m) => { infoMessages.push(m); return undefined; },
    setStatusBarMessage: (text, ms) => { statusBarMessages.push({ text, ms }); return { dispose() {} }; },
    showTextDocument: async (uri) => { shownDocs.push(uri); return {}; },
    createOutputChannel: (name) => {
      const ch = {
        name,
        lines: [],
        shown: 0,
        appendLine(s) { this.lines.push(String(s)); },
        show() { this.shown += 1; },
        clear() { this.lines = []; }
      };
      outputChannels.push(ch);
      return ch;
    }
  },
  commands: {
    registerCommand: (id, fn) => { registeredCmds[id] = fn; return { dispose() {} }; }
  },
  Uri: {
    parse: (u) => ({ toString: () => u }),
    file: (p) => ({ fsPath: p, path: p, toString: () => p })
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
const PLUGIN_SOURCE = 'dsh-vscode-layout';

/** 构造一个「webview 域」：跑真实中继脚本 + 假 DOM。 */
function makeRealm(opts) {
  const o = opts || {};
  const html = I.buildIframeHtml(DSH_ORIGIN, o.scale || 1, o.mode || 'revealAndOpen', {
    policy: o.policy || 'auto',
    override: o.override === undefined ? null : o.override
  }, undefined, o.debug === true);
  const m = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html);
  const script = m ? m[1] : '';

  const toHost = [];
  const frameMessages = [];
  const states = [];
  const loadHandlers = [];
  const winListeners = [];
  const clickHandlers = [];
  const timers = [];
  let timerSeq = 1;

  function el(id) {
    return {
      id,
      style: {
        values: {},
        setProperty(k, v) { this.values[k] = v; },
        getPropertyValue(k) { return this.values[k] || ''; },
        set cssText(v) { this.values.__cssText = v; },
        get cssText() { return this.values.__cssText || ''; }
      },
      clientWidth: o.width === undefined ? 800 : o.width,
      clientHeight: 600,
      isConnected: true,
      className: '',
      textContent: '',
      title: '',
      dataset: {},
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(type, fn) { if (id === 'dsh-sidebar-toggle' && type === 'click') clickHandlers.push(fn); },
      appendChild() {},
      contentWindow: null
    };
  }

  const stage = el('dsh-stage');
  const clip = el('dsh-clip');
  const button = el('dsh-sidebar-toggle');
  const toolbar = el('dsh-toolbar');
  const frame = el('dsh-frame');
  frame.contentWindow = { postMessage: (payload, origin) => frameMessages.push({ payload, origin }) };
  // iframe 实宽（webview px）= clip 宽 = **当前** stage 宽 + 裁剪量 —— spec 016 实测 ratio 的分子。
  frame.getBoundingClientRect = function () {
    const c = parseInt(clip.style.getPropertyValue('--dsh-crop'), 10);
    const base = typeof stage.clientWidth === 'number' ? stage.clientWidth : (o.width === undefined ? 800 : o.width);
    return { width: base + (Number.isFinite(c) ? c : 0), height: 600 };
  };
  const frameLoadHandlers = [];
  frame.addEventListener = (type, fn) => { if (type === 'load') frameLoadHandlers.push(fn); };

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
        'dsh-stage': stage, 'dsh-clip': clip, 'dsh-sidebar-toggle': button, 'dsh-toolbar': toolbar, 'dsh-frame': frame
      }[id] || null),
      documentElement: { clientWidth: o.width === undefined ? 800 : o.width }
    },
    acquireVsCodeApi: () => ({
      postMessage: (msg) => toHost.push(msg),
      setState: (s) => states.push(s),
      getState: () => null
    }),
    setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'dsh-sidebar-relay.js' });

  return {
    html,
    stage,
    clip,
    button,
    toolbar,
    toHost,
    frameMessages,
    states,
    crop: () => clip.style.getPropertyValue('--dsh-crop') || '',
    fireLoad: () => frameLoadHandlers.forEach((fn) => fn()),
    /** 模拟拖动 VS Code 侧边栏：改 stage 宽并派发 window.resize（spec 016 AC-6）。 */
    resize: (w) => {
      stage.clientWidth = w;
      sandbox.document.documentElement.clientWidth = w;
      winListeners.filter((l) => l.type === 'resize').forEach((l) => l.fn());
    },
    /** 模拟重置计时器：只跑当前排队的定时器。 */
    runTimers: () => { for (const t of timers.splice(0)) { try { t.fn(); } catch (e) { console.error(e); } } },
    click: () => clickHandlers.forEach((fn) => fn({ preventDefault() {} })),
    fromPlugin: (data) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data: Object.assign({ source: PLUGIN_SOURCE }, data),
      origin: DSH_ORIGIN,
      source: frame.contentWindow
    })),
    fromHost: (data) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data, origin: 'vscode-webview://x', source: null
    })),
    fromEvil: (data) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      data: Object.assign({ source: PLUGIN_SOURCE }, data), origin: 'http://evil.example.com', source: frame.contentWindow
    }))
  };
}

/**
 * 上报一次测量。
 * @param {object} realm 中继域
 * @param {number} sidebarWidth grid 首轨道宽（DSH px）
 * @param {boolean} collapsed 折叠态
 * @param {boolean|undefined} drawer dsh 0.2.2+ 抽屉态标志（缺省 = 旧插件）
 * @param {number|undefined} innerWidth 页面视口（DSH px，spec 016 用于实测 ratio；缺省 = 旧插件）
 */
function report(realm, sidebarWidth, collapsed, drawer, innerWidth) {
  const data = { type: 'layout', sidebarWidth, collapsed: !!collapsed };
  if (drawer !== undefined) data.drawer = drawer === true;
  if (innerWidth !== undefined) data.innerWidth = innerWidth;
  realm.fromPlugin(data);
}

(async function run() {
  console.log('[1] 面板结构：工具条 + stage/clip 分层（裁剪与缩放解耦）');
  {
    const r = makeRealm({ policy: 'auto', width: 800 });
    ok(/id="dsh-stage"/.test(r.html), '存在 stage 容器（overflow 裁剪层）');
    ok(/id="dsh-clip"/.test(r.html), '存在 clip 容器（承载负偏移与加宽）');
    ok(/id="dsh-sidebar-toggle"/.test(r.html), '工具条内含切换按钮');
    ok(/aria-label="隐藏 DSH 侧栏"/.test(r.html), '按钮初始 aria-label 为「隐藏」');
    ok(/--dsh-crop/.test(r.html) && /zoom:1;/.test(r.html), 'crop 由 CSS 变量驱动，缩放仍只作用于 iframe');
    ok(/#dsh-frame\{[^}]*width:100%/.test(r.html.replace(/\s+/g, '')) || /#dsh-frame\{[^}]*width:100%/.test(r.html), 'iframe 宽度保持 100%（不参与裁剪计算）');
    const show = makeRealm({ policy: 'show', width: 800 });
    ok(!/id="dsh-sidebar-toggle"/.test(show.html), 'policy=show 且无手动覆盖 → 不渲染工具条（零干预）');
  }

  console.log('[2] 初始策略：auto/show/hide × 宽度');
  {
    const narrow = makeRealm({ policy: 'auto', width: 800 });
    ok(narrow.button.getAttribute('aria-label') === '显示 DSH 侧栏', 'auto + 窄容器（800）→ 默认隐藏');

    const wide = makeRealm({ policy: 'auto', width: 1200 });
    ok(wide.button.getAttribute('aria-label') === '隐藏 DSH 侧栏', 'auto + 宽容器（1200）→ 默认显示');

    const hide = makeRealm({ policy: 'hide', width: 1400 });
    ok(hide.button.getAttribute('aria-label') === '显示 DSH 侧栏', 'hide 策略无视宽度 → 隐藏');

    const showOverride = makeRealm({ policy: 'show', override: true, width: 1400 });
    ok(!!showOverride.button, 'show + 手动覆盖 → 仍渲染工具条（可撤销）');
    ok(showOverride.button.getAttribute('aria-label') === '显示 DSH 侧栏', '手动覆盖优先于配置');
  }

  console.log('[3] 测量消费：宽度、折叠与手柄余量');
  {
    const r = makeRealm({ policy: 'hide', width: 900 });
    ok(r.crop() === '0px', '尚无测量 → 不裁剪（宁可不隐藏也不切内容）');
    report(r, 280, false);
    ok(r.crop() === '284px', '展开 280 → 裁剪 284（+4 手柄余量）');
    report(r, 420, false);
    ok(r.crop() === '424px', '拖动到 420 → 424');
    report(r, 264, false);
    ok(r.crop() === '268px', '拖动到 264 → 268');
    report(r, 56, true);
    ok(r.crop() === '56px', '折叠态 56 → 56（无手柄，不加余量）');
    report(r, 0, true);
    ok(r.crop() === '0px', '侧栏宽度 0 → 不裁剪');
    report(r, 2000, false);
    ok(r.crop() === '0px', '超范围测量值被丢弃（保持上一次有效值 0）');
    report(r, NaN, false);
    report(r, '280', false);
    ok(r.crop() === '0px', '非数值测量值被丢弃');

    const shown = makeRealm({ policy: 'show', width: 1200 });
    report(shown, 280, false);
    ok(shown.crop() === '0px', '显示态忽略测量（不产生裁剪）');

    const evil = makeRealm({ policy: 'hide', width: 900 });
    evil.fromEvil({ type: 'layout', sidebarWidth: 280, collapsed: false });
    ok(evil.crop() === '0px', 'origin 不符的测量被丢弃');
  }

  console.log('[4] 按钮、持久化与宿主消息');
  {
    const r = makeRealm({ policy: 'hide', width: 900 });
    report(r, 280, false);
    ok(r.crop() === '284px', '隐藏态已裁剪');
    r.click();
    ok(r.crop() === '0px', '点按钮 → 立即显示（不重载 iframe）');
    ok(r.button.getAttribute('aria-label') === '隐藏 DSH 侧栏', '按钮 aria-label 随状态切换');
    const st = r.toHost.filter((m) => m.type === 'dsh-sidebar-state');
    ok(st.length === 1 && st[0].hidden === false && st[0].reason === 'user', '手动切换上报 hidden=false + reason=user');
    r.click();
    ok(r.crop() === '284px', '再点一次 → 重新隐藏');

    const host = makeRealm({ policy: 'show', width: 1200 });
    host.fromHost({ type: 'dsh-sidebar-toggle' });
    ok(host.button.getAttribute('aria-label') === '显示 DSH 侧栏', '宿主命令（toggle）可翻转状态');

    const cfg = makeRealm({ policy: 'hide', width: 1200 });
    report(cfg, 280, false);
    ok(cfg.crop() === '284px', '配置 hide 生效');
    cfg.fromHost({ type: 'dsh-sidebar-config', policy: 'show' });
    ok(cfg.crop() === '0px', '配置改为 show → 立即显示并清除覆盖效果');
    ok(cfg.button.getAttribute('aria-label') === '隐藏 DSH 侧栏', '配置变更后按钮状态同步');

    const cfgAuto = makeRealm({ policy: 'hide', width: 900 });
    cfgAuto.fromHost({ type: 'dsh-sidebar-config', policy: 'auto' });
    ok(cfgAuto.button.getAttribute('aria-label') === '显示 DSH 侧栏', 'auto 回落到宽度判定（900 → 隐藏）');
  }

  console.log('[5] 未测量不静默：上报 unavailable 且不裁剪');
  {
    const r = makeRealm({ policy: 'hide', width: 900 });
    ok(r.toHost.filter((m) => m.type === 'dsh-sidebar-unavailable').length === 0, '初始不立即误报');
    r.runTimers();
    const msgs = r.toHost.filter((m) => m.type === 'dsh-sidebar-unavailable');
    ok(msgs.length === 1, '等待期后仍无测量 → 上报一次 unavailable');
    ok(r.crop() === '0px', '未测量时不裁剪');
    report(r, 280, false);
    r.runTimers();
    ok(r.toHost.filter((m) => m.type === 'dsh-sidebar-unavailable').length === 1, '后续测量到位不重复上报');
  }

  console.log('[6] 内置测量插件：文件、声明与安装幂等');
  const pluginDir = path.join(__dirname, '..', 'dsh-plugins', PLUGIN_SOURCE);
  {
    const rels = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js'];
    for (const rel of rels) ok(fs.existsSync(path.join(pluginDir, rel)), '插件文件存在：' + rel);

    const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
    ok(pkg.name === PLUGIN_SOURCE && typeof pkg.version === 'string', 'package.json 名称与版本正确');
    ok(pkg.type === 'module' && pkg.main === 'lib/index.js', 'ESM 宿主半区声明正确');
    ok(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', '声明 web 客户端半区');
    ok(!pkg.dependencies, '不声明 dependencies（npm 上没有该包）');

    const yml = fs.readFileSync(path.join(pluginDir, 'cordis.patch.yml'), 'utf8');
    ok(/-\s*insert:/.test(yml) && yml.includes("name: '" + PLUGIN_SOURCE + "'"), 'cordis.patch.yml 的 insert 名称与包名一致');

    for (const rel of ['lib/index.js', 'lib/client.js']) {
      const r = spawnSync(process.execPath, ['--check', path.join(pluginDir, rel)], { encoding: 'utf8' });
      ok(r.status === 0, '语法真实通过：' + rel);
    }

    config['dshPanel.dshSidebar'] = 'auto';
    const profile = path.join(profileRoot, 'profiles', 'web');
    ok(I.shouldInstallLayoutPlugin() === true, 'auto 策略下需要测量插件');
    ok((await I.ensureLayoutPlugin(profile)) === true, '首次安装写盘（返回 true）');
    ok(fs.existsSync(path.join(profile, 'node_modules', PLUGIN_SOURCE, 'lib', 'client.js')), '插件文件落到 dsh web profile');
    const profilePkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
    ok((profilePkg.dsh.profile.bundles || []).includes(PLUGIN_SOURCE), '登记到 dsh.profile.bundles');
    ok(!profilePkg.dependencies || !profilePkg.dependencies[PLUGIN_SOURCE], '不写入 dependencies');
    ok((await I.ensureLayoutPlugin(profile)) === false, '版本一致 → 幂等（不重复写盘）');

    config['dshPanel.dshSidebar'] = 'show';
    ok(I.shouldInstallLayoutPlugin() === false, 'show 策略下不安装测量插件（零干预）');
    config['dshPanel.dshSidebar'] = 'auto';
  }

  console.log('[7] 插件客户端仿真：握手与测量上报');
  {
    const clientSource = fs.readFileSync(path.join(pluginDir, 'lib', 'client.js'), 'utf8');
    const env = makePluginEnv({ width: 280, collapsed: false });
    vm.runInContext(clientSource, env.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    env.apply();
    ok(layouts(env).length === 0, '未握手前不上报（只有 hello）');

    env.ack();
    env.flush();
    ok(layouts(env).length >= 1, '握手后上报测量');
    const first = layouts(env)[layouts(env).length - 1];
    ok(first.type === 'layout' && first.sidebarWidth === 280 && first.collapsed === false, '上报字段：sidebarWidth / collapsed');

    env.setWidth(420);
    env.flush();
    const afterDrag = layouts(env)[layouts(env).length - 1];
    ok(afterDrag.sidebarWidth === 420, '用户拖动侧栏 → 上报新宽度');

    env.setCollapsed(true);
    env.setWidth(56);
    env.flush();
    const collapsed = layouts(env)[layouts(env).length - 1];
    ok(collapsed.sidebarWidth === 56 && collapsed.collapsed === true, '折叠 → 上报 56 且 collapsed=true');

    env.dispose();
    const count = layouts(env).length;
    env.setWidth(300);
    env.flush();
    ok(layouts(env).length === count, '卸载后不再上报（不残留定时器/观察器）');
  }

  console.log('[8] 插件客户端：元素缺失时不报错、不误报');
  {
    const clientSource = fs.readFileSync(path.join(pluginDir, 'lib', 'client.js'), 'utf8');
    const env = makePluginEnv({ missing: true });
    vm.runInContext(clientSource, env.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    env.apply();
    env.ack();
    env.flush();
    ok(layouts(env).length === 0, '找不到侧栏元素 → 不上报（由宿主提示不可用）');
    env.dispose();
  }

  console.log('[9] 收敛扫描：裁剪 ↔ 视口固定点不振荡（spec 015 AC-6，复现用例）');
  {
    const src = fs.readFileSync(path.join(pluginDir, 'lib', 'client.js'), 'utf8');
    const failures = [];
    const crops = [];
    for (let stage = 240; stage <= 1400; stage += 8) {
      const r = runCropLoop(stage, src);
      if (!r.ok) failures.push('stage=' + stage + ' ' + r.detail);
      crops.push({ stage, crop: r.crop });
    }
    ok(failures.length === 0,
      '全宽度扫描 240–1400 收敛且无 2-周期（首个失败：' + (failures[0] || '无') + '）');
    // 期望分段：auto 策略下 ≥1024 不裁；抽屉(<768) 轨道 0；导轨 [768,968) 56；宽屏起点 968 → 280+4。
    const seg = (s) => (s >= 1024 ? 0 : s < 768 ? 0 : s < 968 ? 56 : 284);
    const mismatch = crops.filter((c) => c.crop !== seg(c.stage))
      .map((c) => c.stage + '→' + c.crop + '≠' + seg(c.stage));
    ok(mismatch.length === 0, '收敛值分段正确 0/56/284（首个不符：' + (mismatch[0] || '无') + '）');
    const cut = crops.filter((c) => c.crop > 4 && c.stage < 768);
    ok(cut.length === 0, '抽屉段（<768）裁剪恒 0，对话区左缘不被移动（首个违例：'
      + (cut[0] ? cut[0].stage + '→' + cut[0].crop : '无') + '）');
  }

  console.log('[10] 中继：抽屉态不裁剪、按钮转调、回执与老语义回退（AC-2/3/4/5）');
  {
    const r = makeRealm({ policy: 'auto', width: 500 });
    report(r, 0, false, true);
    ok(r.crop() === '0px', 'AC-2 抽屉展开：上报轨道 0 → 裁剪 0px');
    ok(r.button.getAttribute('aria-label') === '隐藏 DSH 侧栏', 'AC-3 抽屉展开 → 按钮「隐藏 DSH 侧栏」');
    report(r, 0, true, true);
    ok(r.crop() === '0px', 'AC-2 抽屉收起：同样 0px（侧栏本已在视口外，不重复隐藏）');
    ok(r.button.getAttribute('aria-label') === '显示 DSH 侧栏', 'AC-3 抽屉收起 → 按钮「显示 DSH 侧栏」');
    r.click();
    const toggles = () => r.frameMessages.filter((m) => m.payload && m.payload.type === 'layout-toggle');
    ok(toggles().length === 1 && toggles()[0].payload.source === 'dsh-vscode-host', 'AC-3 点按钮 → 向 iframe 发 layout-toggle');
    const st10 = r.toHost.filter((m) => m.type === 'dsh-sidebar-state');
    ok(st10.length === 1 && st10[0].hidden === false && st10[0].reason === 'user',
      'AC-3 抽屉态点「显示」同时写覆盖 hidden=false（017 修订）');
    ok(r.crop() === '0px', 'AC-3 转调不改变裁剪量');
    r.fromHost({ type: 'dsh-sidebar-toggle' });
    ok(toggles().length === 2, 'AC-3 宿主命令 dsh-sidebar-toggle 同样转调');
    r.fromPlugin({ type: 'layout-toggle-result', ok: true });
    ok(r.frameMessages.some((m) => m.payload && m.payload.type === 'request-layout'), 'AC-4 收到回执补发 request-layout（按钮状态自愈）');
    r.fromPlugin({ type: 'layout-toggle-result', ok: false, reason: 'unsupported' });
    const failed = r.toHost.filter((m) => m.type === 'dsh-sidebar-toggle-failed');
    ok(failed.length === 1 && failed[0].reason === 'unsupported', 'AC-4 转调失败上报宿主（reason 透传）');

    // AC-5：旧插件上报缺 drawer 字段 → 必须保持 004 老语义（按宽度裁剪 + 覆盖持久化）。
    const old = makeRealm({ policy: 'auto', width: 500 });
    report(old, 280, false);
    ok(old.crop() === '284px', 'AC-5 缺 drawer 字段 → 仍按宽度裁剪（老语义不回退）');
    old.click();
    ok(old.frameMessages.filter((m) => m.payload && m.payload.type === 'layout-toggle').length === 0, 'AC-5 老语义下点按钮仍是裁剪切换');
    ok(old.toHost.filter((m) => m.type === 'dsh-sidebar-state').length === 1, 'AC-5 老语义照常写覆盖');
  }

  console.log('[11] 插件：轨道优先测量、drawer 上报、转调四种出口（AC-1/3/4/5）');
  {
    // AC-1：抽屉态 grid 首轨 0、侧栏矩形 280 → 报 0 + drawer=true。
    const envDrawer = makePluginEnv({ width: 280, collapsed: false, grid: '0px 400px 400px', drawer: true });
    vm.runInContext(clientSource(), envDrawer.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    envDrawer.apply(); envDrawer.ack(); envDrawer.flush();
    const dr = layouts(envDrawer)[layouts(envDrawer).length - 1];
    ok(dr && dr.sidebarWidth === 0 && dr.drawer === true, 'AC-1 抽屉态报轨道 0 + drawer=true（矩形 280 不算数）');
    envDrawer.dispose();

    // AC-5：grid 计算值不可解析 → 回退 004 老口径（矩形），drawer 缺省 false。
    const envFb = makePluginEnv({ width: 420, collapsed: false, grid: '' });
    vm.runInContext(clientSource(), envFb.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    envFb.apply(); envFb.ack(); envFb.flush();
    const fb = layouts(envFb)[layouts(envFb).length - 1];
    ok(fb && fb.sidebarWidth === 420 && fb.drawer === false, 'AC-5 grid 不可解析 → 回退矩形上报、drawer=false');
    envFb.dispose();

    // AC-3：抽屉态转调恰一次并回执 ok。
    let toggled = 0;
    const envT = makePluginEnv({ width: 280, collapsed: true, grid: '0px 400px 400px', drawer: true,
      ctx: { layout: { toggleSidebar: () => { toggled += 1; } } } });
    vm.runInContext(clientSource(), envT.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    envT.apply(); envT.ack(); envT.flush();
    envT.fromHost({ type: 'layout-toggle' }); envT.flush();
    ok(toggled === 1, 'AC-3 收到 layout-toggle → 调 ctx.layout.toggleSidebar 恰一次');
    ok(envT.reports.some((m) => m.type === 'layout-toggle-result' && m.ok === true), 'AC-3 成功回执 ok:true');
    envT.dispose();
    envT.fromHost({ type: 'layout-toggle' }); envT.flush();
    ok(toggled === 1, 'AC-3 卸载后不再响应转调');

    // 未握手：不转调、不回执（三条底线之一）。
    const envN = makePluginEnv({ width: 280, collapsed: true, grid: '0px 400px 400px', drawer: true,
      ctx: { layout: { toggleSidebar: () => { toggled += 100; } } } });
    vm.runInContext(clientSource(), envN.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    envN.apply();
    envN.fromHost({ type: 'layout-toggle' }); envN.flush();
    ok(toggled === 1 && !envN.reports.some((m) => m.type === 'layout-toggle-result'), 'AC-3 未握手不转调、不回执');
    envN.dispose();

    // 非抽屉态（竞态）：not-drawer，不转调。
    const envG = makePluginEnv({ width: 280, collapsed: false, grid: '280px 400px 400px', drawer: false,
      ctx: { layout: { toggleSidebar: () => { toggled += 100; } } } });
    vm.runInContext(clientSource(), envG.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    envG.apply(); envG.ack(); envG.flush();
    envG.fromHost({ type: 'layout-toggle' }); envG.flush();
    const nd = envG.reports.filter((m) => m.type === 'layout-toggle-result')[0];
    ok(toggled === 1 && nd && nd.ok === false && nd.reason === 'not-drawer', 'AC-4 非抽屉态 → not-drawer 不转调');
    envG.dispose();

    // 服务缺失：unsupported（回退出口）。
    const envU = makePluginEnv({ width: 280, collapsed: true, grid: '0px 400px 400px', drawer: true, ctx: {} });
    vm.runInContext(clientSource(), envU.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    envU.apply(); envU.ack(); envU.flush();
    envU.fromHost({ type: 'layout-toggle' }); envU.flush();
    const un = envU.reports.filter((m) => m.type === 'layout-toggle-result')[0];
    ok(un && un.ok === false && un.reason === 'unsupported', 'AC-4 服务缺失 → unsupported');
    envU.dispose();

    // 服务抛错：failed。
    const envF = makePluginEnv({ width: 280, collapsed: true, grid: '0px 400px 400px', drawer: true,
      ctx: { layout: { toggleSidebar: () => { throw new Error('boom'); } } } });
    vm.runInContext(clientSource(), envF.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    envF.apply(); envF.ack(); envF.flush();
    envF.fromHost({ type: 'layout-toggle' }); envF.flush();
    const fl = envF.reports.filter((m) => m.type === 'layout-toggle-result')[0];
    ok(fl && fl.ok === false && fl.reason === 'failed', 'AC-4 服务抛错 → failed');
    envF.dispose();
  }

  console.log('[12] 扩展宿主：转调失败提示每窗口一次 + reason 白名单（AC-4）');
  {
    statusBarMessages.length = 0;
    I.handleWebviewMessage({ type: 'dsh-sidebar-toggle-failed', reason: 'unsupported' }, null);
    ok(statusBarMessages.length === 1
      && /重启 dsh web/.test(statusBarMessages[0].text)
      && /升级 dsh/.test(statusBarMessages[0].text), 'unsupported → 状态栏中文提示含出口动作');
    I.handleWebviewMessage({ type: 'dsh-sidebar-toggle-failed', reason: 'unsupported' }, null);
    ok(statusBarMessages.length === 1, '同类提示每窗口一次，不刷屏');
    I.handleWebviewMessage({ type: 'dsh-sidebar-toggle-failed', reason: 'failed' }, null);
    ok(statusBarMessages.length === 2 && /返回错误/.test(statusBarMessages[1].text), 'failed 有独立文案（不同失败不互相掩盖）');
    I.handleWebviewMessage({ type: 'dsh-sidebar-toggle-failed', reason: 'weird' }, null);
    ok(statusBarMessages.length === 2, '非法 reason 整条丢弃');
  }

  console.log('[13] 插件诊断日志、innerWidth 上报与翻转风暴取证（016 AC-1/AC-2/AC-4）');
  {
    const src = clientSource();

    // AC-1：环形日志形状、关键字段与上限。
    const env = makePluginEnv({ width: 280, collapsed: false, grid: '280px 400px 400px', innerWidth: 1000 });
    vm.runInContext(src, env.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    env.apply(); env.ack(); env.flush();
    const api = env.sandbox.window.__dshVscodeLayout;
    ok(api && typeof api.logs === 'function' && typeof api.clear === 'function' && typeof api.diag === 'function',
      'AC-1 暴露 __dshVscodeLayout.{logs,clear,diag} 排障 API');
    let logs = api.logs();
    ok(logs.length >= 1 && logs.every((e) => e && typeof e.t === 'number'
      && /^[a-z-]{1,24}$/.test(String(e.ev)) && typeof e.v === 'string' && e.v.length <= 160),
      'AC-1 日志条目形状 {t, ev, v} 合规（ev 短枚举、v≤160）');
    ok(logs.some((e) => e.ev === 'report' && e.v.indexOf('iw=1000') >= 0), 'AC-1 上报日志含 innerWidth');
    ok(logs.some((e) => e.ev === 'ack'), 'AC-1 握手留痕');
    for (let i = 0; i < 150; i++) {
      const w = 280 + (i % 40);
      env.setWidth(w);              // 侧栏矩形
      env.setGrid(w + 'px 400px 400px'); // 首轨道（016 起测量优先取它）
      env.flush();
    }
    logs = api.logs();
    ok(logs.length === 120, 'AC-1 环形上限 120 条、超限丢最旧（实得 ' + logs.length + '）');
    api.clear();
    ok(api.logs().length === 0, 'AC-1 clear() 清空');
    env.dispose();

    // AC-4：layout 上报携带 innerWidth。
    const env2 = makePluginEnv({ width: 56, collapsed: true, grid: '56px 400px 400px', innerWidth: 1024 });
    vm.runInContext(src, env2.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    env2.apply(); env2.ack(); env2.flush();
    const rep = layouts(env2)[layouts(env2).length - 1];
    ok(rep && rep.innerWidth === 1024, 'AC-4 layout 上报携带 innerWidth=1024');
    env2.dispose();

    // AC-2：1s 内 7 次 band 翻转 → 自动 layout-diag；10s 限流；未握手不介入；宿主要日志可回。
    const env3 = makePluginEnv({ width: 56, collapsed: true, grid: '56px 400px 400px', innerWidth: 900 });
    vm.runInContext(src, env3.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    env3.apply(); env3.ack(); env3.flush();
    const diags3 = () => env3.reports.filter((m) => m.type === 'layout-diag');
    ok(diags3().length === 0, 'AC-2 未翻转风暴时不发诊断');
    for (let i = 0; i < 7; i++) {
      env3.advance(100);
      env3.setCollapsed(i % 2 === 1);
      env3.setDrawer(i >= 4);
      env3.flush();
    }
    ok(diags3().length === 1 && diags3()[0].reason === 'flip-storm', 'AC-2 1s 内 7 次 band 翻转 → 自动发 layout-diag(flip-storm)');
    const d0 = diags3()[0];
    ok(Array.isArray(d0.entries) && d0.entries.length >= 7 && d0.entries.length <= 200
      && d0.entries.every((e) => e && typeof e.t === 'number'
        && /^[a-z-]{1,24}$/.test(String(e.ev)) && typeof e.v === 'string' && e.v.length <= 160),
      'AC-2 诊断条目形状合规且带现场（' + d0.entries.length + ' 条）');
    for (let i = 0; i < 3; i++) { env3.advance(100); env3.setCollapsed(i % 2 === 0); env3.flush(); }
    ok(diags3().length === 1, 'AC-2 10s 限流内不重复触发');
    env3.advance(10000);
    for (let i = 0; i < 8; i++) { env3.advance(100); env3.setCollapsed(i % 2 === 0); env3.flush(); }
    ok(diags3().length === 2, 'AC-2 10s 限流期外再次风暴可再报（实得 ' + diags3().length + '）');
    env3.dispose();

    const env4 = makePluginEnv({ width: 56, collapsed: true, grid: '56px 400px 400px', innerWidth: 900 });
    vm.runInContext(src, env4.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    env4.apply();
    for (let i = 0; i < 8; i++) { env4.advance(100); env4.setCollapsed(i % 2 === 0); env4.flush(); }
    ok(env4.reports.filter((m) => m.type === 'layout-diag').length === 0, 'AC-2 未握手 → 不采集不取证');
    env4.dispose();

    const env5 = makePluginEnv({ width: 56, collapsed: true, grid: '56px 400px 400px', innerWidth: 900 });
    vm.runInContext(src, env5.sandbox, { filename: 'dsh-vscode-layout-client.js' });
    env5.apply(); env5.ack(); env5.flush();
    env5.fromHost({ type: 'layout-diag-request' }); env5.flush();
    const req = env5.reports.filter((m) => m.type === 'layout-diag' && m.reason === 'request');
    ok(req.length === 1 && Array.isArray(req[0].entries), 'AC-3 宿主要日志 → 回 layout-diag(reason=request)');
    env5.dispose();
  }

  console.log('[14] 中继：缩放实测校准（请求-应答配对、拖动不采信）');
  {
    const r = makeRealm({ policy: 'hide', width: 1000 });
    report(r, 56, true, false, 1000);
    ok(r.crop() === '56px', 'AC-4 首次上报未配对 → 按 1 裁 56');
    const asks = () => r.frameMessages.filter((m) => m.payload && m.payload.type === 'request-layout');
    ok(asks().length === 1, 'AC-4 未校准且需要裁剪 → 主动要一次配对样本');

    // 页面收到请求后重排再报：此时 clip = 1000 + 56 = 1056，s=0.875 → iw = 1056/0.875
    report(r, 56, true, false, 1056 / 0.875);
    ok(r.crop() === '49px', 'AC-4 配对样本 → 采信 0.875（56×0.875=49）');
    report(r, 280, false, false, (1000 + 49) / 0.875);
    ok(r.crop() === '249px', 'AC-4 展开 (280+4)×0.875=249');

    const r2 = makeRealm({ policy: 'hide', width: 1000 });
    report(r2, 56, true, false, 1000);
    report(r2, 56, true, false, (1000 + 56) / 1.25);
    ok(r2.crop() === '70px', 'AC-4 配对样本 1.25 → 导轨 70');
    report(r2, 280, false, false, (1000 + 70) / 1.25);
    ok(r2.crop() === '355px', 'AC-4 展开 (280+4)×1.25=355');

    // 拖动中（请求发出后舞台又变了）→ 该样本作废，仍按 1 裁
    const drag = makeRealm({ policy: 'hide', width: 900 });
    report(drag, 56, true, false, 900);
    ok(drag.crop() === '56px', '拖动起点：按 1 裁 56');
    drag.resize(1000);
    report(drag, 56, true, false, 829); // 陈旧 iw：若采信会裁 68
    ok(drag.crop() === '56px', 'AC-4 面板在动 → 该样本作废（仍裁 56）');
    drag.fromHost({ type: 'dsh-sidebar-diag-request' });
    drag.runTimers();
    const dragDiag = drag.toHost.filter((m) => m.type === 'dsh-sidebar-diag')[0];
    ok(dragDiag && dragDiag.host.some((e) => e.ev === 'ratio-request'), '主动校准留痕（ratio-request）');

    const r3 = makeRealm({ policy: 'hide', width: 1000 });
    report(r3, 56, true, false);
    ok(r3.crop() === '56px', 'AC-4 缺 innerWidth（旧插件）→ ratio=1（= 015 行为）');
    report(r3, 56, true, false, 0);
    ok(r3.crop() === '56px', 'AC-4 innerWidth=0 → 回退');
    report(r3, 56, true, false, NaN);
    ok(r3.crop() === '56px', 'AC-4 innerWidth 非数 → 回退');
    report(r3, 56, true, false, 100000);
    ok(r3.crop() === '56px', 'AC-4 ratio 越界（<0.5）→ 回退而不是按 0.01 裁 1px');

    const r4 = makeRealm({ policy: 'hide', width: 500 });
    report(r4, 0, false, true, 500);
    ok(r4.crop() === '0px', 'AC-4 抽屉态仍恒 0（轨道 0 不参与校准）');
    ok(r4.frameMessages.filter((m) => m.payload && m.payload.type === 'request-layout').length === 0,
      'AC-4 抽屉态不发校准请求');
  }

  console.log('[15] 中继：auto 策略拖动去抖（016 AC-6）');
  {
    const r = makeRealm({ policy: 'auto', width: 1000 });
    report(r, 56, true, false, 1000); // ratio = 1000/1000 = 1
    ok(r.crop() === '56px', '初始 auto（1000 < 1024）→ 裁 56');
    r.resize(1010);
    ok(r.crop() === '56px', '拖动中（未过断点）不改裁剪');
    r.resize(1100);
    ok(r.crop() === '56px', '150ms 静默期内不重算（逐帧 resize 不翻转）');
    r.resize(1110);
    r.runTimers();
    ok(r.crop() === '0px', '静默后按最终宽度只翻一次（1110 ≥ 1024 → 显示 → 不裁剪）');
    ok(r.button.getAttribute('aria-label') === '隐藏 DSH 侧栏', '按钮随最终状态同步');
    r.resize(900);
    report(r, 56, true, false, 900); // 与新裁剪同拍的上报（真实链路里插件会随重排再报）
    r.runTimers();
    ok(r.crop() === '56px', '回到窄面板 → 静默后重新隐藏（ratio 按新实测 900/900=1）');

    // 手动覆盖 = `dsh.ui.dshSidebarHidden`：false 表示「用户手动显示」。
    const o = makeRealm({ policy: 'auto', override: false, width: 1000 });
    report(o, 56, true, false, 1000);
    ok(o.crop() === '0px', '手动覆盖显示 → 不裁剪');
    o.resize(500); o.runTimers();
    ok(o.crop() === '0px' && o.button.getAttribute('aria-label') === '隐藏 DSH 侧栏',
      'AC-6 覆盖优先：缩到窄面板也不自动隐藏');

    const sh = makeRealm({ policy: 'show', width: 1200 });
    sh.resize(500); sh.runTimers();
    ok(sh.crop() === '0px', 'AC-6 show 策略缩放后仍零干预');
  }

  console.log('[16] 中继：诊断汇聚、导出超时兜底与 ratio 回退留痕（016 AC-2/AC-3/AC-4）');
  {
    const r = makeRealm({ policy: 'auto', width: 900 });
    report(r, 56, true, false, 900);
    r.fromPlugin({ type: 'layout-diag', reason: 'flip-storm', entries: [
      { t: 1, ev: 'flip', v: 'n=7' },
      { t: 2, ev: 'report', v: 'w=56 c=1 d=0 iw=900' }
    ] });
    const diags = r.toHost.filter((m) => m.type === 'dsh-sidebar-diag');
    ok(diags.length === 1 && diags[0].reason === 'flip-storm', 'AC-2 收到页面诊断 → 转发扩展');
    ok(Array.isArray(diags[0].host) && diags[0].host.length >= 1 && diags[0].host.some((e) => e.ev === 'layout'),
      'AC-2 附带宿主自身日志（两侧时间线）');
    ok(Array.isArray(diags[0].plugin) && diags[0].plugin.length === 2 && diags[0].pluginUnavailable === false,
      'AC-2 页面日志原样附带、pluginUnavailable=false');

    const r2 = makeRealm({ policy: 'auto', width: 900 });
    r2.fromHost({ type: 'dsh-sidebar-diag-request' });
    const reqs = r2.frameMessages.filter((m) => m.payload && m.payload.type === 'layout-diag-request');
    ok(reqs.length === 1 && reqs[0].payload.source === 'dsh-vscode-host', 'AC-3 导出请求 → 向页面要日志');
    r2.fromPlugin({ type: 'layout-diag', reason: 'request', entries: [{ t: 1, ev: 'report', v: 'w=56' }] });
    const d2 = r2.toHost.filter((m) => m.type === 'dsh-sidebar-diag');
    ok(d2.length === 1 && d2[0].reason === 'request' && d2[0].plugin.length === 1, 'AC-3 页面回包 → 合并上报一次');
    r2.runTimers();
    ok(r2.toHost.filter((m) => m.type === 'dsh-sidebar-diag').length === 1, 'AC-3 回包后超时不再补发');

    const r3 = makeRealm({ policy: 'auto', width: 900 });
    r3.fromHost({ type: 'dsh-sidebar-diag-request' });
    r3.runTimers();
    const d3 = r3.toHost.filter((m) => m.type === 'dsh-sidebar-diag');
    ok(d3.length === 1 && d3[0].pluginUnavailable === true && Array.isArray(d3[0].host),
      'AC-3 600ms 无回包（老插件）→ 兜底上报并标 pluginUnavailable');

    const r4 = makeRealm({ policy: 'hide', width: 1000 });
    report(r4, 56, true, false, 100000); // ratio 越界 → 回退并留痕
    r4.fromHost({ type: 'dsh-sidebar-diag-request' });
    r4.runTimers();
    const d4 = r4.toHost.filter((m) => m.type === 'dsh-sidebar-diag')[0];
    ok(d4 && d4.host.some((e) => e.ev === 'ratio-fallback'), 'AC-4 ratio 回退写进宿主日志（导出可见）');

    // 页面日志是不可信输入：中继先按形状过滤 + 截断，扩展侧再做一道（双层校验）。
    const r5 = makeRealm({ policy: 'auto', width: 900 });
    r5.fromPlugin({ type: 'layout-diag', reason: 'flip-storm', entries: [
      { t: 1, ev: 'report', v: 'x'.repeat(500) },
      { t: 2, ev: 'BAD EV', v: 'y' },
      { t: 3, ev: 'report', v: 'ok' }
    ] });
    const d5 = r5.toHost.filter((m) => m.type === 'dsh-sidebar-diag')[0];
    ok(d5 && d5.plugin.length === 2 && d5.plugin[0].v.length <= 160 && d5.plugin[1].v === 'ok',
      'AC-2 页面日志在中继侧就截断/丢弃（不可信输入）');
  }

  console.log('[17] 扩展宿主：diag 净化、输出面板与导出命令（016 AC-2/AC-3）');
  {
    outputChannels.length = 0;
    infoMessages.length = 0;
    const beforeStatus = statusBarMessages.length;

    const norm = I.normalizeSidebarDiag({
      reason: 'flip-storm',
      host: [
        { t: 10, ev: 'layout', v: 'w=56 crop=56' },
        { t: 11, ev: 'bad ev!', v: 'x' },
        { t: 12, ev: 'layout', v: 'a\u0007b\u0001' + 'x'.repeat(500) }
      ],
      plugin: 'nope',
      pluginUnavailable: true
    });
    ok(norm && norm.reason === 'flip-storm' && norm.host.length === 2 && norm.plugin.length === 0
      && norm.pluginUnavailable === true, 'AC-3 净化：形状白名单 + 非法条目丢弃 + 非数组归空');
    ok(norm.host[1].v.indexOf('\u0007') < 0 && norm.host[1].v.length <= 160, 'AC-3 v 清洗控制字符并截断 160');
    ok(I.normalizeSidebarDiag({ reason: 'BAD reason!', host: [] }) === null, 'AC-3 reason 不合规整条丢弃');
    ok(I.normalizeSidebarDiag(null) === null && I.normalizeSidebarDiag('x') === null, 'AC-3 非法载荷丢弃');

    I.handleWebviewMessage({ type: 'dsh-sidebar-diag', reason: 'flip-storm',
      host: [{ t: 1, ev: 'layout', v: 'w=56' }], plugin: [{ t: 2, ev: 'report', v: 'w=56' }] }, null);
    const ch = outputChannels[outputChannels.length - 1];
    ok(ch && ch.name === 'DeepSeek Harness' && ch.lines.some((l) => l.indexOf('flip-storm') >= 0)
      && ch.lines.some((l) => l.indexOf('[宿主]') >= 0) && ch.lines.some((l) => l.indexOf('[页面]') >= 0),
      'AC-2 诊断写入输出面板（含原因与两侧日志）');
    ok(statusBarMessages.length === beforeStatus + 1 && /抖动/.test(statusBarMessages[beforeStatus].text)
      && /导出/.test(statusBarMessages[beforeStatus].text), 'AC-2 状态栏一次提示（含导出命令出口）');
    I.handleWebviewMessage({ type: 'dsh-sidebar-diag', reason: 'flip-storm', host: [], plugin: [] }, null);
    ok(statusBarMessages.length === beforeStatus + 1, 'AC-2 重复风暴不刷屏');
    ok(ch.lines.length > 3, 'AC-2 但每次都落日志（可反复取证）');

    I.diagnoseSidebarCmd();
    ok(infoMessages.length === 1 && /面板尚未打开/.test(infoMessages[0]), 'AC-3 面板未打开 → 中文信息提示（出口明确）');
    const beforeLines = ch.lines.length;
    I.writeSidebarDiagMissing();
    ok(ch.lines.length > beforeLines && ch.lines.some((l) => l.indexOf('未收到页面回包') >= 0),
      'AC-3 无回包兜底写入说明（不静默）');

    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    ok((pkg.contributes.commands || []).some((c) => c.command === 'dshPanel.diagnoseSidebar'),
      'AC-3 命令已入 package.json 贡献点');
  }

  console.log('[18] 收敛扫描 × 4 档缩放比例（016 AC-5）');
  {
    const src = clientSource();
    ok(expectedCrop(1000, 1.25) === 70 && expectedCrop(600, 0.75) === 42,
      'AC-5 期望值含缩放（s≠1 时不同于未校准的 56 → 旧公式在本扫描必红）');
    const failures = [];
    const mismatch = [];
    for (const s of [0.75, 0.875, 1, 1.25]) {
      for (let stage = 240; stage <= 1400; stage += 8) {
        const rr = runCropLoop(stage, src, s);
        if (!rr.ok) failures.push('s=' + s + ' stage=' + stage + ' ' + rr.detail);
        const want = expectedCrop(stage, s);
        if (rr.crop !== want) mismatch.push('s=' + s + ' stage=' + stage + ' → ' + rr.crop + '≠' + want);
      }
    }
    ok(failures.length === 0, '四档缩放 × 240–1400 收敛且无 2-周期（首个：' + (failures[0] || '无') + '）');
    ok(mismatch.length === 0, '收敛值 = round(轨道 × s) 分段（首个：' + (mismatch[0] || '无') + '）');
  }

  console.log('[19] 抽屉态手动显隐跨断点保持（spec 017）');
  {
    // 窄面板（<768）抽屉态：用户点「显示」（打开抽屉），意图必须落到宿主覆盖。
    const r = makeRealm({ policy: 'auto', width: 500 });
    report(r, 0, true, true, 500);
    ok(r.crop() === '0px' && r.button.getAttribute('aria-label') === '显示 DSH 侧栏',
      '抽屉收起：不裁剪 + 按钮「显示」');
    r.click();
    const st = r.toHost.filter((m) => m.type === 'dsh-sidebar-state');
    ok(st.length === 1 && st[0].hidden === false && st[0].reason === 'user',
      'AC-1 点「显示」→ 写覆盖 hidden=false（否则拉宽后会被 auto 藏回去）');
    report(r, 0, false, true, 500);
    ok(r.button.getAttribute('aria-label') === '隐藏 DSH 侧栏', '抽屉已展开 → 按钮「隐藏」');

    // 拉宽到 768–1024（grid 导轨，auto 本会隐藏）
    r.resize(900);
    report(r, 56, true, false, 900);
    r.runTimers();
    ok(r.crop() === '0px', 'AC-1 拉宽到 900 → 仍按「显示」：不裁剪');
    ok(r.button.getAttribute('aria-label') === '隐藏 DSH 侧栏', 'AC-1 按钮仍为「隐藏」');

    // 继续拉宽到 ≥1024
    r.resize(1200);
    r.runTimers();
    ok(r.crop() === '0px', 'AC-4 拉宽到 1200（去抖触发）→ 覆盖优先，仍不裁剪');

    // 再拉回抽屉态：裁剪仍 0，展示态回到 collapsed 驱动
    r.resize(500);
    report(r, 0, true, true, 500);
    r.runTimers();
    ok(r.crop() === '0px' && r.button.getAttribute('aria-label') === '显示 DSH 侧栏',
      'AC-5 拉回抽屉态：crop 仍 0、按钮回到「显示」（抽屉态展示按 collapsed）');

    // 反向：抽屉已展开时点「隐藏」→ 覆盖 true → 拉宽后按用户意图隐藏。
    const r2 = makeRealm({ policy: 'auto', width: 500 });
    report(r2, 0, false, true, 500);
    ok(r2.button.getAttribute('aria-label') === '隐藏 DSH 侧栏', '抽屉已展开 → 按钮「隐藏」');
    r2.click();
    const st2 = r2.toHost.filter((m) => m.type === 'dsh-sidebar-state');
    ok(st2.length === 1 && st2[0].hidden === true, 'AC-2 点「隐藏」→ 写覆盖 hidden=true');
    r2.resize(900);
    report(r2, 56, true, false, 900);
    r2.runTimers();
    ok(r2.crop() === '56px', 'AC-2 拉宽到 900 → 按用户意图隐藏（裁 56）');

    // 同源缺陷（grid 态）：手动显示后拖动面板，auto 重算不得把选择冲掉。
    const r3 = makeRealm({ policy: 'auto', width: 900 });
    report(r3, 56, true, false, 900);
    ok(r3.crop() === '56px', 'grid 态 auto（900）→ 已隐藏');
    r3.click();
    ok(r3.crop() === '0px', '手动显示 → 立即不裁剪');
    r3.resize(1000);
    report(r3, 56, true, false, 1000);
    r3.runTimers();
    ok(r3.crop() === '0px', 'AC-6 拖动/缩放后仍按手动选择显示（不被 auto 重算冲掉）');

    // 取证指纹：导出日志里应能看到「用户覆盖已写」且拉宽后的重算没有翻转（spec 017 的排障依据）。
    r3.fromHost({ type: 'dsh-sidebar-diag-request' });
    r3.runTimers();
    const dg = r3.toHost.filter((m) => m.type === 'dsh-sidebar-diag')[0];
    ok(dg && dg.host.some((e) => e.ev === 'hidden' && /hidden=0/.test(e.v) && /ovr=0/.test(e.v)),
      '诊断日志含「手动覆盖已写」的指纹（hidden=0 ovr=0）');
    ok(dg && dg.host.some((e) => e.ev === 'resize' && /skipped=1/.test(e.v) && /ovr=0/.test(e.v)),
      '诊断日志显示拉宽被覆盖接管（auto 不再介入，不会翻回隐藏）');
  }

  console.log('[20] 调试日志落盘（spec 018：默认关闭、脱敏、轮转、失败不打断）');
  {
    const logPath = I.debugLogPath();

    // 默认关闭：不建文件、不写内容
    delete config['dshPanel.debugLogToFile'];
    I.resetDebugLogState();
    ok(I.debugLogEnabled() === false, '默认关闭：debugLogEnabled()=false');
    I.debugLog('test', 'should-not-be-written');
    ok(fs.existsSync(logPath) === false, '默认关闭：不创建日志文件');

    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const opt = pkg.contributes.configuration.properties['dshPanel.debugLogToFile'];
    ok(opt && opt.type === 'boolean' && opt.default === false, '配置项 dshPanel.debugLogToFile 存在且默认 false');
    ok((pkg.contributes.commands || []).some((c) => c.command === 'dshPanel.openDebugLog'),
      '命令「打开调试日志」已入贡献点');

    // 开启：诊断包落盘 + 首次提示路径
    config['dshPanel.debugLogToFile'] = true;
    I.resetDebugLogState();
    const beforeStatus = statusBarMessages.length;
    I.handleWebviewMessage({ type: 'dsh-sidebar-diag', reason: 'flip-storm',
      host: [{ t: 1, ev: 'layout', v: 'w=56 crop=56' }],
      plugin: [{ t: 2, ev: 'report', v: 'w=56' }] }, null);
    ok(fs.existsSync(logPath) === true, '开启后生成日志文件');
    const text1 = fs.readFileSync(logPath, 'utf8');
    ok(text1.indexOf('[sidebar-diag]') >= 0 && text1.indexOf('原因=flip-storm') >= 0
      && text1.indexOf('w=56 crop=56') >= 0, '诊断包落盘（原因 + 两侧条目）');
    ok(statusBarMessages.length === beforeStatus + 1
      && /调试日志已开启/.test(statusBarMessages[beforeStatus].text)
      && statusBarMessages[beforeStatus].text.indexOf(logPath) >= 0, '首次写入提示一次（含文件路径）');

    // 脱敏：token 值不得落盘
    I.handleWebviewMessage({ type: 'dsh-sidebar-diag', reason: 'request',
      host: [{ t: 3, ev: 'layout', v: 'url=/api?token=SECRET123' }], plugin: [] }, null);
    const text2 = fs.readFileSync(logPath, 'utf8');
    ok(text2.indexOf('SECRET123') < 0 && text2.indexOf('token=***') >= 0, '落盘前脱敏：token 值不写入');

    // 手动切换留档
    I.handleWebviewMessage({ type: 'dsh-sidebar-state', hidden: true, reason: 'user' }, null);
    ok(fs.readFileSync(logPath, 'utf8').indexOf('[sidebar-state]') >= 0, '手动显示/隐藏事件落盘');

    // 轮转：单条超过 2MB → 旧文件改名 .log.1，新文件继续写
    const backup = logPath + '.1';
    try { fs.unlinkSync(backup); } catch (e) { /* 无旧备份 */ }
    I.debugLog('test', 'x'.repeat(2 * 1024 * 1024 + 64));
    ok(fs.existsSync(backup) === true, '超过 2MB 自动轮转为 .log.1');
    ok(fs.statSync(logPath).size > 0, '轮转后继续写新文件');

    // 命令：存在则打开；不存在给开启指引
    I.openDebugLog();
    ok(shownDocs.length === 1 && shownDocs[0].fsPath === logPath, '命令「打开调试日志」打开该文件');
    const infoBefore = infoMessages.length;
    try { fs.unlinkSync(logPath); } catch (e) { /* ignore */ }
    I.openDebugLog();
    ok(infoMessages.length === infoBefore + 1 && /尚未生成/.test(infoMessages[infoBefore]),
      '日志不存在 → 指引开启设置（不静默）');

    // IO 失败不影响功能：HOME 指向「.dsh-debug 是普通文件」的目录
    const brokenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-broken-'));
    fs.writeFileSync(path.join(brokenHome, '.dsh-debug'), 'not-a-dir');
    setTestHome(brokenHome);
    I.resetDebugLogState();
    const stBefore = statusBarMessages.length;
    I.debugLog('test', 'boom');
    ok(statusBarMessages.length === stBefore + 1 && /调试日志写入失败/.test(statusBarMessages[stBefore].text),
      '落盘失败 → 状态栏提示一次（不打断功能）');
    const chBefore = outputChannels[outputChannels.length - 1].lines.length;
    I.handleWebviewMessage({ type: 'dsh-sidebar-diag', reason: 'manual',
      host: [{ t: 1, ev: 'layout', v: 'w=1' }], plugin: [] }, null);
    ok(outputChannels[outputChannels.length - 1].lines.length > chBefore, '落盘失败时输出面板照常可写');
    setTestHome(profileRoot);
    I.resetDebugLogState();
    delete config['dshPanel.debugLogToFile'];
  }

  console.log('[21] 事件流自动落盘（spec 019：关闭零成本、开启批量、热切换）');
  {
    const logPath = I.debugLogPath();

    // 关闭：完全不产生事件流消息（关闭时热路径只多一次布尔判断）
    delete config['dshPanel.debugLogToFile'];
    I.resetDebugLogState();
    const off = makeRealm({ policy: 'hide', width: 900, debug: false });
    report(off, 56, true, false, 900);
    off.resize(1000);
    report(off, 56, true, false, 1000);
    off.runTimers();
    ok(off.toHost.filter((m) => m.type === 'dsh-sidebar-trace').length === 0,
      '关闭：不产生事件流消息（零 IO / 零定时器）');

    // 开启：批量推送 → 扩展一次追加
    config['dshPanel.debugLogToFile'] = true;
    I.resetDebugLogState();
    try { fs.unlinkSync(logPath); } catch (e) { /* 首次 */ }
    const on = makeRealm({ policy: 'hide', width: 900, debug: true });
    report(on, 56, true, false, 900);
    on.resize(1000);
    report(on, 56, true, false, 1000);
    on.runTimers();
    const traces = on.toHost.filter((m) => m.type === 'dsh-sidebar-trace');
    ok(traces.length >= 1 && Array.isArray(traces[0].entries)
      && traces[0].entries.some((e) => e.ev === 'layout'), '开启：按批推送事件流（含 layout 现场）');
    for (const t of traces) I.handleWebviewMessage(t, null);
    const fileText = fs.readFileSync(logPath, 'utf8');
    ok(fileText.indexOf('[sidebar-trace]') >= 0 && fileText.indexOf('layout w=56') >= 0,
      '事件流写入文件（不必再手动导出诊断）');

    // 单包上限 200（攒满立即发，避免积压）
    const many = makeRealm({ policy: 'hide', width: 900, debug: true });
    report(many, 56, true, false, 900);
    for (let i = 0; i < 210; i++) {
      many.resize(900 + i);
      report(many, 56 + (i % 3), true, false, 900 + i);
    }
    const mt = many.toHost.filter((m) => m.type === 'dsh-sidebar-trace');
    ok(mt.length >= 1 && mt[0].entries.length === 200, '单包条目上限 200（满即发）');

    // 热切换：开启→推送；关闭→停止
    const hot = makeRealm({ policy: 'hide', width: 900, debug: false });
    hot.fromHost({ type: 'dsh-debug-log-file', enabled: true });
    report(hot, 56, true, false, 900);
    hot.runTimers();
    ok(hot.toHost.filter((m) => m.type === 'dsh-sidebar-trace').length >= 1, '热开启：开始推送事件流');
    hot.fromHost({ type: 'dsh-debug-log-file', enabled: false });
    const before = hot.toHost.filter((m) => m.type === 'dsh-sidebar-trace').length;
    report(hot, 60, true, false, 900);
    hot.runTimers();
    ok(hot.toHost.filter((m) => m.type === 'dsh-sidebar-trace').length === before, '热关闭：不再推送');

    // 净化：事件流与诊断包同一套白名单
    const bad = I.normalizeDiagEntries([
      { t: 1, ev: 'layout', v: 'ok' },
      { t: 'x', ev: 'layout', v: 'no' },
      { t: 2, ev: 'BAD EV', v: 'no' }
    ]);
    ok(bad.length === 1 && bad[0].v === 'ok', '事件流条目走同一套白名单净化');

    // 开启时写入环境行（缩放/字号是复盘错位的必要条件）
    try { fs.unlinkSync(logPath); } catch (e) { /* 可能不存在 */ }
    I.resetDebugLogState();
    I.onDebugLogSettingChanged();
    const envText = fs.readFileSync(logPath, 'utf8');
    ok(/\[env\].*zoomLevel/.test(envText) && /fontScale=/.test(envText), '开启时写入环境行（zoomLevel/字号）');
    config['dshPanel.debugLogToFile'] = false;
    I.onDebugLogSettingChanged();
    delete config['dshPanel.debugLogToFile'];
  }

  console.log('[22] 日志位置：扩展 globalStorage + 旧日志迁移（spec 021）');
  {
    ok(I.debugLogDirFrom({ globalStorageUri: { fsPath: '/tmp/gs' } }) === path.join('/tmp/gs', 'logs'),
      '优先用扩展的 globalStorage/logs');
    ok(I.debugLogDirFrom(null) === path.join(os.homedir(), '.dsh-debug'), '无上下文 → 回退 ~/.dsh-debug');
    ok(I.debugLogDirFrom({ globalStorageUri: { fsPath: '' } }) === path.join(os.homedir(), '.dsh-debug'),
      '空 fsPath → 回退');
    ok(I.debugLogPathFor('/tmp/gs/logs') === path.join('/tmp/gs/logs', I.debugLogFileName()),
      '纯函数调试日志路径拼接');

    const migrationHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mig-'));
    const legacyDir = path.join(migrationHome, '.dsh-debug');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, I.debugLogFileName()), 'legacy-line-1\n');
    const target = path.join(migrationHome, 'globalStorage', 'logs', I.debugLogFileName());
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    setTestHome(migrationHome);
    ok(I.migrateLegacyDebugLog(target) === true, '首次把旧位置日志迁移到新位置');
    ok(fs.readFileSync(target, 'utf8').indexOf('legacy-line-1') >= 0, '迁移内容完整');
    ok(I.migrateLegacyDebugLog(target) === false, '目标已存在 → 不重复迁移、不覆盖');
    process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    fs.rmSync(migrationHome, { recursive: true, force: true });
  }

  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(profileRoot, { recursive: true, force: true }); } catch (_) { /* noop */ }
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});

/** 插件上报里只看 layout 消息（hello 不算测量）。 */
function layouts(env) {
  return env.reports.filter((m) => m.type === 'layout');
}

/** 插件客户端仿真环境：最小 DOM / 定时器 / 观察器。 */
function makePluginEnv(opts) {
  const o = opts || {};
  const reports = [];
  const timers = [];
  const intervals = [];
  const winListeners = [];
  const clickListeners = [];
  // 仿真的 computed style：grid-template-columns（spec 015 轨道优先测量的输入）。
  let grid = o.grid === undefined ? '' : String(o.grid);
  // 假时钟（spec 016 风暴窗口 1s / 限流 10s 可离线驱动）。
  const clock = { t: 1700000000000 };
  // 页面视口（DSH px）：spec 016 上报 innerWidth、宿主据此算实测 ratio。
  let innerWidth = o.innerWidth === undefined ? 1000 : o.innerWidth;
  let seq = 1;
  let disposed = false;

  const frame = {
    attrs: {
      'data-sidebar-collapsed': o.collapsed ? '' : null,
      'data-sidebar-drawer': o.drawer ? '' : null
    },
    hasAttribute(k) { return this.attrs[k] !== null && this.attrs[k] !== undefined; },
    firstElementChild: null
  };
  const column = {
    className: 'pI_x6G_sidebarCol',
    rect: { width: o.width === undefined ? 280 : o.width },
    get isConnected() { return !disposed; },
    getBoundingClientRect() { return { width: this.rect.width, left: 0, right: this.rect.width }; },
    parentElement: frame
  };
  frame.firstElementChild = column;

  const sandbox = {
    window: {
      parent: { postMessage: (payload) => reports.push(payload) },
      addEventListener: (type, fn) => winListeners.push({ type, fn }),
      removeEventListener: () => {},
      setTimeout: (fn, ms) => { const id = seq++; timers.push({ id, fn, ms }); return id; },
      clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
      setInterval: (fn, ms) => { const id = seq++; intervals.push({ id, fn, ms }); return id; },
      clearInterval: (id) => { const i = intervals.findIndex((t) => t.id === id); if (i >= 0) intervals.splice(i, 1); },
      requestAnimationFrame: (fn) => { const id = seq++; timers.push({ id, fn, ms: 0 }); return id; },
      cancelAnimationFrame: () => {},
      getComputedStyle: () => ({ gridTemplateColumns: grid })
    },
    document: {
      querySelector: (sel) => {
        if (o.missing) return null;
        if (sel.indexOf('_sidebarCol') >= 0) return column;
        if (sel.indexOf('_frame') >= 0) return frame;
        return null;
      },
      addEventListener: (type, fn) => { if (type === 'click') clickListeners.push(fn); },
      removeEventListener: () => {}
    },
    console,
    __ModuleLoader__: { load: (spec) => { sandbox.__spec = spec; } }
  };
  // 插件用裸全局（非 window.*）也能跑：与浏览器行为保持一致
  sandbox.setTimeout = sandbox.window.setTimeout;
  sandbox.clearTimeout = sandbox.window.clearTimeout;
  sandbox.setInterval = sandbox.window.setInterval;
  sandbox.clearInterval = sandbox.window.clearInterval;
  sandbox.requestAnimationFrame = sandbox.window.requestAnimationFrame;
  sandbox.MutationObserver = function (cb) {
    this.observe = () => { sandbox.__attrObserve = cb; };
    this.disconnect = () => { sandbox.__attrObserve = null; };
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.__ModuleLoader__ = sandbox.__ModuleLoader__;
  // spec 016：页面视口（上报 innerWidth）与假时钟（风暴窗口/限流）。
  sandbox.window.innerWidth = innerWidth;
  sandbox.Date = { now: () => clock.t };
  vm.createContext(sandbox);

  let disposer = null;

  function flush() {
    for (let i = 0; i < 50; i++) {
      const t = timers.shift();
      if (!t) break;
      try { t.fn(); } catch (e) { console.error(e); }
    }
    for (const iv of intervals) {
      try { iv.fn(); } catch (e) { console.error(e); }
    }
  }

  return {
    sandbox,
    reports,
    apply: (extraCtx) => {
      const spec = sandbox.__spec;
      if (!spec) throw new Error('插件未注册到 __ModuleLoader__');
      sandbox.__plugin = spec.factory((name) => ({ name }));
      // o.ctx 注入假服务（如 layout），与真实客户端上下文的属性访问方式一致。
      const ctx = Object.assign({ effect: (fn) => { disposer = fn(); } }, o.ctx || {}, extraCtx || {});
      if (typeof sandbox.__plugin.apply === 'function') sandbox.__plugin.apply(ctx);
    },
    ack: () => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      source: sandbox.window.parent,
      data: { source: 'dsh-vscode-host', type: 'ack', fileLinks: true, layout: true }
    })),
    /** 宿主 → 页面的任意消息（与中继 postToFrame 一样恒带 HOST_ID 来源标记）。 */
    fromHost: (payload) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      source: sandbox.window.parent, data: Object.assign({ source: 'dsh-vscode-host' }, payload)
    })),
    setWidth: (w) => { column.rect.width = w; },
    setCollapsed: (v) => { frame.attrs['data-sidebar-collapsed'] = v ? '' : null; },
    setDrawer: (v) => { frame.attrs['data-sidebar-drawer'] = v ? '' : null; },
    setGrid: (v) => { grid = v === undefined ? '' : String(v); },
    setInnerWidth: (v) => { innerWidth = v; sandbox.window.innerWidth = v; },
    advance: (ms) => { clock.t += ms; },
    flush,
    dispose: () => {
      disposed = true;
      if (typeof disposer === 'function') disposer();
    }
  };
}

/** 读取测量插件真实源码（多处仿真共用同一份文件，避免测到副本）。 */
function clientSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'dsh-plugins', PLUGIN_SOURCE, 'lib', 'client.js'), 'utf8');
}

/** 当前中继的裁剪量（px）。 */
function cropPx(realm) {
  const v = parseInt(realm.crop(), 10);
  return Number.isFinite(v) ? v : 0;
}

/**
 * dsh 0.2.2-rc.1 左栏布局契约模型（@deepseek-ai/dsh-client-ui-layout/lib/client.js）：
 *  - viewport < 768 → 抽屉态：grid 首轨 0（`computeColumns(viewport, drawer ? 0 : …)` 行 269、
 *    `collapsedWidth = drawer || … ? 0 : 56` 行 267）；侧栏为绝对定位浮层，内联 width =
 *    `min(sidebar || 280, viewport - 48)`（行 331/380），收起只 `translate(-100%)`——矩形宽度不变；
 *  - 768 ≤ viewport < 1024 → 折叠导轨 56（SIDEBAR_AUTO_COLLAPSE=1024 行 13、行 252/267）；
 *  - viewport ≥ 1024 → 展开 280（`clampWidth(sidebar, 264, 420)` 行 40），collapsed=false。
 * `narrowExpanded` 恒按 false 建模（auto 自动折叠；手动展开态由 AC-3 的转调路径覆盖，不进扫描）。
 * webview 环境无 `data-windows-titlebar`（行 250），故 `drawer = viewport < 768`。
 * @param {number} viewport DSH 视口宽（≈ 面板宽 + 裁剪量，zoom=1）
 * @returns {{drawer: boolean, collapsed: boolean, track: number, overlay: number}}
 */
function dshLayoutModel(viewport) {
  const drawer = viewport < 768;
  const narrow = viewport < 1024;
  const collapsed = narrow; // narrowExpanded=false
  if (drawer) {
    return { drawer: true, collapsed: collapsed, track: 0, overlay: Math.min(280, Math.max(0, viewport - 48)) };
  }
  const track = collapsed ? 56 : 280;
  return { drawer: false, collapsed: collapsed, track: track, overlay: track };
}

/** 把插件新产生的上报喂给中继（只认 layout，hello 不算测量）。 */
function drainReports(env, realm) {
  if (env.__sent === undefined) env.__sent = 0;
  const list = env.reports;
  while (env.__sent < list.length) {
    const m = list[env.__sent++];
    if (m && m.type === 'layout') realm.fromPlugin(m);
  }
}

/**
 * 固定点迭代（spec 015 AC-6 / 016 AC-5）：`视口(DSH px) = (面板宽 + crop) / s` →
 * dsh 布局模型 → 真实插件测量（含 innerWidth 同拍上报）→ 真实中继按实测 ratio 裁剪。
 * 连续两次 crop 相同即收敛；中途出现重复值 = 2-周期振荡。
 * @param {number} stage 面板（stage）宽（webview px）
 * @param {string} pluginSource 插件源码
 * @param {number} [s] 缩放比例（CSS zoom：1 DSH px = s 个 webview px）
 * @returns {{ok: boolean, crop: number, detail: string}}
 */
function runCropLoop(stage, pluginSource, s = 1) {
  const realm = makeRealm({ policy: 'auto', width: stage, scale: s });
  const env = makePluginEnv({ width: 0, collapsed: false, grid: '0px 400px 400px', drawer: true });
  vm.runInContext(pluginSource, env.sandbox, { filename: 'dsh-vscode-layout-client.js' });
  env.setInnerWidth(stage / s); // 首拍：面板宽 / s（与 crop=0 同拍）
  env.apply();
  env.ack();
  env.flush();
  drainReports(env, realm);

  const seen = Object.create(null);
  const seq = [];
  let frameCursor = 0;
  let prev = cropPx(realm);
  seen[prev] = true;
  for (let i = 0; i < 40; i++) {
    const viewport = (stage + cropPx(realm)) / s;
    const st = dshLayoutModel(viewport);
    env.setDrawer(st.drawer);
    env.setCollapsed(st.collapsed);
    env.setWidth(st.drawer ? st.overlay : st.track);
    env.setGrid(st.track + 'px 400px 400px');
    env.setInnerWidth(viewport); // 与本次几何同拍（真实链路里 innerWidth 与轨道同一次上报）
    env.flush();
    drainReports(env, realm);
    // 宿主做缩放校准时会要一次配对样本：把请求派发给页面，页面按当前几何立即回报（spec 020）。
    while (frameCursor < realm.frameMessages.length) {
      const payload = realm.frameMessages[frameCursor++].payload;
      if (!payload || payload.source !== 'dsh-vscode-host') continue;
      // 真实链路：裁剪已应用 → iframe 宽度变了 → 浏览器让页面重新布局后才应答请求。
      if (payload.type === 'request-layout') env.setInnerWidth((stage + cropPx(realm)) / s);
      env.fromHost(payload);
    }
    env.flush();
    drainReports(env, realm);
    const c = cropPx(realm);
    seq.push(c);
    if (c === prev) return { ok: true, crop: c, detail: 'converged@' + i };
    if (seen[c]) return { ok: false, crop: c, detail: '2-周期振荡 crop=' + seq.join('→') };
    seen[c] = true;
    prev = c;
  }
  return { ok: false, crop: cropPx(realm), detail: '40 次内不收敛 crop=' + seq.join('→') };
}

/**
 * spec 016 AC-5 的分段期望（policy=auto、zoom=s、narrowExpanded=false）：
 *  - stage ≥ 1024：auto 判定为宽面板 → 不裁剪；
 *  - stage < 768s：DSH 视口 < 768 → 抽屉态轨道 0 → 不裁剪；
 *  - [768s, 968s)：导轨 56 → round(56s)；
 *  - ≥ 968s：视口将跨 1024 → 展开 (280+4) → round(284s)。
 * @param {number} stage 面板宽（webview px）
 * @param {number} s 缩放比例
 * @returns {number} 期望裁剪量（webview px）
 */
function expectedCrop(stage, s) {
  if (stage >= 1024) return 0;
  if (stage < 768 * s) return 0;
  if (stage < 968 * s) return Math.round(56 * s);
  return Math.round(284 * s);
}
