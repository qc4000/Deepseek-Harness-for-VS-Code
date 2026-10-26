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
let profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sidebar-'));
process.env.DSH_HOME = profileRoot;
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (Object.prototype.hasOwnProperty.call(config, k) ? config[k] : d) }),
    workspaceFolders: []
  },
  env: { remoteName: undefined },
  window: {
    showWarningMessage: async () => undefined,
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

const DSH_ORIGIN = 'http://127.0.0.1:3080';
const PLUGIN_SOURCE = 'dsh-vscode-layout';

/** 构造一个「webview 域」：跑真实中继脚本 + 假 DOM。 */
function makeRealm(opts) {
  const o = opts || {};
  const html = I.buildIframeHtml(DSH_ORIGIN, o.scale || 1, o.mode || 'revealAndOpen', {
    policy: o.policy || 'auto',
    override: o.override === undefined ? null : o.override
  });
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
    /** 模拟面板宽度变化（宿主侧拖动）并触发 resize。 */
    fireResize: () => winListeners.filter((l) => l.type === 'resize').forEach((l) => l.fn({})),
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

/** 上报一次测量。 */
function report(realm, sidebarWidth, collapsed) {
  realm.fromPlugin({ type: 'layout', sidebarWidth, collapsed: !!collapsed });
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

  console.log('[4b] 缩放：裁剪量按 zoom 换算（逻辑 px → 父容器 px）');
  {
    // CSS zoom 只作用于 iframe：插件量到的是 iframe 内部逻辑像素，
    // 而 --dsh-crop 写在未缩放的外层，因此必须乘当前缩放倍率。
    const z125 = makeRealm({ policy: 'hide', width: 900, scale: 1.25 });
    report(z125, 280, false);
    ok(z125.crop() === '355px', 'zoom 1.25 + 展开 280 → 裁剪 355（(280+4)×1.25）');
    report(z125, 56, true);
    ok(z125.crop() === '70px', 'zoom 1.25 + 折叠 56 → 70');

    const z075 = makeRealm({ policy: 'hide', width: 900, scale: 0.75 });
    report(z075, 280, false);
    ok(z075.crop() === '213px', 'zoom 0.75 + 展开 280 → 213（(280+4)×0.75）');

    const live = makeRealm({ policy: 'hide', width: 1600, scale: 1 });
    report(live, 280, false);
    ok(live.crop() === '284px', 'zoom 1 → 284');
    live.fromHost({ type: 'dsh-font-scale', scale: 1.25 });
    ok(live.crop() === '355px', '运行时改字号（宽面板）→ 不重载即按新缩放重算');
    live.fromHost({ type: 'dsh-font-scale', scale: 0.75 });
    ok(live.crop() === '213px', '再改小字号 → 同样重算');

    // 窄面板改大字号：iframe 内部逻辑视口变小，DSH 会自行折成导轨（56）——
    // 裁剪量必须跟着变成 70，而不是保留旧的 284（否则会切掉对话）。
    const narrowLive = makeRealm({ policy: 'hide', width: 900, scale: 1 });
    report(narrowLive, 280, false);
    ok(narrowLive.crop() === '284px', '窄面板 + 展开 280 → 284');
    narrowLive.fromHost({ type: 'dsh-font-scale', scale: 1.25 });
    ok(narrowLive.crop() === '70px', '窄面板改大字号 → 折算为导轨 56 → 裁剪 70');
  }

  console.log('[4c] 面板变宽跨过 DSH 断点：先按规则预测裁剪量');
  {
    const r = makeRealm({ policy: 'hide', width: 900 });
    report(r, 56, true);
    ok(r.crop() === '56px', '窄容器隐藏（导轨 56）');
    // (1000 + 56) >= 1024 → DSH 会从导轨切到展开 280，动画持续 300ms；
    // 若等测量回来再改，侧栏会先露出一下。
    r.stage.clientWidth = 1000;
    r.fireResize();
    ok(r.crop() === '284px', '变宽跨断点 → 立刻按预测的展开宽度裁剪（不等下一次测量）');
    ok(r.frameMessages.some((m) => m.payload.type === 'request-layout'), '同时向插件请求一次权威测量');
    report(r, 280, false);
    ok(r.crop() === '284px', '测量回来后保持一致');

    const stay = makeRealm({ policy: 'hide', width: 600 });
    report(stay, 56, true);
    stay.stage.clientWidth = 700;
    stay.fireResize();
    ok(stay.crop() === '56px', '仍在窄区间 → 预测不改变裁剪量（不抖动）');
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

    const beforeForce = layouts(env).length;
    env.requestLayout();
    ok(layouts(env).length === beforeForce + 1, '宿主 request-layout → 强制上报一次（即使数值未变）');

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
  let seq = 1;
  let disposed = false;

  const frame = {
    attrs: { 'data-sidebar-collapsed': o.collapsed ? '' : null },
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
      getComputedStyle: () => ({ gridTemplateColumns: '' })
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
    apply: () => {
      const spec = sandbox.__spec;
      if (!spec) throw new Error('插件未注册到 __ModuleLoader__');
      sandbox.__plugin = spec.factory((name) => ({ name }));
      const ctx = { effect: (fn) => { disposer = fn(); } };
      if (typeof sandbox.__plugin.apply === 'function') sandbox.__plugin.apply(ctx);
    },
    ack: () => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      source: sandbox.window.parent,
      data: { source: 'dsh-vscode-host', type: 'ack', fileLinks: true, layout: true }
    })),
    requestLayout: () => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({
      source: sandbox.window.parent,
      data: { source: 'dsh-vscode-host', type: 'request-layout' }
    })),
    setWidth: (w) => { column.rect.width = w; },
    setCollapsed: (v) => { frame.attrs['data-sidebar-collapsed'] = v ? '' : null; },
    flush,
    dispose: () => {
      disposed = true;
      if (typeof disposer === 'function') disposer();
    }
  };
}
