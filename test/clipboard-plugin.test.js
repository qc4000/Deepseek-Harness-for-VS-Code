'use strict';
/**
 * 内置剪贴板兼容插件（dsh-webview-clipboard，PR #11）生成文件测试。
 * 运行：node test/clipboard-plugin.test.js
 * 重点：client.js 由模板字面量生成，正则转义一旦写错会让所有平台的
 * DSH 页面加载失败——这里对生成结果做真实语法检查（node --check）。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const vm = require('vm');
const Module = require('module');

const config = {};
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (Object.prototype.hasOwnProperty.call(config, k) ? config[k] : d) }),
    workspaceFolders: []
  },
  env: { remoteName: undefined },
  window: {},
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const { clipboardPluginFiles, CLIPBOARD_PLUGIN_NAME } = ext.__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

const files = clipboardPluginFiles();
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clip-'));
for (const rel of Object.keys(files)) {
  const dest = path.join(base, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, files[rel], 'utf8');
}

console.log('[1] 文件齐全');
ok(files['package.json'] && files['lib/index.js'] && files['lib/client.js'] && files['cordis.patch.yml'], '四个文件齐全');
ok(files['lib/client.js'].includes(CLIPBOARD_PLUGIN_NAME), 'client.js 带插件 id');

console.log('[2] package.json 可解析且声明正确');
const pkg = JSON.parse(files['package.json']);
ok(pkg.name === CLIPBOARD_PLUGIN_NAME, 'name 正确');
ok(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', 'client.platform=web');
ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'bundle.patch 指向 cordis.patch.yml（与真实插件惯例一致的字符串形式）');

console.log('[3] 生成 JS 语法真实校验（node --check）');
for (const js of ['lib/index.js', 'lib/client.js']) {
  const r = spawnSync(process.execPath, ['--check', path.join(base, js)], { encoding: 'utf8' });
  ok(r.status === 0, js + ' 语法通过' + (r.status !== 0 ? '：' + (r.stderr || '').slice(0, 300) : ''));
}

console.log('[4] 正则转义未被模板字面量折叠（作者标注的前车之鉴）');
ok(files['lib/client.js'].includes('/Electron\\//'), 'Electron 正则保留反斜杠转义（/Electron\\/ 匹配 "Electron/"）');

console.log('[5] 激活门与安全阀存在');
ok(files['lib/client.js'].includes('inIframe()') && files['lib/client.js'].includes('isMac()') && files['lib/client.js'].includes('inElectron()'), '三重激活门（iframe+macOS+Electron）');
ok(files['lib/client.js'].includes('defaultPrevented'), '尊重 DSH 已处理的按键');
ok(files['lib/client.js'].includes('229'), 'IME 组合中不干预');

console.log('[6] 作用域收敛（PR #14）：仅剪贴板三键，不再模拟编辑键');
ok(files['lib/client.js'].includes("cmd = 'paste'") && files['lib/client.js'].includes("cmd = 'copy'") && files['lib/client.js'].includes("cmd = 'cut'"), '⌘C/⌘V/⌘X 经 execCommand 处理');
ok(!files['lib/client.js'].includes('selectAll'), '⌘A 不再拦截（原生可用）');
ok(!files['lib/client.js'].includes("'redo'"), '撤销/重做不再拦截');
ok(!files['lib/client.js'].includes('target.setSelectionRange') && !files['lib/client.js'].includes('target.value'), '不再对事件目标模拟光标（contentEditable 下 el.value 会崩）');
ok(!files['lib/client.js'].includes('el.value'), '不再读取 el.value（contentEditable 无此属性）');
// execCommand 兜底仍需要临时 textarea：只允许对新建的 area 读写 value/selection。
ok(files['lib/client.js'].includes('area.value = text') && files['lib/client.js'].includes('area.setSelectionRange(0, text.length)'), 'execCommand 兜底仅操作临时 textarea');

console.log('[6b] cordis.patch.yml 结构');
ok(/-\s*insert:/.test(files['cordis.patch.yml']), 'insert 行存在');
ok(files['cordis.patch.yml'].includes("name: '" + CLIPBOARD_PLUGIN_NAME + "'"), 'name 与包名一致');

// =====================================================================
// 7. 复制按钮回退（spec 007）：生成物契约
// =====================================================================
console.log('[7] 复制按钮回退：生成物契约');
const { CLIPBOARD_MAX_TEXT } = ext.__internals;
ok(files['lib/client.js'].includes('clipboard-write'), 'client.js 使用独立消息类型 clipboard-write');
ok(files['lib/client.js'].includes("source: SOURCE_ID") || files['lib/client.js'].includes("source: '" + CLIPBOARD_PLUGIN_NAME + "'"), '消息带插件 source');
ok(files['lib/client.js'].includes('clipboard-result'), '监听宿主回执 clipboard-result');
ok(files['lib/client.js'].includes('execCommand'), 'execCommand 兜底仍在');
ok(!files['lib/client.js'].includes('readText'), '不覆盖 readText（粘贴路径不在本次范围）');
ok(!files['lib/client.js'].includes('click'), '不拦截复制按钮的 click');
ok(Number.isFinite(CLIPBOARD_MAX_TEXT) && CLIPBOARD_MAX_TEXT > 0, 'CLIPBOARD_MAX_TEXT 已导出且为正数');

// =====================================================================
// 8. 客户端仿真：只在 iframe 内接管 writeText，三级回退
// =====================================================================
console.log('[8] 客户端仿真：三级回退');

/**
 * 在 vm 里跑生成的 client.js。
 * @param {{iframe?: boolean, native?: 'ok'|'fail', exec?: boolean}} opts
 */
function makeClientRealm(opts = {}) {
  const parentMessages = [];
  const winListeners = [];
  const timers = [];
  const documentCalls = { exec: 0, lastValue: null };
  let timerSeq = 1;
  let clientExports = null;

  const parent = {
    postMessage: (payload, origin) => parentMessages.push({ payload, origin })
  };
  const doc = {
    createElement: (tag) => ({
      tagName: String(tag).toUpperCase(),
      style: {},
      value: '',
      parentNode: null,
      setAttribute() {},
      select() {},
      setSelectionRange() {}
    }),
    body: {
      appendChild(el) { el.parentNode = doc.body; documentCalls.lastValue = el.value },
      removeChild(el) { el.parentNode = null }
    },
    execCommand: () => { documentCalls.exec += 1; return opts.exec !== false },
    addEventListener() {}
  };
  const nav = {
    // Linux + Electron：复制按钮问题与 macOS 快捷键无关，shim 不应依赖 mac 门控。
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Electron/28.0.0 Chrome/120 Safari/537.36',
    platform: 'Linux x86_64',
    clipboard: {
      writeText: opts.native === 'ok'
        ? async function () { documentCalls.native = (documentCalls.native || 0) + 1 }
        : async function () { documentCalls.native = (documentCalls.native || 0) + 1; throw new Error('Write permission denied') }
    }
  };
  const win = {
    parent: opts.iframe === false ? null : parent,
    addEventListener: (type, fn) => winListeners.push({ type, fn }),
    removeEventListener() {}
  };
  win.parent = opts.iframe === false ? win : parent;
  win.__ModuleLoader__ = {
    load: (def) => { clientExports = def.factory(() => ({})); }
  };

  const sandbox = {
    window: win,
    navigator: nav,
    document: doc,
    console: { warn() {}, error() {}, log() {} },
    setTimeout: (fn, ms) => { const id = timerSeq++; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
  };
  vm.createContext(sandbox);
  vm.runInContext(String(files['lib/client.js']), sandbox, { filename: 'clipboard-client.js' });
  if (!clientExports) throw new Error('client.js 未注册 ModuleLoader 模块');

  return {
    nav,
    win,
    parentMessages,
    documentCalls,
    clientExports,
    /** 模拟宿主回执（window message）。 */
    receive: (data, source) => winListeners.filter((l) => l.type === 'message').forEach((l) => l.fn({ data, source: source || parent })),
    /** 触发待执行的 setTimeout（宿主回执超时）。 */
    runTimers: () => { for (const t of timers.splice(0)) t.fn(); }
  };
}

const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log('[8a] 原生可用：直接成功，不发消息');
  {
    const realm = makeClientRealm({ native: 'ok' });
    realm.clientExports.apply();
    await realm.nav.clipboard.writeText('hello');
    ok(realm.documentCalls.native === 1, '调用原生 writeText');
    ok(realm.parentMessages.length === 0, '原生成功不向宿主发消息');
  }

  console.log('[8b] 原生被拒：走宿主通道并等待回执');
  {
    const realm = makeClientRealm({ native: 'fail' });
    realm.clientExports.apply();
    const p = realm.nav.clipboard.writeText('代码块内容');
    await flush();
    ok(realm.parentMessages.length === 1, '发出恰一条 clipboard-write');
    const msg = realm.parentMessages[0].payload;
    ok(msg.source === CLIPBOARD_PLUGIN_NAME && msg.type === 'clipboard-write', 'source/type 正确');
    ok(msg.text === '代码块内容' && typeof msg.token === 'string', '携带原文与 token');
    realm.receive({ source: 'dsh-vscode-host', type: 'clipboard-result', token: msg.token, ok: true });
    await p;
    ok(realm.documentCalls.exec === 0, '宿主成功时不再走 execCommand');
  }

  console.log('[8c] 宿主无回执：1.5s 后 execCommand 兜底（旧宿主）');
  {
    const realm = makeClientRealm({ native: 'fail' });
    realm.clientExports.apply();
    const p = realm.nav.clipboard.writeText('fallback');
    await flush();
    ok(realm.parentMessages.length === 1, '先尝试宿主');
    realm.runTimers();
    await p;
    ok(realm.documentCalls.exec === 1, '超时后调用 execCommand');
    ok(realm.documentCalls.lastValue === 'fallback', 'textarea 写入原文');
  }

  console.log('[8d] 宿主回执失败：同样 execCommand 兜底');
  {
    const realm = makeClientRealm({ native: 'fail' });
    realm.clientExports.apply();
    const p = realm.nav.clipboard.writeText('x');
    await flush();
    realm.receive({ source: 'dsh-vscode-host', type: 'clipboard-result', token: realm.parentMessages[0].payload.token, ok: false });
    await p;
    ok(realm.documentCalls.exec === 1, '回执 ok:false 时走 execCommand');
  }

  console.log('[8e] 非 iframe：不接管');
  {
    const realm = makeClientRealm({ iframe: false, native: 'fail' });
    const original = realm.nav.clipboard.writeText;
    realm.clientExports.apply();
    ok(realm.nav.clipboard.writeText === original, '系统浏览器直接打开 DSH 时不包装');
  }

  console.log('[8f] 回执 token 不匹配：不误结算');
  {
    const realm = makeClientRealm({ native: 'fail' });
    realm.clientExports.apply();
    const p = realm.nav.clipboard.writeText('y');
    await flush();
    realm.receive({ source: 'dsh-vscode-host', type: 'clipboard-result', token: 'other', ok: true });
    realm.runTimers();
    await p;
    ok(realm.documentCalls.exec === 1, '未知 token 被忽略，仍走兜底');
  }

  console.log('[9] 开关与忠实窗口约束');
  {
    delete config['dshPanel.installClipboardPlugin'];
    ok(ext.__internals.shouldInstallClipboardPlugin() === true, '默认安装插件');
    config['dshPanel.installClipboardPlugin'] = false;
    ok(ext.__internals.shouldInstallClipboardPlugin() === false, '关闭开关后不安装（AC-4）');
    delete config['dshPanel.installClipboardPlugin'];
    ok(!files['lib/client.js'].includes("addEventListener('click'"), '不监听 click（不拦复制按钮）');
    ok(files['lib/client.js'].includes('copyFallback'), '状态里暴露 copyFallback 便于排障');
  }

  fs.rmSync(base, { recursive: true, force: true });
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})();
