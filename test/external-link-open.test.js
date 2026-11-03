'use strict';
/**
 * 面板内新窗口/新标签外链的宿主路由测试（spec 014）。
 * 运行：node test/external-link-open.test.js
 *
 * 覆盖：
 *  1) dshPanel.externalLinkAction 默认值 / 三值 / 非法值回退
 *  2) parseHttpUrl：只放行 http(s)，限制长度
 *  3) routeOpenLink：systemBrowser / vscodeBrowser / off / login / popup 分支
 *  4) simpleBrowser.show 失败 → 状态栏提示一次 + 回退系统浏览器
 *  5) openExternal 返回 false → 可见提示（只一次）
 *  6) 真远程 + 回环 + vscodeBrowser → 先 asExternalUri
 *  7) package.json 配置项；插件 0.2.0 落盘 / 幂等 / 不写 dependencies
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const Module = require('module');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

const KEY = 'dshPanel.externalLinkAction';
const openedExternal = [];
const executed = [];
const statusMessages = [];
const warnings = [];
const configValues = {};

let executeImpl = async () => {};
let openExternalImpl = async () => true;
let asExternalUriImpl = async (uri) => uri;

const vscodeStub = {
  FileType: { File: 1, Directory: 2 },
  Uri: {
    parse: (u) => ({ toString: () => u, _url: u }),
    file: (p) => ({ fsPath: path.resolve(p), toString: () => 'file://' + p }),
    joinPath: (base, ...segs) => vscodeStub.Uri.file(path.resolve(base.fsPath, ...segs))
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (k, d) => (Object.prototype.hasOwnProperty.call(configValues, k) ? configValues[k] : d)
    }),
    fs: { stat: async () => ({ type: 1 }) },
    onDidChangeConfiguration: () => ({ dispose() {} })
  },
  env: {
    remoteName: undefined,
    openExternal: (uri) => {
      openedExternal.push(String(uri));
      return openExternalImpl(uri);
    },
    asExternalUri: (uri) => asExternalUriImpl(uri)
  },
  window: {
    setStatusBarMessage: (text) => { statusMessages.push(text); return { dispose() {} }; },
    showInformationMessage: () => {},
    showErrorMessage: () => {},
    showWarningMessage: (text) => { warnings.push(text); }
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: (...args) => {
      executed.push(args);
      return executeImpl(...args);
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

function clearConfig() {
  for (const k of Object.keys(configValues)) delete configValues[k];
}

function resetCalls() {
  openedExternal.length = 0;
  executed.length = 0;
}

function statusCount(fragment) {
  return statusMessages.filter((s) => s.indexOf(fragment) >= 0).length;
}

(async function run() {
  console.log('[1] 配置与 URL 净化');
  {
    clearConfig();
    ok(I.EXTERNAL_LINK_ACTION_KEY === KEY, '扩展常量与配置键一致');
    ok(I.EXTERNAL_LINK_ACTIONS.join(',') === 'off,systemBrowser,vscodeBrowser', '三个合法值');
    ok(I.externalLinkAction() === 'systemBrowser', '默认 systemBrowser');
    configValues[KEY] = 'off';
    ok(I.externalLinkAction() === 'off', 'off 生效');
    configValues[KEY] = 'vscodeBrowser';
    ok(I.externalLinkAction() === 'vscodeBrowser', 'vscodeBrowser 生效');
    configValues[KEY] = 'bogus';
    ok(I.externalLinkAction() === 'systemBrowser', '非法值回退 systemBrowser');

    ok(I.parseHttpUrl('https://example.com/a') === 'https://example.com/a', 'https 原样通过');
    ok(I.parseHttpUrl('  http://example.com  ') === 'http://example.com/', '去空白并规范化');
    ok(I.parseHttpUrl('HTTPS://EXAMPLE.COM/A') === 'https://example.com/A', '协议/主机小写化');

    const bad = [
      ['javascript:', 'javascript:alert(1)'],
      ['file:', 'file:///etc/passwd'],
      ['data:', 'data:text/html,x'],
      ['mailto:', 'mailto:a@b.com'],
      ['空串', ''],
      ['非字符串', 123],
      ['超长', 'https://example.com/' + 'x'.repeat(9000)]
    ];
    for (const [name, value] of bad) {
      ok(I.parseHttpUrl(value) === null, name + ' 被拒绝');
    }
  }

  console.log('[2] 宿主路由：systemBrowser / vscodeBrowser / off / login');
  {
    clearConfig();
    resetCalls();
    await I.routeOpenLink('https://example.com/a', 'link');
    ok(openedExternal.length === 1 && openedExternal[0] === 'https://example.com/a', 'systemBrowser 走 openExternal');
    ok(executed.length === 0, 'systemBrowser 不调 simpleBrowser');

    configValues[KEY] = 'vscodeBrowser';
    resetCalls();
    await I.routeOpenLink('https://example.com/b', 'link');
    ok(executed.length === 1 && executed[0][0] === 'simpleBrowser.show' && executed[0][1] === 'https://example.com/b', 'vscodeBrowser 走 simpleBrowser.show');
    ok(openedExternal.length === 0, 'vscodeBrowser 成功时不回退');
    await I.routeOpenLink('https://example.com/pop', 'popup');
    ok(executed.length === 2 && openedExternal.length === 0, 'vscodeBrowser 下 window.open（popup）也跟随设置');

    configValues[KEY] = 'off';
    resetCalls();
    await I.routeOpenLink('https://example.com/c', 'link');
    ok(openedExternal.length === 0 && executed.length === 0, 'off 的 link 不打开');
    await I.routeOpenLink('https://example.com/d', 'popup');
    ok(openedExternal.length === 1 && openedExternal[0] === 'https://example.com/d', 'off 仍保留 window.open（popup）系统浏览器');
    await I.routeOpenLink('https://example.com/e', 'login');
    ok(openedExternal.length === 2, 'off 的 login 仍系统浏览器');

    configValues[KEY] = 'vscodeBrowser';
    resetCalls();
    await I.routeOpenLink('https://example.com/f', 'login');
    ok(openedExternal.length === 1 && executed.length === 0, 'vscodeBrowser 下 login 仍固定系统浏览器');

    resetCalls();
    ok((await I.routeOpenLink('javascript:alert(1)', 'link')) === false, '非法 scheme 返回 false');
    ok((await I.routeOpenLink('https://x/' + 'y'.repeat(9000), 'link')) === false, '超长返回 false');
    ok(openedExternal.length === 0 && executed.length === 0, '非法输入不打开');
  }

  console.log('[3] 内置浏览器失败：状态栏提示一次 + 回退系统浏览器');
  {
    configValues[KEY] = 'vscodeBrowser';
    executeImpl = async () => { throw new Error('command not found: simpleBrowser.show'); };
    resetCalls();
    await I.routeOpenLink('https://example.com/fallback', 'link');
    ok(openedExternal.length === 1, '回退 vscode.env.openExternal');
    ok(statusCount('VS Code 内置浏览器不可用') === 1, '状态栏提示一次');
    resetCalls();
    await I.routeOpenLink('https://example.com/fallback2', 'link');
    ok(statusCount('VS Code 内置浏览器不可用') === 1, '同类失败不重复提示');
    executeImpl = async () => {};
  }

  console.log('[4] 系统浏览器失败：可见提示（只一次）');
  {
    clearConfig();
    openExternalImpl = async () => false;
    resetCalls();
    await I.routeOpenLink('https://example.com/fail', 'link');
    ok(statusCount('系统浏览器未能打开该链接') === 1, 'openExternal=false 有提示');
    resetCalls();
    await I.routeOpenLink('https://example.com/fail2', 'link');
    ok(statusCount('系统浏览器未能打开该链接') === 1, '同类失败不重复提示');
    openExternalImpl = async () => true;
  }

  console.log('[5] 真远程 + 回环 + vscodeBrowser：先 asExternalUri');
  {
    configValues[KEY] = 'vscodeBrowser';
    vscodeStub.env.remoteName = 'ssh-remote';
    asExternalUriImpl = async () => ({ toString: () => 'http://127.0.0.1:4567/' });
    resetCalls();
    await I.routeOpenLink('http://127.0.0.1:3000/x', 'link');
    ok(executed.length === 1 && executed[0][1] === 'http://127.0.0.1:4567/', 'simpleBrowser 收到转发后的地址');
    ok(openedExternal.length === 0, '转发成功不回退系统浏览器');

    // 转发失败：回环地址在客户端必然打不开，退回 openExternal（它会自动解析远程）。
    asExternalUriImpl = async () => { throw new Error('tunnel unavailable'); };
    resetCalls();
    await I.routeOpenLink('http://127.0.0.1:3000/y', 'link');
    ok(openedExternal.length === 1 && openedExternal[0] === 'http://127.0.0.1:3000/y', '转发失败回退系统浏览器');

    vscodeStub.env.remoteName = undefined;
    asExternalUriImpl = async (uri) => uri;
  }

  console.log('[6] handleWebviewMessage：kind 白名单与 off 语义');
  {
    const wv = { postMessage: () => {} };
    clearConfig();
    resetCalls();
    I.handleWebviewMessage({ type: 'dsh-open-link', url: 'https://example.com/h', kind: 'link' }, wv);
    await Promise.resolve();
    ok(openedExternal.length === 1, 'kind=link 默认 system 打开');

    configValues[KEY] = 'off';
    resetCalls();
    I.handleWebviewMessage({ type: 'dsh-open-link', url: 'https://example.com/h2', kind: 'link' }, wv);
    await Promise.resolve();
    ok(openedExternal.length === 0, 'off 时 link 不打开');
    I.handleWebviewMessage({ type: 'dsh-open-link', url: 'https://example.com/h3', kind: 'popup' }, wv);
    await Promise.resolve();
    ok(openedExternal.length === 1, 'off 时 popup 仍走系统浏览器');
    I.handleWebviewMessage({ type: 'dsh-open-link', url: 'https://example.com/h4', kind: 'login' }, wv);
    await Promise.resolve();
    ok(openedExternal.length === 2, 'login 仍走系统浏览器');
    resetCalls();
    I.handleWebviewMessage({ type: 'dsh-open-link', url: 'https://example.com/h5', kind: 'evil' }, wv);
    await Promise.resolve();
    ok(openedExternal.length === 1, '非法 kind 收敛为 popup（off 下仍走系统浏览器）');
  }

  console.log('[7] package.json 配置项');
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const prop = manifest.contributes
      && manifest.contributes.configuration
      && manifest.contributes.configuration.properties
      && manifest.contributes.configuration.properties[KEY];
    ok(!!prop, 'dshPanel.externalLinkAction 已登记');
    ok(prop.default === 'systemBrowser', '默认值 systemBrowser');
    ok(Array.isArray(prop.enum) && prop.enum.join(',') === 'off,systemBrowser,vscodeBrowser', 'enum 三个值');
    ok(typeof prop.markdownDescription === 'string' && prop.markdownDescription.indexOf('window.open') >= 0, '说明 off 不影响 window.open 登录链路');
  }

  console.log('[8] 插件 0.2.0 安装 / 幂等 / 不写 dependencies');
  {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-external-link-'));
    const first = await I.ensureOpenExternalPlugin(profile);
    ok(first === true, '首次安装返回 changed=true');
    const installedPkg = JSON.parse(fs.readFileSync(path.join(profile, 'node_modules', 'dsh-vscode-open-external', 'package.json'), 'utf8'));
    ok(installedPkg.version === '0.2.0', '落盘版本 0.2.0');
    const profilePkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
    ok(profilePkg.dsh.profile.bundles.includes('dsh-vscode-open-external'), '登记到 dsh.profile.bundles');
    ok(!profilePkg.dependencies || !profilePkg.dependencies['dsh-vscode-open-external'], '不写 dependencies');
    const second = await I.ensureOpenExternalPlugin(profile);
    ok(second === false, '版本一致时幂等');
    const check = spawnSync(process.execPath, ['--check', path.join(profile, 'node_modules', 'dsh-vscode-open-external', 'lib', 'client.js')], { encoding: 'utf8' });
    ok(check.status === 0, '落盘 client.js 语法通过');
  }

  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
