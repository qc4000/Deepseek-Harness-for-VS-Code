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
    setStatusBarMessage: (text, ms) => { statusBarMessages.push({ text, ms }); return { dispose() {} }; }
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

/** 上报一次测量（`drawer` 为 dsh 0.2.2 抽屉态标志，缺省表示旧插件/非抽屉）。 */
function report(realm, sidebarWidth, collapsed, drawer) {
  const data = { type: 'layout', sidebarWidth, collapsed: !!collapsed };
  if (drawer !== undefined) data.drawer = drawer === true;
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
    ok(r.toHost.filter((m) => m.type === 'dsh-sidebar-state').length === 0, 'AC-3 抽屉态不写手动覆盖');
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
 * 固定点迭代（spec 015 AC-6）：`视口 = 面板宽 + crop` → dsh 布局模型 → 真实插件测量 →
 * 真实中继裁剪。连续两次 crop 相同即收敛；中途出现重复值 = 2-周期振荡（004 §12 的失败模式）。
 * @param {number} stage 面板（stage）宽
 * @param {string} pluginSource 插件源码
 * @returns {{ok: boolean, crop: number, detail: string}}
 */
function runCropLoop(stage, pluginSource) {
  const realm = makeRealm({ policy: 'auto', width: stage });
  const env = makePluginEnv({ width: 0, collapsed: false, grid: '0px 400px 400px', drawer: true });
  vm.runInContext(pluginSource, env.sandbox, { filename: 'dsh-vscode-layout-client.js' });
  env.apply();
  env.ack();
  env.flush();
  drainReports(env, realm);

  const seen = Object.create(null);
  const seq = [];
  let prev = cropPx(realm);
  seen[prev] = true;
  for (let i = 0; i < 40; i++) {
    const viewport = stage + cropPx(realm);
    const st = dshLayoutModel(viewport);
    env.setDrawer(st.drawer);
    env.setCollapsed(st.collapsed);
    env.setWidth(st.drawer ? st.overlay : st.track);
    env.setGrid(st.track + 'px 400px 400px');
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
