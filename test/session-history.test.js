'use strict';
/**
 * DSH 会话历史拉取（游标）回归测试。
 * 运行：node test/session-history.test.js
 *
 * 背景：桥接靠 session/page 拉历史做流式回放。旧实现用「故意越界 → 从报错文案里解析游标」
 * 的两步法，依赖 dsh 的 `past cursor N`；dsh 0.2.2 把文案改成
 * `session history cut N exceeds M`，于是探测解析失败、历史拉取整体失败
 * （Copilot 侧表现为「读取 DSH 任务状态失败」）。0.2.2 起 `session/page` 省略
 * `throughSeq` 就是「到最新游标为止的尾部一页」，返回体自带 cursor —— 所以改成
 * 新语义优先、旧探测（两种文案都认）回退、最后回落老版本 `session.history`。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-history-'));
process.env.HOME = profileRoot;
process.env.USERPROFILE = profileRoot;

const config = {};
const statusBar = [];
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d) }),
    workspaceFolders: []
  },
  window: {
    setStatusBarMessage: (t) => { statusBar.push(String(t)); return { dispose() {} }; },
    showWarningMessage: async () => {},
    showInformationMessage: async () => {},
    showErrorMessage: async () => {},
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }),
    showTextDocument: async () => ({})
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
  env: {},
  Uri: { parse: (u) => ({ toString: () => u }), file: (p) => ({ fsPath: p }) }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const ext = require(path.join(__dirname, '..', 'extension.js'));
const I = ext.__internals;

/** 记录调用的假 RPC：handlers 依次消费，返回/抛出。 */
function fakeRpc(handlers) {
  const calls = [];
  const rpc = async (base, method, payload, timeoutMs) => {
    calls.push({ method, payload, timeoutMs });
    const h = handlers.shift();
    if (!h) throw new Error('未预期的 RPC: ' + method);
    if (h instanceof Error) throw h;
    return h;
  };
  return { rpc, calls };
}

async function main() {
console.log('[1] sessionCursorFromError：两代越界文案');
{
  ok(I.sessionCursorFromError('past cursor 41') === 41, '旧文案 past cursor 41 → 41');
  ok(I.sessionCursorFromError('past cursor -1') === -1, '空会话 past cursor -1 → -1');
  ok(I.sessionCursorFromError('session history cut 9007199254740991 exceeds 41') === 41,
    '新文案 session history cut N exceeds M → 取 M（当前游标）');
  ok(I.sessionCursorFromError('Session history no longer covers the wait cursor') === null,
    '另一种新文案（no longer covers）解析不到 → null（交给上层回退）');
  ok(I.sessionCursorFromError('') === null && I.sessionCursorFromError(null) === null, '空输入 → null');
}

console.log('[2] 新语义优先：省略 throughSeq 即取尾部（0.2.2+）');
{
  const { rpc, calls } = fakeRpc([
    { cursor: 41, records: [{ event: { seq: 40, type: 'turn/start' } }, { seq: 41, type: 'turn/end' }] }
  ]);
  const hist = await I.fetchSessionHistoryWith(rpc, 'http://x', 's-new');
  ok(calls.length === 1 && calls[0].method === 'session.page', '只发一次 session.page（不再探测越界）');
  ok(calls[0].payload.throughSeq === undefined, '不传 throughSeq（新语义取最新游标）');
  ok(hist.events.length === 2 && hist.events[0].seq === 40 && hist.events[1].seq === 41,
    'records 归一化为 events（解包 {event}）');
}

console.log('[3] 旧语义回退：0.2.1 需显式 throughSeq（旧文案）');
{
  const { rpc, calls } = fakeRpc([
    new Error('throughSeq 必填'),
    new Error('past cursor 41'),
    { cursor: 41, records: [{ seq: 41, type: 'turn/end' }] }
  ]);
  const hist = await I.fetchSessionHistoryWith(rpc, 'http://x', 's-old');
  ok(calls.length === 3 && calls[0].payload.throughSeq === undefined, '先试新语义（tail）');
  ok(calls[1].payload.throughSeq === Number.MAX_SAFE_INTEGER, '再按旧法越界探测游标');
  ok(calls[2].payload.throughSeq === 41, '最后按解析出的游标取尾部一页');
  ok(hist.events.length === 1 && hist.events[0].seq === 41, '旧路径同样归一化');
}

console.log('[4] 0.2.2 新文案也能解析（双通道兜底）');
{
  const { rpc, calls } = fakeRpc([
    new Error('throughSeq 必填'),
    new Error('session history cut 9007199254740991 exceeds 17'),
    { cursor: 17, records: [{ seq: 17, type: 'turn/end' }] }
  ]);
  const hist = await I.fetchSessionHistoryWith(rpc, 'http://x', 's-new-text');
  ok(calls.length === 3 && calls[2].payload.throughSeq === 17, '从「exceeds 17」解析出游标 17');
  ok(hist.events.length === 1 && hist.events[0].seq === 17, '取到该游标的尾部');
}

console.log('[5] 空会话：游标 -1 → 空历史，不报错');
{
  const { rpc, calls } = fakeRpc([
    new Error('throughSeq 必填'),
    new Error('past cursor -1')
  ]);
  const hist = await I.fetchSessionHistoryWith(rpc, 'http://x', 's-empty');
  ok(calls.length === 2, '只探测一次');
  ok(Array.isArray(hist.events) && hist.events.length === 0, '返回空 events（不是抛错）');
}

console.log('[6] 老版本 dsh：session/page 不存在 → 回落 session.history');
{
  const { rpc, calls } = fakeRpc([
    new Error('DSH RPC 失败: session.page'),
    new Error('DSH RPC 失败: session.page'),
    { events: [{ seq: 1, type: 'turn/start' }] }
  ]);
  const hist = await I.fetchSessionHistoryWith(rpc, 'http://x', 's-legacy');
  ok(calls.length === 3 && calls[2].method === 'session.history', '回落旧端点 session.history');
  ok(hist.events.length === 1 && hist.events[0].seq === 1, '旧端点返回值原样透出');
}

console.log('[7] 调试日志：路径留痕（开启落盘时写文件，每会话每种路径一条）');
{
  const logPath = I.debugLogPath();
  try { fs.unlinkSync(logPath); } catch (_) { /* 首次 */ }
  config['dshPanel.debugLogToFile'] = true;
  I.resetDebugLogState();

  const { rpc } = fakeRpc([{ cursor: 41, records: [{ seq: 41 }] }, { cursor: 41, records: [{ seq: 41 }] }]);
  await I.fetchSessionHistoryWith(rpc, 'http://x', 's-log-1');
  const text1 = fs.readFileSync(logPath, 'utf8');
  ok(/\[history\] path=page-tail sid=s-log-1/.test(text1), '记录走了哪条路径（page-tail）');
  ok(/cursor=41 n=1/.test(text1), '记录游标与条数');

  const before = text1.split('\n').filter((l) => l.indexOf('path=page-tail') >= 0).length;
  await I.fetchSessionHistoryWith(rpc, 'http://x', 's-log-1');
  const text2 = fs.readFileSync(logPath, 'utf8');
  const after = text2.split('\n').filter((l) => l.indexOf('path=page-tail') >= 0).length;
  ok(before === 1 && after === 1, '同一会话同一路径只留一条（轮询不刷日志）');

  delete config['dshPanel.debugLogToFile'];
  I.resetDebugLogState();
  fs.rmSync(profileRoot, { recursive: true, force: true });
}

console.log('\n全部通过：' + passed + ' 项断言 ✓');
}

main().catch((e) => {
  console.error((e && e.stack) || e);
  process.exit(1);
});
