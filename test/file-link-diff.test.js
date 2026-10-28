'use strict';
/**
 * 轮级变更 diff（规格 005）宿主侧回归测试。运行：node test/file-link-diff.test.js
 *
 * 覆盖四处最容易出错的接缝：
 *  1) 纯函数：坐标净化、匹配候选、标题、二进制/体积判定、路由响应校验；
 *  2) 虚拟文档（dsh-diff:）存取与容量淘汰；
 *  3) 三级降级顺序：P1（轮级）→ P0（HEAD ↔ 工作树）→ L0（普通打开），
 *     以及每一级的用户可见提示；
 *  4) handleWebviewMessage 携带 change 坐标时的链路与回执。
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ACTION_KEY = 'dshPanel.workspaceFileLinkAction';
const executed = [];
const statusMessages = [];
const infoMessages = [];
const errorMessages = [];
let configValues = {};
let diffProvider = null;

function fileUri(p) {
  const fsPath = path.resolve(p);
  return {
    scheme: 'file',
    fsPath: fsPath,
    path: fsPath.replace(/\\/g, '/'),
    toString: () => 'file://' + fsPath.replace(/\\/g, '/')
  };
}

const vscodeStub = {
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  Uri: {
    file: fileUri,
    joinPath: (base, ...segments) => fileUri(path.resolve(base.fsPath, ...segments)),
    parse: (u) => ({
      scheme: String(u).split(':')[0],
      fsPath: '',
      toString: () => String(u)
    })
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (k, d) => (Object.prototype.hasOwnProperty.call(configValues, k) ? configValues[k] : d)
    }),
    fs: {
      stat: async (uri) => {
        const st = await fs.promises.stat(uri.fsPath);
        return { type: st.isDirectory() ? vscodeStub.FileType.Directory : vscodeStub.FileType.File };
      },
      readFile: async (uri) => fs.promises.readFile(uri.fsPath)
    },
    registerTextDocumentContentProvider: (scheme, provider) => {
      diffProvider = { scheme, provider };
      return { dispose() {} };
    },
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} })
  },
  env: { remoteName: undefined, openExternal: () => {} },
  window: {
    activeTextEditor: null,
    showInformationMessage: (t) => { infoMessages.push(t); },
    showErrorMessage: (t) => { errorMessages.push(t); },
    showWarningMessage: (t) => { errorMessages.push(t); },
    setStatusBarMessage: (text) => { statusMessages.push(text); return { dispose() {} }; },
    registerWebviewViewProvider: () => ({ dispose() {} }),
    createWebviewPanel: () => ({ dispose() {} })
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async (...args) => { executed.push(args); }
  },
  ViewColumn: { One: 1 }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}
const REPO = path.resolve(__dirname, '..');
const labelOf = (u) => u.toString();

// ── [1] 纯函数 ────────────────────────────────────────────────────
console.log('[1] 纯函数：坐标、候选、标题、体积');
ok(I.isDiffMode('diffAndOpen') === true && I.isDiffMode('revealAndOpen') === false && I.isDiffMode('off') === false, 'isDiffMode 只认 diffAndOpen');
ok(I.FILE_LINK_ACTIONS.includes('diffAndOpen'), 'diffAndOpen 已加入动作枚举');

const good = I.sanitizeChangeCoord({ sessionId: 'session-ab12', turn: 7 });
ok(good && good.sessionId === 'session-ab12' && good.turn === 7, '合法坐标原样返回');
ok(I.sanitizeChangeCoord({ sessionId: '', turn: 7 }) === null, '空 sessionId 拒绝');
ok(I.sanitizeChangeCoord({ sessionId: 's', turn: 0 }) === null, 'turn=0 拒绝');
ok(I.sanitizeChangeCoord({ sessionId: 's', turn: 1.5 }) === null, '非整数 turn 拒绝');
ok(I.sanitizeChangeCoord({ sessionId: 's', turn: 1000001 }) === null, 'turn 超上限拒绝');
ok(I.sanitizeChangeCoord({ sessionId: 's'.repeat(129), turn: 1 }) === null, 'sessionId 超长拒绝');
ok(I.sanitizeChangeCoord({ sessionId: 's\n', turn: 1 }) === null, 'sessionId 含控制字符拒绝');
ok(I.sanitizeChangeCoord(null) === null && I.sanitizeChangeCoord('x') === null, '非对象输入拒绝');

const cands = I.normalizeChangeCandidates('/w/proj', 'src/a.ts');
ok(cands.includes('src/a.ts') && cands.includes('/w/proj/src/a.ts'), '相对路径同时产出相对与绝对候选');
const candsAbs = I.normalizeChangeCandidates('/w/proj', '/w/proj/src/a.ts');
ok(candsAbs.includes('/w/proj/src/a.ts') && candsAbs.includes('src/a.ts'), '绝对路径回推相对候选');
const candsWin = I.normalizeChangeCandidates('C:/w/proj', 'src\\a.ts');
ok(candsWin.includes('src/a.ts'), '反斜杠写法归一为 /');
ok(I.normalizeChangeCandidates('/w/p', '../outside.ts').includes('../outside.ts'), '保留 ../ 候选（工作区上方文件以 display 匹配）');
ok(I.normalizeChangeCandidates('/w/p', '../outside.ts').includes('/w/outside.ts'), '越界相对路径同时给出绝对候选');

ok(I.buildDiffTitle('src/a.ts', 'turn', 7) === 'a.ts · 第 7 轮', '轮级标题写「第 N 轮」+ 文件名');
ok(I.buildDiffTitle('src/a.ts', 'head') === 'a.ts · 与 HEAD 的差异', 'HEAD 标题与轮级可区分');
ok(I.buildDiffTitle('', 'head') === '文件 · 与 HEAD 的差异', '空标签有兜底文案');

ok(I.hasNulByte(Buffer.from('abc')) === false, '普通文本无 NUL');
ok(I.hasNulByte(Buffer.from([97, 0, 98])) === true, '含 NUL 判为二进制');
ok(I.hasNulByte('a\u0000b') === true, '字符串里的 NUL 同样识别');
ok(I.MAX_DIFF_SIDE_BYTES === 1024 * 1024, '单侧上限 1 MiB');
ok(I.DIFF_TIMEOUT_MS === 6000, '客户端等待上限 6 s（reveal-ack 之后）');

// 404 的三种含义必须映射成不同文案（spec 005 第 8 节）
ok(I.change404Reason(undefined) === 'unavailable', '404 无响应体（插件未装/未重启）→ 提示重启');
ok(I.change404Reason('<html>404</html>') === 'unavailable', '404 非 JSON → 提示重启');
ok(I.change404Reason('{"error":"released"}') === 'released', '404 released → 已随会话释放');
ok(I.change404Reason('{"error":"no-record"}') === 'no-record', '404 no-record → 该轮还没数据');
ok(I.change404Reason('{"error":"unavailable"}') === 'unavailable', '404 unavailable（结构不符）→ 提示重启');
const noTextParsed = I.parseTurnChangeResponse({ matched: true, turn: 4, display: 'a.ts', unavailable: 'no-text' });
ok(noTextParsed.ok === false && noTextParsed.reason === 'no-text' && noTextParsed.turn === 4, 'matched 但取不到全文 → 交给降级链');

// ── [2] 虚拟文档 ──────────────────────────────────────────────────
console.log('[2] dsh-diff 虚拟文档');
const u1 = I.storeDiffDoc('a.ts', 'hello\n');
ok(typeof u1.toString() === 'string' && u1.toString().startsWith('dsh-diff:'), 'URI 使用 dsh-diff: 方案');
ok(diffProvider !== null && diffProvider.scheme === 'dsh-diff', 'provider 已注册到 dsh-diff');
ok(diffProvider.provider.provideTextDocumentContent(u1) === 'hello\n', '内容可读回');
const u2 = I.storeDiffDoc('b.ts', '');
ok(diffProvider.provider.provideTextDocumentContent(u2) === '', '空内容（新增/删除文件）可读回');
for (let i = 0; i < I.DIFF_DOC_MAX_ENTRIES + 10; i += 1) I.storeDiffDoc('x' + i + '.ts', 'x');
ok(diffProvider.provider.provideTextDocumentContent(u1) === '', '超过条目上限后最旧内容被淘汰');
ok(I.diffDocCount() <= I.DIFF_DOC_MAX_ENTRIES, '条目数不超过上限');

// ── [3] 三级降级 ──────────────────────────────────────────────────
console.log('[3] openDiffFor 三级降级');
const target = fileUri(path.join(REPO, 'extension.js'));
const webview = { postMessage: () => {} };

async function runCase(change, deps) {
  executed.length = 0;
  statusMessages.length = 0;
  const opened = await I.openDiffFor(target, change, deps);
  const diffCall = executed.find((c) => c[0] === 'vscode.diff');
  const openCall = executed.find((c) => c[0] === 'vscode.open');
  return { opened, diffCall, openCall };
}

(async function main() {
  // P1 命中
  let r = await runCase({ sessionId: 's1', turn: 7 }, {
    fetchTurnChange: async () => ({ ok: true, turn: 7, display: 'extension.js', before: 'old\n', after: 'new\n' }),
    readGitHeadBaseline: async () => null
  });
  ok(r.opened === true && !!r.diffCall, 'P1 命中 → 打开 diff');
  ok(r.diffCall[3] === 'extension.js · 第 7 轮', 'P1 标题写轮次');
  ok(r.diffCall[1].toString().startsWith('dsh-diff:') || r.diffCall[2].toString().startsWith('dsh-diff:'), 'diff 左侧为虚拟文档');
  ok(r.diffCall[4] && r.diffCall[4].preview === false, 'diff 标签页非预览');
  ok(diffProvider.provider.provideTextDocumentContent(r.diffCall[1]) === 'old\n', '左侧为该轮开始内容');
  ok(diffProvider.provider.provideTextDocumentContent(r.diffCall[2]) === 'new\n', '右侧为该轮结束内容');

  // P1 未命中 → P0
  r = await runCase({ sessionId: 's1', turn: 7 }, {
    fetchTurnChange: async () => ({ ok: false, reason: 'no-change' }),
    readGitHeadBaseline: async () => ({ kind: 'text', text: 'head\n' })
  });
  ok(r.opened === true && !!r.diffCall, 'P1 未命中 → P0 diff');
  ok(r.diffCall[3] === 'extension.js · 与 HEAD 的差异', 'P0 标题明确写与 HEAD 的差异');
  ok(diffProvider.provider.provideTextDocumentContent(r.diffCall[1]) === 'head\n', 'P0 左侧为 HEAD 内容');
  ok(statusMessages.some((t) => t.includes('本轮没有该文件的变更')), 'P1 未命中给出提示');

  // P1 抛错 → P0（不崩）
  r = await runCase({ sessionId: 's1', turn: 7 }, {
    fetchTurnChange: async () => { throw new Error('boom'); },
    readGitHeadBaseline: async () => ({ kind: 'text', text: 'head\n' })
  });
  ok(r.opened === true && !!r.diffCall, 'P1 抛错时降级而不是抛给调用方');

  // P1 不可用（404）→ P0 + 提示重启
  r = await runCase({ sessionId: 's1', turn: 7 }, {
    fetchTurnChange: async () => ({ ok: false, reason: 'unavailable' }),
    readGitHeadBaseline: async () => ({ kind: 'text', text: 'head\n' })
  });
  ok(r.opened === true && !!r.diffCall, 'P1 不可用 → P0');
  ok(statusMessages.some((t) => t.includes('重启 dsh web')), '提示里给出下一步动作（重启 dsh web）');

  // 二进制 / 超大
  r = await runCase({ sessionId: 's1', turn: 7 }, {
    fetchTurnChange: async () => ({ ok: false, reason: 'binary' }),
    readGitHeadBaseline: async () => null
  });
  ok(r.opened === false && !r.diffCall, '二进制 → 不打开 diff（交给调用方普通打开）');
  ok(statusMessages.some((t) => t.includes('二进制') || t.includes('过大')), '二进制/超大给出提示');

  // 404 的三种含义各有文案，且都继续退 P0（不误导用户）
  r = await runCase({ sessionId: 's1', turn: 7 }, {
    fetchTurnChange: async () => ({ ok: false, reason: 'released' }),
    readGitHeadBaseline: async () => ({ kind: 'text', text: 'head\n' })
  });
  ok(r.opened === true && !!r.diffCall && r.diffCall[3] === 'extension.js · 与 HEAD 的差异', '会话已释放 → P0');
  ok(statusMessages.some((t) => t.includes('已随会话释放')), '释放有专门文案（不误导为「重启」）');
  r = await runCase({ sessionId: 's1', turn: 7 }, {
    fetchTurnChange: async () => ({ ok: false, reason: 'no-record' }),
    readGitHeadBaseline: async () => ({ kind: 'text', text: 'head\n' })
  });
  ok(statusMessages.some((t) => t.includes('还没有对比数据')), '轮未结束/无记录有专门文案');
  r = await runCase({ sessionId: 's1', turn: 7 }, {
    fetchTurnChange: async () => ({ ok: false, reason: 'no-text' }),
    readGitHeadBaseline: async () => ({ kind: 'text', text: 'head\n' })
  });
  ok(r.opened === true && !!r.diffCall, '清单里有但取不到全文 → P0');
  ok(statusMessages.some((t) => t.includes('取不到全文')), 'no-text 有专门文案');

  // 无坐标 → 直接 P0，不查询轮级
  let turnQueried = false;
  r = await runCase(null, {
    fetchTurnChange: async () => { turnQueried = true; return { ok: true, turn: 1, before: '', after: '' }; },
    readGitHeadBaseline: async () => ({ kind: 'text', text: 'head\n' })
  });
  ok(turnQueried === false, '无坐标时不查询轮级路由（AC-7）');
  ok(!!r.diffCall && r.diffCall[3] === 'extension.js · 与 HEAD 的差异', '无坐标走 P0');

  // P0 也没有 → L0
  r = await runCase(null, {
    fetchTurnChange: async () => ({ ok: false, reason: 'no-change' }),
    readGitHeadBaseline: async () => null
  });
  ok(r.opened === false && !r.diffCall && !r.openCall, 'P0 不可用 → 返回 false（调用方 vscode.open）');

  // ── [4] git 基线判定（注入假 runner） ────────────────────────
  console.log('[4] git 基线与体积/二进制判定');
  const calls = [];
  const fakeRun = (map) => async (args) => {
    calls.push(args.join(' '));
    const key = args[args.length - 1];
    if (args.includes('rev-parse')) return map.top === undefined ? { code: 128, stdout: '', stderr: '' } : { code: 0, stdout: map.top + '\n', stderr: '' };
    if (args.includes('--quiet')) return { code: map.diffCode, stdout: '', stderr: '' };
    if (args.includes('show')) {
      if (key === 'HEAD:new.ts') return { code: 128, stdout: '', stderr: 'fatal: path does not exist' };
      return { code: 0, stdout: map.blob === undefined ? '' : map.blob, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };

  const f1 = fileUri(path.join(REPO, 'extension.js'));
  let base = await I.readGitHeadBaseline(f1, { run: fakeRun({ top: REPO, diffCode: 1, blob: 'HEAD-CONTENT' }) });
  ok(base && base.kind === 'text' && base.text === 'HEAD-CONTENT', '有未提交改动 → 返回 HEAD 内容');
  base = await I.readGitHeadBaseline(f1, { run: fakeRun({ top: REPO, diffCode: 0, blob: 'x' }) });
  ok(base === null, '无未提交改动 → null（退回普通打开）');
  base = await I.readGitHeadBaseline(f1, { run: fakeRun({}) });
  ok(base === null, '非 git 仓库 → null');
  const noHead = fakeRun({ top: REPO, diffCode: 128 });
  base = await I.readGitHeadBaseline(fileUri(path.join(REPO, 'new.ts')), { run: noHead });
  ok(base && base.kind === 'absent', '空仓库/新文件 → 左侧空文档');
  base = await I.readGitHeadBaseline(fileUri(path.join(REPO, 'extension.js')), { run: fakeRun({ top: REPO, diffCode: 1, blob: 'a\u0000b' }) });
  ok(base === null, 'HEAD 侧是二进制 → 不造 diff');
  base = await I.readGitHeadBaseline(fileUri(path.join(REPO, 'extension.js')), { run: fakeRun({ top: REPO, diffCode: 1, blob: 'x'.repeat(I.MAX_DIFF_SIDE_BYTES + 1) }) });
  ok(base === null, 'HEAD 侧超过 1 MiB → 不造 diff');

  // ── [5] 消息链路（diffAndOpen） ──────────────────────────────
  console.log('[5] handleWebviewMessage 链路');
  const received = [];
  const wv = { postMessage: (m) => received.push(m) };
  vscodeStub.workspace.workspaceFolders = [{ uri: fileUri(REPO) }];
  configValues[ACTION_KEY] = 'diffAndOpen';
  I.setDiffDeps({
    fetchTurnChange: async () => ({ ok: true, turn: 3, display: 'extension.js', before: 'a', after: 'b' }),
    readGitHeadBaseline: async () => null
  });
  executed.length = 0;
  received.length = 0;
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tk9', path: 'extension.js', change: { sessionId: 's1', turn: 3 } }, wv);
  await new Promise((r2) => setTimeout(r2, 200));
  ok(executed.some((c) => c[0] === 'revealInExplorer'), 'diffAndOpen 仍然先定位');
  ok(executed.some((c) => c[0] === 'vscode.diff'), 'diffAndOpen 打开 diff 而不是普通编辑器');
  ok(!executed.some((c) => c[0] === 'vscode.open'), '拿到轮级 diff 后不再重复打开原文件');
  const results = received.filter((m) => m.type === 'dsh-reveal-result');
  const accepts = received.filter((m) => m.type === 'dsh-reveal-accepted');
  ok(results.length === 1 && results[0].ok === true && results[0].token === 'tk9', '只回执一次 ok=true（客户端不回放点击）');
  ok(accepts.length === 1 && accepts[0].token === 'tk9', '先回「已接单」，供客户端把等待放宽到 6 s（AC-11）');
  ok(received[0].type === 'dsh-reveal-accepted', '接单回执先于结果回执（避免超时回放双开）');

  // 非法坐标被丢弃 → 不查询轮级
  let queried = false;
  I.setDiffDeps({
    fetchTurnChange: async () => { queried = true; return { ok: false, reason: 'no-change' }; },
    readGitHeadBaseline: async () => null
  });
  executed.length = 0;
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tk10', path: 'extension.js', change: { sessionId: 's1', turn: 0 } }, wv);
  await new Promise((r3) => setTimeout(r3, 150));
  ok(queried === false, 'turn=0 的坐标被丢弃（不请求路由）');
  ok(executed.some((c) => c[0] === 'vscode.open'), '坐标非法时退回普通打开');

  // revealAndOpen 不受新功能影响
  configValues[ACTION_KEY] = 'revealAndOpen';
  executed.length = 0;
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tk11', path: 'extension.js', change: { sessionId: 's1', turn: 3 } }, wv);
  await new Promise((r4) => setTimeout(r4, 150));
  ok(!executed.some((c) => c[0] === 'vscode.diff'), 'revealAndOpen 不进入 diff 逻辑（AC-8）');
  ok(executed.some((c) => c[0] === 'vscode.open'), 'revealAndOpen 仍为普通打开');

  I.setDiffDeps(null);
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
