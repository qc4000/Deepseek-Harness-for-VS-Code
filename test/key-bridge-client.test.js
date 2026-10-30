'use strict';
/**
 * dsh-vscode-keys 客户端半边的行为仿真（spec 008）。
 * 运行：node test/key-bridge-client.test.js
 *
 * 用最小 window/ModuleLoader 仿真把真实 client.js 跑起来，验证最容易出错的语义：
 *  - 未握手前不注册 keydown（不介入）；
 *  - 握手后：命中转发键 → preventDefault + 只上报物理键事实（不带命令 id）；
 *  - DSH 的键位目录里有的组合一律让位（不 preventDefault、不发消息）；
 *  - 目录订阅：用户改绑 DSH 键位后让位判定立即跟随；
 *  - 拿不到 shortcuts 服务 → 降级上报但仍然转发；
 *  - F6 → focus-release；独立浏览器 → 完全不介入；
 *  - IME 组合 / 长按 / 页面已处理 → 不拦截。
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
  path.join(__dirname, '..', 'dsh-plugins', 'dsh-vscode-keys', 'lib', 'client.js'),
  'utf8'
);

/** 伪造 DSH 的 shortcuts 服务（catalog 可编辑绑定 + fixedCatalog 固定动作 + 订阅）。 */
function makeShortcuts(initial, fixed) {
  let rows = initial.slice();
  const fixedRows = (fixed || [{ code: 'Enter', modifiers: [] }]).map((binding) => ({ id: 'fixed.send', bindings: [binding] }));
  let listeners = [];
  return {
    catalog: {
      getSnapshot: () => rows.map((binding, i) => ({ id: 'cmd.' + i, binding })),
      subscribe: (fn) => {
        listeners.push(fn);
        return () => { listeners = listeners.filter((l) => l !== fn); };
      }
    },
    fixedCatalog: {
      getSnapshot: () => fixedRows,
      subscribe: () => () => {}
    },
    set(next) {
      rows = next;
      for (const fn of listeners.slice()) fn();
    }
  };
}

/** 伪造 DSH 的 conversation 服务（`input.for(ctx).focus()`）。 */
function makeConversation(behaviour) {
  const focused = { count: 0 };
  return {
    focused,
    input: {
      for: () => {
        if (behaviour === 'throw') throw new Error('conversation.input.for requires a retained Session scope');
        return { focus: () => { focused.count += 1; } };
      }
    }
  };
}

/** 造一个仿真环境：window + ModuleLoader；返回可驱动的句柄。 */
function makeEnv(options = {}) {
  const posted = [];      // 插件 → 父级（webview）
  const windowListeners = [];
  const timers = [];
  let timerSeq = 1;

  const win = {
    localStorage: { getItem: (key) => (key === 'dsh.keybindings.v1' ? '{"v":1}' : null) },
    addEventListener: (type, fn) => windowListeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = windowListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) windowListeners.splice(i, 1);
    },
    setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; },
    setInterval: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
  };
  win.parent = options.standalone ? win : { isParent: true, postMessage: (p) => posted.push(p) };

  let loaded = null;
  win.__ModuleLoader__ = { load: (def) => { loaded = def; } };
  const sandbox = {
    window: win,
    console: { warn() {}, error() {}, log() {} }
  };
  // DSH 弹窗（按键录制 / 设置）与 composer 的探测：只有显式提供才装 document。
  if (options.modal || options.composer) {
    sandbox.document = {
      querySelector: (sel) => {
        if (sel.indexOf('aria-modal') >= 0) return options.modal ? { isModal: true } : null;
        if (sel.indexOf('data-conversation-region') >= 0) return options.composer || null;
        return null;
      }
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(clientSource, sandbox, { filename: 'dsh-vscode-keys-client.js' });
  const mod = loaded.factory(() => ({}));

  const ctx = { effect: (fn) => { disposer = fn(); } };
  let disposer = null;
  if (options.shortcuts !== undefined) ctx.shortcuts = options.shortcuts;
  if (options.conversation !== undefined) ctx.conversation = options.conversation;

  function apply() {
    mod.apply(ctx);
    return { dispose: () => { if (disposer) disposer(); } };
  }

  function deliverToWindow(type, data, source) {
    for (const l of windowListeners.filter((x) => x.type === type).slice()) {
      l.fn({ data, source: source === undefined ? win.parent : source });
    }
  }

  /** 派发一次 keydown，返回事件（看 defaultPrevented / stopped）。 */
  function keydown(props) {
    const event = {
      type: 'keydown',
      code: props.code === undefined ? 'KeyP' : props.code,
      ctrlKey: !!props.ctrl,
      metaKey: !!props.meta,
      altKey: !!props.alt,
      shiftKey: !!props.shift,
      repeat: !!props.repeat,
      isComposing: !!props.composing,
      keyCode: props.keyCode === undefined ? 0 : props.keyCode,
      defaultPrevented: !!props.defaultPrevented,
      stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }
    };
    for (const l of windowListeners.filter((x) => x.type === 'keydown').slice()) l.fn(event);
    return event;
  }

  return {
    posted,
    windowListeners,
    apply,
    deliverToWindow,
    keydown,
    /** 模拟宿主下发转发表。 */
    ack(table, releaseKey) {
      deliverToWindow('message', {
        source: 'dsh-vscode-host',
        type: 'keys-ack',
        table: table || { 'KeyP|1|0|0|1': true, 'KeyF|0|1|0|1': true },
        releaseKey: releaseKey === undefined ? 'F6|0|0|0|0' : releaseKey
      });
    },
    keys: () => posted.filter((m) => m.type === 'key'),
    statuses: () => posted.filter((m) => m.type === 'keys-status'),
    releases: () => posted.filter((m) => m.type === 'focus-release'),
    focusResults: () => posted.filter((m) => m.type === 'focus-input-result'),
    /** 页面里的 __dshVscodeKeys 排障句柄。 */
    debugApi: () => win.__dshVscodeKeys
  };
}

(async () => {
  console.log('[1] 独立浏览器（parent === self）：完全不介入');
  {
    const env = makeEnv({ standalone: true });
    env.apply();
    ok(env.posted.length === 0, '不打招呼');
    ok(env.windowListeners.length === 0, '不注册任何监听器');
  }

  console.log('[2] 握手前不介入');
  {
    const env = makeEnv();
    env.apply();
    ok(env.posted.some((m) => m.type === 'hello' && m.source === 'dsh-vscode-keys'), '先打招呼');
    const ev = env.keydown({ code: 'KeyP', ctrl: true, shift: true });
    ok(ev.defaultPrevented === false, '没收到 keys-ack 前不拦截');
    ok(env.keys().length === 0, '也不发转发消息');
  }

  console.log('[3] 握手后：命中键拦截并只上报物理键事实');
  {
    const env = makeEnv({ shortcuts: makeShortcuts([]) });
    env.apply();
    env.ack();
    ok(env.statuses().length === 1, '握手后回报一次状态');
    ok(env.statuses()[0].degraded === false, '有 DSH 目录时不降级');

    const ev = env.keydown({ code: 'KeyP', ctrl: true, shift: true });
    ok(ev.defaultPrevented === true && ev.stopped === true, '命中键 preventDefault + stopPropagation');
    const keys = env.keys();
    ok(keys.length === 1, '恰好一条 key 消息');
    ok(keys[0].gesture.code === 'KeyP' && keys[0].gesture.ctrl === true && keys[0].gesture.shift === true, 'gesture 描述物理键');
    ok(keys[0].gesture.command === undefined && keys[0].command === undefined, '不携带命令 id（页面无法指定命令）');
    ok(Object.keys(keys[0].gesture).length === 5, 'gesture 只有 5 个白名单字段');
  }

  console.log('[4] DSH 已占用的组合一律让位');
  {
    const shortcuts = makeShortcuts([{ code: 'KeyF', modifiers: ['meta', 'shift'] }]);
    const env = makeEnv({ shortcuts });
    env.apply();
    env.ack();
    const status = env.statuses()[0];
    ok(status.shadowed.length === 1, '让位清单含 DSH 占用的键');
    ok(status.shadowed[0].sig === 'KeyF|0|1|0|1' && status.shadowed[0].command === 'cmd.0', '让位项带 DSH 命令 id');

    const ev = env.keydown({ code: 'KeyF', meta: true, shift: true });
    ok(ev.defaultPrevented === false && ev.stopped === false, 'DSH 优先：不拦截');
    ok(env.keys().length === 0, '也不发转发消息');
  }

  console.log('[5] 目录订阅：DSH 改绑后让位判定立即跟随');
  {
    const shortcuts = makeShortcuts([]);
    const env = makeEnv({ shortcuts });
    env.apply();
    env.ack();
    ok(env.keydown({ code: 'KeyP', ctrl: true, shift: true }).defaultPrevented === true, '未占用时转发');
    shortcuts.set([{ code: 'KeyP', modifiers: ['control', 'shift'] }]);
    const refreshed = env.statuses()[env.statuses().length - 1];
    ok(refreshed.shadowed.some((row) => row.sig === 'KeyP|1|0|0|1'), '改绑后进入让位清单');
    ok(env.keydown({ code: 'KeyP', ctrl: true, shift: true }).defaultPrevented === false, '改绑后不再拦截');
  }

  console.log('[6] 拿不到 shortcuts 服务：降级上报但继续转发');
  {
    const env = makeEnv();
    env.apply();
    env.ack();
    ok(env.statuses()[0].degraded === true, '状态标记降级');
    ok(env.keydown({ code: 'KeyP', ctrl: true, shift: true }).defaultPrevented === true, '降级仍按表转发');
    ok(env.keys().length === 1, '降级也发转发消息');
  }

  console.log('[7] F6：焦点交还');
  {
    const env = makeEnv({ shortcuts: makeShortcuts([]) });
    env.apply();
    env.ack();
    const ev = env.keydown({ code: 'F6' });
    ok(ev.defaultPrevented === true, '拦截 F6');
    ok(env.releases().length === 1, '发 focus-release');
    ok(env.keys().length === 0, 'F6 不当作转发键');
    const off = makeEnv({ shortcuts: makeShortcuts([]) });
    off.apply();
    off.ack(null, null);
    const evOff = off.keydown({ code: 'F6' });
    ok(evOff.defaultPrevented === false && off.releases().length === 0, 'releaseKey 为空时不接管 F6');
  }

  console.log('[8] 不拦截的场景：IME / 长按 / 页面已处理 / 不在表里');
  {
    const env = makeEnv({ shortcuts: makeShortcuts([]) });
    env.apply();
    env.ack();
    ok(env.keydown({ code: 'KeyP', ctrl: true, shift: true, composing: true }).defaultPrevented === false, 'IME 组合中不干预');
    ok(env.keydown({ code: 'KeyP', ctrl: true, shift: true, keyCode: 229 }).defaultPrevented === false, 'keyCode 229（IME）不干预');
    ok(env.keydown({ code: 'KeyP', ctrl: true, shift: true, repeat: true }).defaultPrevented === false, '长按重复不触发');
    ok(env.keydown({ code: 'KeyP', ctrl: true, shift: true, defaultPrevented: true }).defaultPrevented === true, '页面已处理则尊重之');
    ok(env.keydown({ code: 'KeyQ', ctrl: true, alt: true }).defaultPrevented === false, '不在表里的键不拦');
    ok(env.keys().length === 0, '以上都不产生转发消息');
  }

  console.log('[9] 消息来源校验与卸载');
  {
    const env = makeEnv({ shortcuts: makeShortcuts([]) });
    const handle = env.apply();
    env.deliverToWindow('message', { source: 'dsh-vscode-host', type: 'keys-ack', table: {} }, { isParent: false });
    ok(env.keydown({ code: 'KeyP', ctrl: true, shift: true }).defaultPrevented === false, '非父级发来的 ack 不被采信');

    env.ack();
    ok(env.keydown({ code: 'KeyP', ctrl: true, shift: true }).defaultPrevented === true, '父级 ack 生效');
    handle.dispose();
    ok(env.windowListeners.length === 0, 'dispose 后监听器全部移除');
    ok(env.keydown({ code: 'KeyP', ctrl: true, shift: true }).defaultPrevented === false, '卸载后不再拦截');
  }

  console.log('[10] DSH fixedCatalog 里的固定动作也参与让位');
  {
    const env = makeEnv({ shortcuts: makeShortcuts([], [{ code: 'KeyP', modifiers: ['control', 'shift'] }]) });
    env.apply();
    env.ack();
    const status = env.statuses()[0];
    ok(status.shadowed.length === 1 && status.shadowed[0].command === 'fixed.send', '固定动作进入让位清单');
    ok(env.keydown({ code: 'KeyP', ctrl: true, shift: true }).defaultPrevented === false, '被固定动作占用的键让位');
  }

  console.log('[11] DSH 弹窗打开时不抢键（否则会抢走「按键录制」）');
  {
    const env = makeEnv({ shortcuts: makeShortcuts([]), modal: true });
    env.apply();
    env.ack();
    ok(env.keydown({ code: 'KeyP', ctrl: true, shift: true }).defaultPrevented === false, '弹窗内不拦截');
    ok(env.keys().length === 0, '弹窗内不转发');
    ok(env.keydown({ code: 'F6' }).defaultPrevented === false, '弹窗内也不抢 F6');
  }

  console.log('[12] 排障 API：能看到我们认定的 DSH 键位');
  {
    const env = makeEnv({ shortcuts: makeShortcuts([{ code: 'Comma', modifiers: ['control', 'shift'] }]) });
    env.apply();
    env.ack();
    const debug = env.debugApi();
    ok(debug.status().catalogRows === 1 && debug.status().fixedRows === 1, '状态包含目录规模');
    ok(debug.bindings().indexOf('Comma|1|0|0|1') !== -1, 'bindings() 列出 DSH 占用的签名');
    ok(debug.owner('Comma|1|0|0|1') === 'cmd.0', 'owner() 返回 DSH 命令 id');
    ok(debug.owner('KeyP|1|0|0|1') === '', '未占用返回空串');
    ok(debug.refresh().dshBindings === 2, 'refresh() 可手动重读目录（1 条可编辑 + 1 条固定动作）');
    const rows = debug.rows();
    ok(rows.length === 1 && rows[0].id === 'cmd.0', 'rows() 只列出「有绑定」的行');
    ok(rows[0].binding.code === 'Comma' && rows[0].binding.modifiers.indexOf('control') >= 0, 'rows() 保留归一化后的绑定');
    ok(debug.prefs() === '{"v":1}', 'prefs() 返回 DSH 持久化原文');
  }

  console.log('[13] focus-input：服务优先 → DOM 回退 → 失败回报');
  {
    const conv = makeConversation('ok');
    const env = makeEnv({ shortcuts: makeShortcuts([]), conversation: conv });
    env.apply();
    env.ack();
    env.deliverToWindow('message', { source: 'dsh-vscode-host', type: 'focus-input' });
    ok(conv.focused.count === 1, '走 conversation.input.for(ctx).focus()');
    ok(env.focusResults().length === 1 && env.focusResults()[0].ok === true, '回报 ok:true');

    const composer = { focused: 0, caret: 0, value: '草稿', focus() { this.focused += 1; }, setSelectionRange(s, e) { this.caret = e; } };
    const env2 = makeEnv({ shortcuts: makeShortcuts([]), conversation: makeConversation('throw'), composer });
    env2.apply();
    env2.ack();
    env2.deliverToWindow('message', { source: 'dsh-vscode-host', type: 'focus-input' });
    ok(composer.focused === 1, '会话 scope 不可用时回退到 composer DOM');
    ok(composer.caret === 2, '光标移到草稿末尾（不覆盖已有内容）');
    ok(env2.focusResults()[0].ok === true, '回退成功也回报 ok:true');

    const env3 = makeEnv({ shortcuts: makeShortcuts([]) });
    env3.apply();
    env3.ack();
    env3.deliverToWindow('message', { source: 'dsh-vscode-host', type: 'focus-input' });
    ok(env3.focusResults().length === 1 && env3.focusResults()[0].ok === false, '无会话也无 composer 回报 ok:false');
  }

  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
