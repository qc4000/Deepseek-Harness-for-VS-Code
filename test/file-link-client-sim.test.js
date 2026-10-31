'use strict';
/**
 * dsh-vscode-file-links 客户端半边的行为仿真测试（无浏览器依赖）。
 * 运行：node test/file-link-client-sim.test.js
 *
 * 用最小 DOM/事件/定时器仿真把 client.js 真正跑起来，验证最容易出错的交互语义：
 *  - 未握手（ack）前完全不介入；
 *  - 握手后：命中文件链接按钮 → 阻断 DSH 自身打开 + 向父级发 reveal；
 *  - 宿主回执 ok=true → 不回放；ok=false → 回放原始点击（DSH 侧边栏照旧打开）；
 *  - 宿主超时无回执 → 回放；修饰键点击 → 不接管；非文件链接按钮 → 不接管；
 *  - 独立浏览器（无父级）→ 不打招呼、不介入。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

const clientSource = fs.readFileSync(
  path.join(__dirname, '..', 'dsh-plugins', 'dsh-vscode-file-links', 'lib', 'client.js'),
  'utf8'
);
const clientPkg = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'dsh-plugins', 'dsh-vscode-file-links', 'package.json'),
  'utf8'
));

/** 造一个仿真环境：document/window/定时器/事件派发（含「React 委托 handler」模型）。 */
function makeEnv(options = {}) {
  const docCapture = [];
  const winListeners = [];
  const posted = [];      // 插件 → 父级（webview）
  const timers = [];
  const reactCalls = [];  // DSH 自身行为（侧边栏打开）被调用的次数
  let timerSeq = 1;

  const win = {
    name: options.name === undefined ? '' : options.name,
    addEventListener: (type, fn) => winListeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = winListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) winListeners.splice(i, 1);
    },
    postMessage: (payload) => posted.push(payload),
    setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms, interval: null }); return id; },
    setInterval: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms, interval: ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
  };
  win.parent = options.standalone
    ? win
    // 父级（VS Code 面板 webview）：插件只往这里 postMessage
    : { isParent: true, postMessage: (payload) => posted.push(payload) };

  const document = {
    addEventListener: (type, fn, capture) => docCapture.push({ type, fn, capture }),
    removeEventListener: (type, fn) => {
      const i = docCapture.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) docCapture.splice(i, 1);
    },
    // 轮标记行（DSH 消息节点外层带 data-chat-turn）；无 rows 时返回空表。
    querySelectorAll: (sel) => (String(sel).indexOf('data-chat-turn') >= 0 ? (options.rows || []).slice() : [])
  };

  /** 派发一次点击：document 捕获阶段 → （未被 stopPropagation 时）DSH 的委托 handler。 */
  function dispatchClick(target, modifiers = {}) {
    const event = {
      type: 'click',
      target,
      button: modifiers.button === undefined ? 0 : modifiers.button,
      metaKey: !!modifiers.metaKey,
      ctrlKey: !!modifiers.ctrlKey,
      shiftKey: !!modifiers.shiftKey,
      altKey: !!modifiers.altKey,
      defaultPrevented: false,
      stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }
    };
    for (const l of docCapture.slice()) l.fn(event);
    // React 18 把 onClick 委托挂在根容器（document 之下）：被 stopPropagation 挡住。
    if (!event.stopped) reactCalls.push(target);
    return event;
  }

  /** 模拟元素：button 或 button 内部的子节点（图标/文字 span）。 */
  function makeButton(opts = {}) {
    const attrs = {};
    if (opts.cls !== null) attrs.class = opts.cls === undefined ? '_fileMention_abc _fileLink_def' : opts.cls;
    if (opts.title !== undefined) attrs.title = opts.title;
    const btn = {
      nodeType: 1,
      tagName: 'BUTTON',
      textContent: opts.text === undefined ? '' : opts.text,
      getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
      closest: (sel) => (sel === 'button' ? btn : null),
      click: () => dispatchClick(btn)
    };
    return btn;
  }
  function makeChild(button) {
    return {
      nodeType: 1,
      tagName: 'SPAN',
      closest: (sel) => (sel === 'button' ? button : null)
    };
  }

  /** 把某来源的消息交给插件（默认来自父级 webview）。 */
  function hostMessageFrom(source, data) {
    const event = { source, data };
    for (const l of winListeners.slice()) {
      if (l.type === 'message') l.fn(event);
    }
  }
  function hostMessage(data) {
    hostMessageFrom(win.parent, data);
  }

  function runTimers(which) {
    for (const t of timers.slice()) {
      if (which && t.ms !== which) continue;
      if (t.interval === null) {
        const i = timers.findIndex((x) => x.id === t.id);
        if (i >= 0) timers.splice(i, 1);
      }
      t.fn();
    }
  }

  const sandbox = { window: win, document, console };
  vm.createContext(sandbox);
  let pluginExports = null;
  sandbox.window.__ModuleLoader__ = { load: ({ id, factory }) => { pluginExports = factory(() => {}); } };
  vm.runInContext(clientSource, sandbox, { filename: 'dsh-vscode-file-links/client.js' });
  let disposed = null;
  pluginExports.apply(Object.assign({ effect: (fn) => { disposed = fn(); } }, options.ctx || {}));

  /** 给按钮挂上「轮标记」祖先（DSH 的消息节点外层带 data-chat-turn）。 */
  function withTurn(button, turn) {
    button.parentElement = {
      nodeType: 1,
      getAttribute: (n) => (n === 'data-chat-turn' ? String(turn) : null),
      parentElement: null
    };
    return button;
  }

  return { win, posted, dispatchClick, makeButton, makeChild, withTurn, hostMessage, hostMessageFrom, runTimers, reactCalls, timers, dispose: () => disposed && disposed() };
}

console.log('[1] 未握手（宿主未 ack）：完全不介入');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  const btn = env.makeButton({ title: 'src/a.ts' });
  const event = env.dispatchClick(btn);
  ok(env.reactCalls.length === 1 && event.defaultPrevented === false, '未握手时点击照旧走 DSH 自身行为（不吞点击）');
  ok(env.posted.some((m) => m.type === 'hello'), '插件主动打招呼（hello，带自身 source 标记）');
  ok(env.posted.filter((m) => m.type === 'reveal').length === 0, '未握手时不发 reveal');
}

console.log('[2] 握手后：接管并转发，DSH 自身行为被阻断');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });
  const btn = env.makeButton({ title: 'src/deep/nested/a.ts' });
  const event = env.dispatchClick(env.makeChild(btn));
  const reveal = env.posted.filter((m) => m.type === 'reveal');
  ok(event.defaultPrevented === true && event.stopped === true, '接管时 preventDefault + stopPropagation');
  ok(env.reactCalls.length === 0, 'DSH 自身打开被阻断（不会既开侧边栏又跳 VS Code）');
  ok(reveal.length === 1 && reveal[0].path === 'src/deep/nested/a.ts', '路径取 title 并转发（点击落在内部子节点也命中）');
  ok(reveal[0].source === 'dsh-vscode-file-links' && typeof reveal[0].token === 'string' && reveal[0].token.length > 0, '转发消息带插件标识与 token');
  ok(env.win.name === 'dsh-vscode-host', '（仿真前提）iframe name 标记存在');

  // 宿主回执 ok=true：不回放
  env.hostMessage({ source: 'dsh-vscode-host', type: 'reveal-result', token: reveal[0].token, ok: true });
  ok(env.reactCalls.length === 0, '回执 ok=true：不回放，DSH 侧边栏保持关闭');
}

console.log('[3] 宿主无法处理：回放原始点击（不会点了没反应）');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });
  const btn = env.makeButton({ title: 'outside/x.txt' });
  env.dispatchClick(btn);
  const reveal = env.posted.filter((m) => m.type === 'reveal');
  ok(env.reactCalls.length === 0, '先阻断');
  env.hostMessage({ source: 'dsh-vscode-host', type: 'reveal-result', token: reveal[0].token, ok: false });
  ok(env.reactCalls.length === 1 && env.reactCalls[0] === btn, '回执 ok=false：回放一次原始点击（DSH 侧边栏打开）');
  ok(env.posted.filter((m) => m.type === 'reveal').length === 1, '回放不会再触发一次 reveal（无环）');
}

console.log('[4] 宿主超时（面板关闭 / 扩展未升级）：超时回放');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });
  const btn = env.makeButton({ title: 'src/b.ts' });
  env.dispatchClick(btn);
  ok(env.reactCalls.length === 0, '阻断等待回执');
  env.runTimers(2500); // REVEAL_TIMEOUT_MS
  ok(env.reactCalls.length === 1, '超时后回放（绝不出现点了没反应）');
}

console.log('[5] 不接管的场景');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });

  const plain = env.makeButton({ cls: 'some-other-button', title: 'src/a.ts' });
  env.dispatchClick(plain);
  ok(env.reactCalls.length === 1 && env.posted.filter((m) => m.type === 'reveal').length === 0, '非文件链接按钮不接管');

  const modBtn = env.makeButton({ title: 'src/a.ts' });
  env.reactCalls.length = 0;
  env.dispatchClick(modBtn, { ctrlKey: true });
  ok(env.reactCalls.length === 1 && env.posted.filter((m) => m.type === 'reveal').length === 0, 'Ctrl+点击不接管（强制走 DSH 行为）');
  env.reactCalls.length = 0;
  env.dispatchClick(modBtn, { metaKey: true });
  env.dispatchClick(modBtn, { shiftKey: true });
  env.dispatchClick(modBtn, { altKey: true });
  env.dispatchClick(modBtn, { button: 1 });
  ok(env.reactCalls.length === 4 && env.posted.filter((m) => m.type === 'reveal').length === 0, 'Cmd/Shift/Alt/中键点击一律不接管');

  const noPath = env.makeButton({ title: '' });
  env.reactCalls.length = 0;
  env.dispatchClick(noPath);
  ok(env.reactCalls.length === 1, '没有可用路径时不接管（退回 DSH 行为）');
}

console.log('[6] 图片链接（无 title）退回链接文字；伪造来源的 ack 被忽略');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });
  const imgBtn = env.makeButton({ title: undefined, text: 'assets/plot.png' });
  env.dispatchClick(imgBtn);
  const reveal = env.posted.filter((m) => m.type === 'reveal');
  ok(reveal.length === 1 && reveal[0].path === 'assets/plot.png', '无 title 时退回链接文字（图片预览链接）');
}
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessageFrom({ evil: true }, { source: 'dsh-vscode-host', type: 'ack', fileLinks: true });
  const event = env.dispatchClick(env.makeButton({ title: 'src/a.ts' }));
  ok(env.reactCalls.length === 1 && event.defaultPrevented === false, '非父级来源的 ack 不生效（不会被第三方页面接管）');
  ok(env.posted.filter((m) => m.type === 'reveal').length === 0, '未被授权时不发 reveal');
  env.hostMessageFrom(env.win.parent, { source: 'dsh-vscode-host', type: 'ack', fileLinks: false });
  const event2 = env.dispatchClick(env.makeButton({ title: 'src/a.ts' }));
  ok(event2.defaultPrevented === false && env.reactCalls.length === 2, '宿主持有 fileLinks:false（配置为 off）时不接管');
}

console.log('[7] 独立浏览器（无父级宿主）：完全惰性');
{
  const env = makeEnv({ standalone: true });
  ok(env.posted.length === 0, '不打招呼（postMessage 一次都没有）');
  const btn = env.makeButton({ title: 'src/a.ts' });
  const event = env.dispatchClick(btn);
  ok(env.reactCalls.length === 1 && event.defaultPrevented === false, '照旧走 DSH 自身行为');
  ok(env.win.__dshVscodeFileLinks.version === clientPkg.version && env.win.__dshVscodeFileLinks.acked() === false, '暴露排障对象（version/acked）');
}

console.log('[8] 插件卸载：监听器与定时器清理');
{
  const env = makeEnv({ name: 'dsh-vscode-host' });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });
  const btn = env.makeButton({ title: 'src/a.ts' });
  env.dispatchClick(btn);
  env.dispose();
  const before = env.reactCalls.length;
  env.dispatchClick(env.makeButton({ title: 'src/a.ts' }));
  ok(env.reactCalls.length === before + 1, '卸载后不再拦截');
  ok(env.timers.length === 0, '卸载后清掉待定定时器（不留悬挂回放）');
}

console.log('[9] diff 模式：带轮坐标 + reveal-ack 放宽等待');
{
  const ctx = {
    get: (name) => (name === 'sessions'
      ? { list: { getSnapshot: () => ({ byId: { 'session-ab12': { retainedBy: { mainView: 1 } } } }) } }
      : undefined)
  };
  const env = makeEnv({ name: 'dsh-vscode-host', ctx });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'diffAndOpen', diff: true });
  ok(env.win.__dshVscodeFileLinks.diffMode() === true, 'ack.diff=true 后进入 diff 模式');

  const btn = env.withTurn(env.makeButton({ title: 'src/a.ts' }), 7);
  env.dispatchClick(btn);
  let reveal = env.posted.filter((m) => m.type === 'reveal');
  ok(reveal.length === 1 && reveal[0].change && reveal[0].change.turn === 7, '带轮次（取自 data-chat-turn）');
  ok(reveal[0].change.sessionId === 'session-ab12', '带当前主视图会话 id');

  // reveal-ack 后：2.5 s 不回放，6 s 才回放
  env.hostMessage({ source: 'dsh-vscode-host', type: 'reveal-ack', token: reveal[0].token });
  env.runTimers(2500);
  ok(env.reactCalls.length === 0, '接单后 2.5 s 不回放（避免与 diff 双开）');
  env.runTimers(6000);
  ok(env.reactCalls.length === 1, '6 s 仍无结果才回放（绝不点了没反应）');

  // 没有轮标记（历史消息常见）：不再干脆放弃——带 latest，让 DSH 插件找「最后一次改动」（规格 011）
  const plain = env.makeButton({ title: 'src/b.ts' });
  env.dispatchClick(plain);
  reveal = env.posted.filter((m) => m.type === 'reveal');
  ok(reveal.length === 2 && reveal[1].change && reveal[1].change.latest === true, '无轮标记时改带 latest 坐标');
  ok(reveal[1].change.turn === undefined && reveal[1].change.sessionId === 'session-ab12', 'latest 不带 turn（不猜轮次）');
  env.hostMessage({ source: 'dsh-vscode-host', type: 'reveal-result', token: reveal[1].token, ok: true });

  // 拿不到会话 id：同样不带坐标（不能猜错会话）
  const env2 = makeEnv({ name: 'dsh-vscode-host' });
  env2.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'diffAndOpen', diff: true });
  const btn2 = env2.withTurn(env2.makeButton({ title: 'src/c.ts' }), 3);
  env2.dispatchClick(btn2);
  ok(env2.posted.filter((m) => m.type === 'reveal')[0].change === undefined, '读不到会话 id 时不带坐标');

  // 老宿主（ack 无 diff 字段）：即使有轮标记也不带坐标
  const env3 = makeEnv({ name: 'dsh-vscode-host', ctx });
  env3.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'revealAndOpen' });
  const btn3 = env3.withTurn(env3.makeButton({ title: 'src/d.ts' }), 5);
  env3.dispatchClick(btn3);
  ok(env3.posted.filter((m) => m.type === 'reveal')[0].change === undefined, '未声明 diff 的宿主不带坐标（老宿主兼容）');

  // 真机退化①：客户端上下文只有属性访问（dsh 自家插件取服务一律用属性，不走 ctx.get）
  const propCtx = { sessions: { list: { getSnapshot: () => ({ byId: { 'session-pp': { retainedBy: { mainView: 1 } } } }) } } };
  const envP = makeEnv({ name: 'dsh-vscode-host', ctx: propCtx });
  envP.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'diffAndOpen', diff: true });
  const btnP = envP.withTurn(envP.makeButton({ title: 'src/p.ts' }), 2);
  envP.dispatchClick(btnP);
  const revP = envP.posted.filter((m) => m.type === 'reveal')[0];
  ok(revP && revP.change && revP.change.sessionId === 'session-pp' && revP.change.turn === 2, '无 ctx.get、只有属性访问时仍能带坐标');

  const uiCtx = { uiSession: { current: { getSnapshot: () => ({ key: 'session-ui' }) } } };
  const envU = makeEnv({ name: 'dsh-vscode-host', ctx: uiCtx });
  envU.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'diffAndOpen', diff: true });
  const btnU = envU.withTurn(envU.makeButton({ title: 'src/u.ts' }), 4);
  envU.dispatchClick(btnU);
  const revU = envU.posted.filter((m) => m.type === 'reveal')[0];
  ok(revU && revU.change && revU.change.sessionId === 'session-ui' && revU.change.turn === 4, 'uiSession 属性形状同样取到会话 id');

  // 真机退化②：链接落在没有轮标记的包装层里 → 取文档中「前一个」标记行的轮
  const rowBefore = { nodeType: 1, getAttribute: (n) => (n === 'data-chat-turn' ? '9' : null), __preceding: true };
  const rowAfter = { nodeType: 1, getAttribute: (n) => (n === 'data-chat-turn' ? '11' : null), __preceding: false };
  const envF = makeEnv({ name: 'dsh-vscode-host', ctx, rows: [rowBefore, rowAfter] });
  envF.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'diffAndOpen', diff: true });
  const btnF = envF.makeButton({ title: 'src/f.ts' });
  // 按钮位于两行之间：前一个标记行 precedes(2)，后一个 follows(4)。
  btnF.compareDocumentPosition = (row) => (row && row.__preceding ? 2 : 4);
  envF.dispatchClick(btnF);
  const revF = envF.posted.filter((m) => m.type === 'reveal')[0];
  ok(revF && revF.change && revF.change.turn === 9, '祖先无标记时取「前一个」标记行的轮');
  ok(revF.change.turn !== 11, '后面的标记行不算（不误取下一轮）');

  // 全文档没有任何标记：仍能带 latest（只要拿得到会话）
  const envN = makeEnv({ name: 'dsh-vscode-host', ctx });
  envN.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'diffAndOpen', diff: true });
  const btnN = envN.makeButton({ title: 'src/n.ts' });
  btnN.compareDocumentPosition = () => 2;
  envN.dispatchClick(btnN);
  const revN = envN.posted.filter((m) => m.type === 'reveal')[0];
  ok(revN && revN.change && revN.change.latest === true, '全无轮标记时走 latest（AC-4）');
}

console.log('[10] 布局 ack 不得覆盖文件链接模式（真机回归）');
{
  const ctx = { sessions: { list: { getSnapshot: () => ({ byId: { 'session-lay': { retainedBy: { mainView: 1 } } } }) } } };
  // 宿主在 iframe 加载时先发文件链接 ack，紧接着发侧栏布局 ack（{layout:true}）。
  const env = makeEnv({ name: 'dsh-vscode-host', ctx });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'diffAndOpen', diff: true });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', layout: true });
  ok(env.win.__dshVscodeFileLinks.diffMode() === true, '布局 ack 之后仍保持 diff 模式');
  const btn = env.withTurn(env.makeButton({ title: 'src/lay.ts' }), 6);
  env.dispatchClick(btn);
  const reveal = env.posted.filter((m) => m.type === 'reveal')[0];
  ok(reveal && reveal.change && reveal.change.turn === 6, '布局 ack 之后点击仍带轮坐标');
  ok(reveal.change.sessionId === 'session-lay', '布局 ack 之后坐标里的会话 id 未串');

  // 反向顺序：布局 ack 先到、文件链接 ack 后到。
  const env2 = makeEnv({ name: 'dsh-vscode-host', ctx });
  env2.hostMessage({ source: 'dsh-vscode-host', type: 'ack', layout: true });
  env2.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'diffAndOpen', diff: true });
  ok(env2.win.__dshVscodeFileLinks.diffMode() === true, '布局 ack 先到时也能进入 diff 模式');

  // 只有布局 ack（文件链接未启用）：不能把页面标记成已接管。
  const env3 = makeEnv({ name: 'dsh-vscode-host' });
  env3.hostMessage({ source: 'dsh-vscode-host', type: 'ack', layout: true });
  ok(env3.win.__dshVscodeFileLinks.acked() === false, '仅布局 ack 不算文件链接接管');
  const btn3 = env3.withTurn(env3.makeButton({ title: 'src/only-layout.ts' }), 2);
  env3.dispatchClick(btn3);
  ok(env3.posted.filter((m) => m.type === 'reveal').length === 0, '仅布局 ack 时不接管点击（保持 DSH 自身行为）');
}

console.log('[11] 会话 cwd 上报与诊断日志（规格 011）');
{
  const ctx = {
    get: (name) => (name === 'sessions'
      ? { list: { getSnapshot: () => ({ byId: { 'session-cw': { retainedBy: { mainView: 1 }, cwd: '/w/other' } } }) } }
      : undefined)
  };
  const env = makeEnv({ name: 'dsh-vscode-host', ctx });
  env.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'diffAndOpen', diff: true });
  const btn = env.withTurn(env.makeButton({ title: 'src/a.ts' }), 7);
  env.dispatchClick(btn);
  const reveal = env.posted.filter((m) => m.type === 'reveal')[0];
  ok(reveal.cwd === '/w/other', '上报 DSH 会话 cwd（相对链接的基准）');
  ok(env.win.__dshVscodeFileLinks.cwd() === '/w/other', '排障对象能读到 cwd');
  const log = env.win.__dshVscodeFileLinks.log();
  ok(log.length === 1 && log[0].path === 'src/a.ts' && log[0].cwd === '/w/other' && log[0].result === 'pending', '环形日志记下点击（path/cwd/result）');
  ok(log[0].change && log[0].change.turn === 7, '日志里带坐标（不猜轮次）');
  env.hostMessage({ source: 'dsh-vscode-host', type: 'reveal-result', token: reveal.token, ok: true });
  ok(env.win.__dshVscodeFileLinks.log()[0].result === 'ok', '日志记录结果（ok）');
  env.win.__dshVscodeFileLinks.clear();
  ok(env.win.__dshVscodeFileLinks.log().length === 0, '日志可清空');

  // 会话取不到 cwd（老版 dsh）：不带 cwd 字段，宿主退回旧解析
  const noCwdCtx = { sessions: { list: { getSnapshot: () => ({ byId: { 'session-nc': { retainedBy: { mainView: 1 } } } }) } } };
  const env2 = makeEnv({ name: 'dsh-vscode-host', ctx: noCwdCtx });
  env2.hostMessage({ source: 'dsh-vscode-host', type: 'ack', fileLinks: true, mode: 'diffAndOpen', diff: true });
  env2.dispatchClick(env2.withTurn(env2.makeButton({ title: 'src/b.ts' }), 2));
  const rev2 = env2.posted.filter((m) => m.type === 'reveal')[0];
  ok(rev2.cwd === undefined, '取不到 cwd 时不带该字段（不传空串）');

  // 失败结果也进日志（用户报「只开侧栏」时能看到宿主回了 failed + 原因码）
  env2.hostMessage({ source: 'dsh-vscode-host', type: 'reveal-result', token: rev2.token, ok: false, reason: 'no-text' });
  ok(env2.win.__dshVscodeFileLinks.log()[0].result === 'failed', '宿主回失败时日志记 failed');
  ok(env2.win.__dshVscodeFileLinks.log()[0].reason === 'no-text', '日志记下失败原因码（断点可定位）');
}

console.log('\n全部通过：' + passed + ' 项断言 ✓');
process.exit(0);
