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
// 工作区外文件是否交给 VS Code（默认关闭；规格 011 补充）
const ACCESS_KEY = 'dshPanel.outOfWorkspaceFileAccess';
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

// 工作目录用平台无关的绝对路径：Windows 下 `/w/proj` 不是绝对路径（path.resolve 会补盘符），
// 断言不能写死 POSIX 形式。
const proj = process.platform === 'win32' ? 'C:/w/proj' : '/w/proj';
const cands = I.normalizeChangeCandidates(proj, 'src/a.ts');
ok(cands.includes('src/a.ts') && cands.includes(proj + '/src/a.ts'), '相对路径同时产出相对与绝对候选');
const candsAbs = I.normalizeChangeCandidates(proj, proj + '/src/a.ts');
ok(candsAbs.includes(proj + '/src/a.ts') && candsAbs.includes('src/a.ts'), '绝对路径回推相对候选');
const candsWin = I.normalizeChangeCandidates('C:/w/proj', 'src\\a.ts');
ok(candsWin.includes('src/a.ts'), '反斜杠写法归一为 /');
const upDir = process.platform === 'win32' ? 'C:/w/p' : '/w/p';
const upAbs = upDir.replace(/\/p$/, '/outside.ts');
ok(I.normalizeChangeCandidates(upDir, '../outside.ts').includes('../outside.ts'), '保留 ../ 候选（工作区上方文件以 display 匹配）');
ok(I.normalizeChangeCandidates(upDir, '../outside.ts').includes(upAbs), '越界相对路径同时给出绝对候选');

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

  // ── [6] 工作区外链接（规格 010） ─────────────────────────────
  console.log('[6] 工作区外链接：只用 DSH 记录出 diff，不读盘');
  // 工作区外目标：不在 REPO 下、也不需要真实存在（原文件能否打开不是本链路的前提）。
  const outsideRaw = path.join(os.tmpdir(), 'dsh-010-outside', 'a.ts');
  const outsideLink = outsideRaw.replace(/\\/g, '/');

  executed.length = 0;
  statusMessages.length = 0;
  let fetchedPaths = [];
  let gitQueried = false;
  I.setDiffDeps({
    fetchTurnChange: async (coord, p) => {
      fetchedPaths.push(p);
      return { ok: true, turn: 5, display: '../../dsh-010-outside/a.ts', before: 'old\n', after: 'new\n' };
    },
    readGitHeadBaseline: async () => { gitQueried = true; return null; }
  });
  let out = await I.openOutOfWorkspaceDiff(outsideRaw, { sessionId: 's1', turn: 5 });
  ok(out.ok === true, '工作区外命中 → ok=true（插件不回放点击）');
  const outDiff = executed.find((c) => c[0] === 'vscode.diff');
  ok(!!outDiff && outDiff[3] === 'a.ts · 第 5 轮', '工作区外 diff 标题写「第 N 轮」');
  ok(diffProvider.provider.provideTextDocumentContent(outDiff[1]) === 'old\n'
    && diffProvider.provider.provideTextDocumentContent(outDiff[2]) === 'new\n', '左右取自该轮记录');
  ok(!executed.some((c) => c[0] === 'revealInExplorer'), '工作区外不经资源管理器定位');
  ok(gitQueried === false, '工作区外不跑 HEAD 对比（不读本地磁盘）');
  ok(fetchedPaths[0] === outsideLink, '路由收到的是链接原文（不做绝对化猜测）');

  // 行号后缀：原文未命中才去后缀重查一次（AC-3）
  fetchedPaths = [];
  executed.length = 0;
  I.setDiffDeps({
    fetchTurnChange: async (coord, p) => {
      fetchedPaths.push(p);
      if (p.endsWith(':12')) return { ok: false, reason: 'no-change' };
      return { ok: true, turn: 2, display: 'a.ts', before: '', after: 'x\n' };
    },
    readGitHeadBaseline: async () => null
  });
  out = await I.openOutOfWorkspaceDiff(outsideRaw + ':12', { sessionId: 's1', turn: 2 });
  ok(out.ok === true && fetchedPaths.length === 2, '带行号后缀：原样未命中 → 去后缀重试一次');
  ok(fetchedPaths[1] === outsideLink, '重试时用的是去掉 :12 的路径');
  ok(executed.some((c) => c[0] === 'vscode.diff'), '重试命中即打开 diff');

  // 无坐标 / 非法坐标：不猜会话与轮（AC-4）
  let requested = false;
  I.setDiffDeps({
    fetchTurnChange: async () => { requested = true; return { ok: true, turn: 1, before: '', after: '' }; },
    readGitHeadBaseline: async () => null
  });
  out = await I.openOutOfWorkspaceDiff(outsideRaw, null);
  ok(out.ok === false && out.reason === 'no-coord', '无坐标 → ok=false / no-coord');
  out = await I.openOutOfWorkspaceDiff(outsideRaw, { sessionId: 's1', turn: 0 });
  ok(out.ok === false && out.reason === 'no-coord' && requested === false, '非法坐标不请求路由（AC-4）');
  out = await I.openOutOfWorkspaceDiff('   ', { sessionId: 's1', turn: 1 });
  ok(out.ok === false && out.reason === 'invalid' && requested === false, '空/空白路径直接拒绝');
  out = await I.openOutOfWorkspaceDiff('a'.repeat(5000), { sessionId: 's1', turn: 1 });
  ok(out.ok === false && out.reason === 'invalid', '超长路径拒绝（沿用 001 净身）');

  // 各失败原因 → 定向文案（AC-5）
  statusMessages.length = 0;
  I.notifyOutOfWorkspaceLink(outsideRaw, 'no-change');
  I.notifyOutOfWorkspaceLink(outsideRaw, 'unavailable');
  I.notifyOutOfWorkspaceLink(outsideRaw, 'no-coord');
  I.notifyOutOfWorkspaceLink(outsideRaw, 'binary');
  ok(statusMessages.length === 4, '每种失败都有一条状态栏提示（不静默）');
  ok(statusMessages.every((t) => t.includes('工作区外')), '提示都点明「工作区外」这一前提');
  ok(statusMessages.every((t) => t.includes('DSH 侧栏')), '提示都说清后续落在哪（DSH 侧栏）');
  ok(statusMessages.some((t) => t.includes('重启 dsh web')), '不可用时给出下一步动作（重启 dsh web）');

  // 消息链路：diffAndOpen + 工作区外路径 → 回执成功、不定位（AC-1）
  configValues[ACTION_KEY] = 'diffAndOpen';
  received.length = 0;
  executed.length = 0;
  statusMessages.length = 0;
  I.setDiffDeps({
    fetchTurnChange: async () => ({ ok: true, turn: 4, display: 'a.ts', before: 'p', after: 'q' }),
    readGitHeadBaseline: async () => { throw new Error('工作区外不应读盘'); }
  });
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tk20', path: outsideRaw, change: { sessionId: 's1', turn: 4 } }, wv);
  await new Promise((r5) => setTimeout(r5, 200));
  ok(executed.some((c) => c[0] === 'vscode.diff'), '工作区外链接在 VS Code 打开 diff');
  ok(!executed.some((c) => c[0] === 'revealInExplorer'), '工作区外链接不定位资源管理器');
  const outResults = received.filter((m) => m.type === 'dsh-reveal-result');
  ok(outResults.length === 1 && outResults[0].ok === true && outResults[0].token === 'tk20', '回执 ok=true（DSH 侧栏不再打开）');

  // 未命中 → 回执失败 + 提示（AC-2）
  received.length = 0;
  executed.length = 0;
  statusMessages.length = 0;
  I.setDiffDeps({
    fetchTurnChange: async () => ({ ok: false, reason: 'no-change' }),
    readGitHeadBaseline: async () => null
  });
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tk21', path: outsideRaw, change: { sessionId: 's1', turn: 4 } }, wv);
  await new Promise((r6) => setTimeout(r6, 200));
  const missResults = received.filter((m) => m.type === 'dsh-reveal-result');
  ok(missResults.length === 1 && missResults[0].ok === false, '未命中回执 ok=false（插件回放、DSH 侧栏照旧）');
  ok(missResults[0].reason === 'no-change', '失败回执带原因码（页面日志可定位）');
  ok(executed.length === 0, '未命中不执行任何编辑器命令');
  ok(statusMessages.some((t) => t.includes('工作区外')), '未命中给出「工作区外」提示');

  // 非 diff 模式：行为与 1.0.6 一致，但提示给出出路（AC-6）
  for (const mode of ['revealAndOpen', 'revealOnly']) {
    configValues[ACTION_KEY] = mode;
    received.length = 0;
    executed.length = 0;
    statusMessages.length = 0;
    let queriedNow = false;
    I.setDiffDeps({
      fetchTurnChange: async () => { queriedNow = true; return { ok: true, turn: 4, before: '', after: '' }; },
      readGitHeadBaseline: async () => null
    });
    I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tk22', path: outsideRaw, change: { sessionId: 's1', turn: 4 } }, wv);
    await new Promise((r7) => setTimeout(r7, 150));
    const modeResults = received.filter((m) => m.type === 'dsh-reveal-result');
    ok(modeResults.length === 1 && modeResults[0].ok === false, mode + '：工作区外仍回执 ok=false');
    ok(queriedNow === false, mode + '：不取轮级数据');
    ok(executed.length === 0, mode + '：不开编辑器也不定位');
    ok(statusMessages.some((t) => t.includes('diffAndOpen')), mode + '：提示「改成 diffAndOpen 可看该轮变更」');
  }

  I.setDiffDeps(null);
  // ── [7] latest 坐标与 cwd 候选（规格 011） ───────────────────
  console.log('[7] latest 坐标与 cwd 候选（老会话仍能看变更）');
  ok(I.sanitizeChangeCoord({ sessionId: 's1', latest: true }).latest === true, 'sanitizeChangeCoord 接受 latest（无 turn）');
  ok(I.sanitizeChangeCoord({ sessionId: 's1', latest: true, turn: 0 }).latest === true, 'latest 优先于非法 turn');
  ok(I.sanitizeChangeCoord({ sessionId: '', latest: true }) === null, 'latest 也要有 sessionId');
  const cwdOutside = process.platform === 'win32' ? 'C:/w/other' : '/w/other';
  ok(I.absoluteFromCwd('src/a.ts', cwdOutside) === cwdOutside + '/src/a.ts', 'absoluteFromCwd 按 DSH cwd 折绝对路径');
  ok(I.absoluteFromCwd(cwdOutside + '/a.ts', cwdOutside) === '', '本来就是绝对路径时不折（返回空串）');
  ok(I.absoluteFromCwd('src/a.ts', '') === '', '没有 cwd 时不折');

  let asked = [];
  executed.length = 0;
  statusMessages.length = 0;
  I.setDiffDeps({
    fetchTurnChange: async (c, p) => {
      asked.push({ c, p });
      return { ok: true, turn: 9, latest: true, display: 'a.ts', before: 'x', after: 'y' };
    },
    readGitHeadBaseline: async () => null
  });
  out = await I.openOutOfWorkspaceDiff(outsideRaw, { sessionId: 's1', latest: true });
  ok(out.ok === true && asked.length === 1, 'latest 坐标直接查询一次');
  ok(asked[0].c.latest === true && asked[0].c.turn === undefined, 'latest 请求不带 turn（不猜轮次）');
  ok(statusMessages.some((t) => t.includes('最近一次改动')), 'latest 命中提示「已展示本会话最近一次改动」');
  ok(executed.some((c) => c[0] === 'vscode.diff'), 'latest 命中同样开 diff');

  // 指定轮没有该文件 → 自动改用 latest 再查一次
  asked = [];
  executed.length = 0;
  statusMessages.length = 0;
  I.setDiffDeps({
    fetchTurnChange: async (c, p) => {
      asked.push({ c, p });
      if (c.latest !== true) return { ok: false, reason: 'no-change' };
      return { ok: true, turn: 4, latest: true, display: 'a.ts', before: '', after: 'z' };
    },
    readGitHeadBaseline: async () => null
  });
  out = await I.openOutOfWorkspaceDiff(outsideRaw, { sessionId: 's1', turn: 3 }, cwdOutside);
  ok(out.ok === true, '该轮无变更 → 改按 latest 再查一次并命中');
  ok(asked.some((a) => a.c.latest === true), '确实发出了 latest 请求');
  ok(statusMessages.some((t) => t.includes('第 3 轮没有它的变更')), '提示说明为何展示的是别的轮');

  // 相对路径：把「按 DSH cwd 拼的绝对写法」当候选之一
  asked = [];
  executed.length = 0;
  I.setDiffDeps({
    fetchTurnChange: async (c, p) => { asked.push(p); return { ok: false, reason: 'no-change' }; },
    readGitHeadBaseline: async () => null
  });
  out = await I.openOutOfWorkspaceDiff('src/a.ts', { sessionId: 's1', turn: 2 }, cwdOutside);
  ok(asked.includes(cwdOutside + '/src/a.ts'), '相对路径额外按 DSH cwd 拼绝对候选');
  ok(out.ok === false && out.reason === 'no-change', '都没命中 → 交回 DSH 侧栏');

  // 不可用类错误不再白跑：只打一次
  asked = [];
  I.setDiffDeps({
    fetchTurnChange: async (c, p) => { asked.push({ c, p }); return { ok: false, reason: 'unavailable' }; },
    readGitHeadBaseline: async () => null
  });
  out = await I.openOutOfWorkspaceDiff('src/a.ts', { sessionId: 's1', turn: 2 }, cwdOutside);
  ok(out.reason === 'unavailable' && asked.length === 1, '不可用时不再换写法/换坐标重试');

  // no-record / no-text 也要继续换 latest（DOM 轮号与事件轮号可能不同源、本轮可能没捕获）
  ok(I.isRetryableChangeReason('no-change') === true && I.isRetryableChangeReason('no-record') === true
    && I.isRetryableChangeReason('no-text') === true, '可重试原因：no-change / no-record / no-text');
  ok(I.isRetryableChangeReason('unavailable') === false && I.isRetryableChangeReason('released') === false
    && I.isRetryableChangeReason('timeout') === false, '不可重试原因：unavailable / released / timeout');
  asked = [];
  executed.length = 0;
  I.setDiffDeps({
    fetchTurnChange: async (c, p) => {
      asked.push({ c, p });
      if (c.latest !== true) return { ok: false, reason: 'no-record' };
      return { ok: true, turn: 5, latest: true, display: 'a.ts', before: '', after: 'k' };
    },
    readGitHeadBaseline: async () => null
  });
  out = await I.openOutOfWorkspaceDiff(outsideRaw, { sessionId: 's1', turn: 9 }, cwdOutside);
  ok(out.ok === true && asked.some((a) => a.c.latest === true), 'no-record 时也换 latest 再查');

  I.setDiffDeps(null);
  // ── [8] 工作区外文件交给 VS Code（opt-in） ───────────────────
  // DSH 的轮级记录只在内存，重启即失；工作区外文件没有 P0/L0 兜底，
  // 所以提供显式开关：开启后按「git HEAD 对比 → 普通打开」降级。
  console.log('[8] outOfWorkspaceFileAccess（默认关闭）');
  configValues[ACTION_KEY] = 'diffAndOpen';
  delete configValues[ACCESS_KEY];
  ok(I.allowOutOfWorkspaceAccess() === false, '默认不把工作区外文件交给 VS Code');

  // 工作区外的真实文件（REPO 之外的临时目录）：开关只认「存在」，不认是否在工作区内。
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-out-access-'));
  const existsFile = path.join(outDir, 'a.py');
  fs.writeFileSync(existsFile, 'print(1)\n');
  executed.length = 0;
  statusMessages.length = 0;
  I.setDiffDeps({
    fetchTurnChange: async () => ({ ok: false, reason: 'released' }),
    readGitHeadBaseline: async () => { throw new Error('默认关闭时不应读盘'); }
  });
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tka', path: existsFile, change: { sessionId: 's1', turn: 1 } }, wv);
  await new Promise((r8) => setTimeout(r8, 200));
  ok(executed.length === 0, '默认关闭：不打开、不定位');
  ok(statusMessages.some((t) => t.includes('outOfWorkspaceFileAccess')), '提示里给出开关出路');
  ok(statusMessages.some((t) => t.includes('重启')), 'released 时说明「变更记录已随 dsh web 重启丢失」');

  // 开启 + diffAndOpen：P1 拿不到 → git HEAD 对比
  configValues[ACCESS_KEY] = true;
  ok(I.allowOutOfWorkspaceAccess() === true, '开关生效');
  executed.length = 0;
  I.setDiffDeps({
    fetchTurnChange: async () => ({ ok: false, reason: 'released' }),
    readGitHeadBaseline: async () => ({ kind: 'text', text: 'head\n' })
  });
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tkb', path: existsFile, change: { sessionId: 's1', turn: 1 } }, wv);
  await new Promise((r9) => setTimeout(r9, 200));
  const optDiff = executed.find((c) => c[0] === 'vscode.diff');
  ok(!!optDiff, '开启后：轮级没了也能开「与 HEAD 的差异」');
  ok(optDiff[3] === 'a.py · 与 HEAD 的差异', '标题写明与 HEAD 的差异');
  ok(!executed.some((c) => c[0] === 'revealInExplorer'), '工作区外不定位资源管理器');

  // 开启但没有 git 改动 → 普通打开
  executed.length = 0;
  I.setDiffDeps({
    fetchTurnChange: async () => ({ ok: false, reason: 'released' }),
    readGitHeadBaseline: async () => null
  });
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tkc', path: existsFile, change: { sessionId: 's1', turn: 1 } }, wv);
  await new Promise((r10) => setTimeout(r10, 200));
  ok(executed.some((c) => c[0] === 'vscode.open'), '无 git 改动 → 直接打开文件');

  // 开启 + revealAndOpen → 直接打开；revealOnly → 只定位
  configValues[ACTION_KEY] = 'revealAndOpen';
  executed.length = 0;
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tkd', path: existsFile }, wv);
  await new Promise((r11) => setTimeout(r11, 150));
  ok(executed.length === 1 && executed[0][0] === 'vscode.open', 'revealAndOpen：工作区外文件直接打开');
  configValues[ACTION_KEY] = 'revealOnly';
  executed.length = 0;
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tke', path: existsFile }, wv);
  await new Promise((r12) => setTimeout(r12, 150));
  ok(executed.length === 1 && executed[0][0] === 'revealInExplorer', 'revealOnly：只定位');

  // 目标不存在 → 不接管
  configValues[ACTION_KEY] = 'diffAndOpen';
  executed.length = 0;
  received.length = 0;
  I.handleWebviewMessage({ type: 'dsh-reveal-path', token: 'tkf', path: path.join(REPO, 'no-such-file.xyz') }, wv);
  await new Promise((r13) => setTimeout(r13, 150));
  ok(executed.length === 0, '不存在的路径不交给 VS Code');
  ok(received.some((m) => m.type === 'dsh-reveal-result' && m.ok === false), '回执失败（插件回放）');
  delete configValues[ACCESS_KEY];
  configValues[ACTION_KEY] = 'diffAndOpen';
  fs.rmSync(outDir, { recursive: true, force: true });

  I.setDiffDeps(null);
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
