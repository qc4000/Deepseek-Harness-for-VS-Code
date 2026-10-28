'use strict';
/**
 * dsh-vscode-changes 宿主插件（规格 005，轮级变更出口）回归测试。
 * 运行：node test/dsh-changes-plugin.test.js
 *
 * 数据源契约（2026-10-27 按真机实测修正）：`ctx.workspaceChanges` 只提供
 * `{ summary(sessionId, seq), diff(...) }`，整文件两侧内容在 TurnRecorder 的私有
 * `records` 里、外部读不到。因此插件改为：用 dsh 自己 recorder 同款公开钩子
 * （`fs/write-intent` 前置 + `turn/end`）自捕获两侧全文，再用 `summary()` 作为
 * 「本轮改了哪些文件」的权威清单。
 *
 * 覆盖：包声明/语法；路由注册与参数校验；同轮多次编辑只一条（AC-1）、跨轮独立
 * （AC-2）、改回原样不列出（AC-3）、shell 直接改动取不到全文（no-text）、新增文件、
 * 二进制/超大（AC-6）、只按已记录清单匹配不读任意路径（AC-9）、会话释放与旧 dsh 404
 * （AC-4/10）、会话隔离、同轮取最新事件。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const PLUGIN_NAME = 'dsh-vscode-changes';
const PLUGIN_DIR = path.join(__dirname, '..', 'dsh-plugins', PLUGIN_NAME);
const ROUTE = '/api/dsh-vscode.changes-file';
const MAX_SIDE_BYTES = 1024 * 1024;

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-changes-'));
/** 工作区根：被编辑的文件都放在它下面，模拟真实 cwd。 */
const cwd = path.join(tmp, 'proj');
fs.mkdirSync(cwd, { recursive: true });
function write(rel, text) {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

/**
 * 假的 DSH 宿主上下文：按真机形状提供 `{ summary }`（没有 records），
 * 并能收 session/event、fs/write-intent、session/disposed。
 */
function makeCtx() {
  const routes = new Map();
  const listeners = new Map();
  const summaries = new Map(); // seq -> summary（真机由 workspaceChanges.summary 提供）
  const state = { effects: 0, hasSummary: true };
  const on = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(fn);
    return () => {};
  };
  const ctx = {
    workspaceChanges: {
      summary: state.hasSummary ? (sessionId, seq) => summaries.get(seq) : undefined,
      diff: async () => undefined
    },
    fs: { processPath: (t) => String(t) },
    connection: { fetch: { register: (desc) => { routes.set(desc.path, desc); return () => routes.delete(desc.path); } } },
    on,
    effect: (fn) => { state.effects += 1; const d = fn(); return typeof d === 'function' ? d : () => {}; },
    get: () => undefined
  };
  const emit = (name, ...args) => {
    for (const fn of listeners.get(name) || []) fn(...args);
  };
  return {
    ctx, routes, listeners, summaries, state, emit,
    /** 派发一条会话事件。 */
    event: (session, type, data, seq) => emit('session/event', session, { type, seq: seq || 0, data }),
    /** 走一遍指定意图链（`fs/write-intent` / `fs/edit-intent`），返回 next 的返回值。 */
    intent: async (name, target, actor) => {
      const fns = listeners.get(name) || [];
      const run = async (i) => (i >= fns.length ? undefined : fns[i](target, actor, () => run(i + 1)));
      return run(0);
    },
    /** write 工具执行前的钩子。 */
    writeIntent: (target, actor) => this_intent('fs/write-intent', target, actor),
    /** edit 工具执行前的钩子（dsh 用的是 fs/edit-intent，与 write 不同名）。 */
    editIntent: (target, actor) => this_intent('fs/edit-intent', target, actor)
  };
  // 让上面两个便捷别名共享同一实现。
  function this_intent(name, target, actor) {
    const fns = listeners.get(name) || [];
    const run = async (i) => (i >= fns.length ? undefined : fns[i](target, actor, () => run(i + 1)));
    return run(0);
  }
}

/** 造一份 summary（真机 workspace/changes 事件对应的权威清单）。 */
function setSummary(built, seq, turn, files, root) {
  built.summaries.set(seq, {
    turn,
    cwd: root === undefined ? cwd : root,
    files: files.map((f) => ({ path: f, display: f, added: 1, deleted: 1 })),
    total: files.length,
    added: files.length,
    deleted: files.length
  });
}

async function call(routes, query) {
  const route = routes.get(ROUTE);
  if (!route) throw new Error('路由未注册：' + ROUTE);
  const res = await route.fetch(new Request('http://127.0.0.1:3080' + ROUTE + '?' + new URLSearchParams(query).toString()));
  const body = await res.json();
  return { status: res.status, body };
}

(async function main() {
  // ── [1] 包与语法 ────────────────────────────────────────────────
  console.log('[1] 包声明与语法');
  const pkgFile = path.join(PLUGIN_DIR, 'package.json');
  const patchFile = path.join(PLUGIN_DIR, 'cordis.patch.yml');
  ok(fs.existsSync(pkgFile) && fs.existsSync(patchFile) && fs.existsSync(path.join(PLUGIN_DIR, 'lib', 'index.js')), '三个文件齐全');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const patch = fs.readFileSync(patchFile, 'utf8');
  ok(pkg.name === PLUGIN_NAME, '包名与目录一致');
  ok(/^\d+\.\d+\.\d+$/.test(pkg.version), '版本号可解析');
  ok(pkg.type === 'module' && pkg.main === 'lib/index.js', 'ESM 入口正确');
  ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'bundle.patch 指向 cordis.patch.yml');
  ok(!pkg.dependencies, '不声明 dependencies（避免用户后续 pnpm/dsh plugin add 解析失败）');
  ok(!pkg.dsh.client, '只有宿主半边（无客户端 bundle）');
  ok(/-\s*insert:/.test(patch) && patch.includes("name: '" + PLUGIN_NAME + "'"), 'cordis.patch.yml 注册行与包名一致');
  const check = spawnSync(process.execPath, ['--check', path.join(PLUGIN_DIR, 'lib', 'index.js')], { encoding: 'utf8' });
  ok(check.status === 0, 'lib/index.js 语法通过' + (check.status !== 0 ? '：' + (check.stderr || '').slice(0, 300) : ''));

  const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, 'lib', 'index.js')).href);
  ok(mod.name === PLUGIN_NAME, '导出的 name 与包名一致');
  ok(Array.isArray(mod.inject) && mod.inject.includes('workspaceChanges') && mod.inject.includes('connection'), 'inject 声明 workspaceChanges + connection');
  ok(typeof mod.apply === 'function', '导出 apply');
  ok(typeof mod.changeCandidates === 'function', 'changeCandidates 可导出给测试');

  // ── [2] 路由注册与参数校验 ─────────────────────────────────────
  console.log('[2] 路由注册与参数校验');
  const built = makeCtx();
  const dispose = mod.apply(built.ctx);
  ok(built.state.effects >= 1 && dispose === undefined, '通过 ctx.effect 注册路由（由 cordis 统一回收）');
  const route = built.routes.get(ROUTE);
  ok(!!route, '注册了 ' + ROUTE);
  ok(Array.isArray(route.methods) && route.methods.includes('GET'), '只接受 GET');

  let r = await call(built.routes, { sessionId: 's1', turn: '3' });
  ok(r.status === 400, '缺 path → 400');
  r = await call(built.routes, { turn: '3', path: 'src/a.ts' });
  ok(r.status === 400, '缺 sessionId → 400');
  r = await call(built.routes, { sessionId: 's1', turn: '0', path: 'src/a.ts' });
  ok(r.status === 400, 'turn=0 → 400');
  r = await call(built.routes, { sessionId: 's1', turn: 'x', path: 'src/a.ts' });
  ok(r.status === 400, 'turn 非数字 → 400');
  r = await call(built.routes, { sessionId: 's1', turn: '1000001', path: 'src/a.ts' });
  ok(r.status === 400, 'turn 超上限 → 400');
  r = await call(built.routes, { sessionId: 's'.repeat(129), turn: '3', path: 'src/a.ts' });
  ok(r.status === 400, 'sessionId 超长 → 400');

  // ── [3] 基本命中：自捕获两侧全文（AC-1）────────────────────────
  console.log('[3] 同轮多次编辑合并为一条净变更（AC-1）');
  const s1 = { id: 's1' };
  const a = write('src/a.ts', 'old line\n');
  built.event(s1, 'turn/start', { turn: 3 }, 1);
  // 第一次编辑前捕获 before
  await built.writeIntent(a, { agent: { session: s1 } });
  write('src/a.ts', 'edit-1\n');
  // 同轮第二次编辑：before 不再覆盖（每路径每轮只取一次）
  await built.writeIntent(a, { agent: { session: s1 } });
  write('src/a.ts', 'edit-2\n');
  built.event(s1, 'turn/end', { turn: 3 }, 2);
  built.event(s1, 'workspace/changes', { turn: 3 }, 30);
  setSummary(built, 30, 3, ['src/a.ts']);

  r = await call(built.routes, { sessionId: 's1', turn: '3', path: a });
  ok(r.status === 200 && r.body.matched === true, '命中：matched=true');
  ok(r.body.before.kind === 'text' && r.body.before.text === 'old line\n', 'before = 轮内第一次编辑前的原文');
  ok(r.body.after.kind === 'text' && r.body.after.text === 'edit-2\n', 'after = 轮结束时的内容（多次编辑取净结果）');
  ok(r.body.turn === 3 && r.body.display === 'src/a.ts', '回带轮次与 display');

  // ── [4] 跨轮独立（AC-2）──────────────────────────────────────
  console.log('[4] 跨轮各自独立（AC-2）');
  built.event(s1, 'turn/start', { turn: 4 }, 3);
  await built.writeIntent(a, { agent: { session: s1 } });
  write('src/a.ts', 'turn-4\n');
  built.event(s1, 'turn/end', { turn: 4 }, 4);
  built.event(s1, 'workspace/changes', { turn: 4 }, 31);
  setSummary(built, 31, 4, ['src/a.ts']);
  const t3 = await call(built.routes, { sessionId: 's1', turn: '3', path: a });
  const t4 = await call(built.routes, { sessionId: 's1', turn: '4', path: a });
  ok(t3.body.after.text === 'edit-2\n' && t4.body.after.text === 'turn-4\n', '两个轮各自返回本轮增量（互不累积）');
  ok(t3.body.before.text === 'old line\n' && t4.body.before.text === 'edit-2\n', '第 4 轮的 before = 第 3 轮的 after（轮次首尾相接）');

  // ── [5] 改回原样不列出（AC-3）─────────────────────────────────
  console.log('[5] 改回原样 → 该文件不出现在记录里（AC-3）');
  built.event(s1, 'turn/start', { turn: 5 }, 5);
  await built.writeIntent(a, { agent: { session: s1 } });
  write('src/a.ts', 'temp\n');
  write('src/a.ts', 'turn-4\n'); // 改回原样
  built.event(s1, 'turn/end', { turn: 5 }, 6);
  built.event(s1, 'workspace/changes', { turn: 5 }, 32);
  setSummary(built, 32, 5, []);
  r = await call(built.routes, { sessionId: 's1', turn: '5', path: a });
  ok(r.status === 200 && r.body.matched === false, '该轮没净变更 → matched=false（不误导用户）');

  // ── [6] 只按已记录清单匹配（AC-9）与路径写法 ───────────────────
  console.log('[6] 路径匹配与「不读任意路径」（AC-9）');
  write('src/secret.ts', 'top secret\n');
  r = await call(built.routes, { sessionId: 's1', turn: '3', path: path.join(cwd, 'src/secret.ts') });
  ok(r.status === 200 && r.body.matched === false, '磁盘上存在但未记录 → matched=false（绝不按任意路径读盘）');
  r = await call(built.routes, { sessionId: 's1', turn: '3', path: 'src/a.ts' });
  ok(r.status === 200 && r.body.matched === true, '相对 cwd 的写法命中');
  r = await call(built.routes, { sessionId: 's1', turn: '3', path: './src\\a.ts' });
  ok(r.status === 200 && r.body.matched === true, '反斜杠 + ./ 前缀归一后命中');
  r = await call(built.routes, { sessionId: 's9', turn: '3', path: a });
  ok(r.status === 404 && r.body.error === 'released', '会话隔离：没记录的会话 → 404 released');
  r = await call(built.routes, { sessionId: 's1', turn: '9', path: a });
  ok(r.status === 404 && r.body.error === 'no-record', '会话在、轮没记录 → 404 no-record');

  // ── [7] 新增文件 / 删除文件 / 二进制 / 超大（AC-6）────────────
  console.log('[7] 内容分支');
  const s2 = { id: 's2' };
  const fresh = path.join(cwd, 'src/new.ts');
  built.event(s2, 'turn/start', { turn: 1 }, 10);
  await built.writeIntent(fresh, { agent: { session: s2 } }); // 文件还不存在 → before absent
  write('src/new.ts', 'created\n');
  const bin = path.join(cwd, 'src/bin.dat');
  fs.writeFileSync(bin, Buffer.from([97, 1, 98]));
  await built.writeIntent(bin, { agent: { session: s2 } });
  fs.writeFileSync(bin, Buffer.from([97, 0, 98])); // 改成含 NUL
  const big = path.join(cwd, 'src/big.ts');
  fs.writeFileSync(big, 'x\n');
  await built.writeIntent(big, { agent: { session: s2 } });
  fs.writeFileSync(big, 'x'.repeat(MAX_SIDE_BYTES + 1));
  const gone = path.join(cwd, 'src/gone.ts');
  fs.writeFileSync(gone, 'will be deleted\n');
  await built.writeIntent(gone, { agent: { session: s2 } });
  fs.rmSync(gone);
  built.event(s2, 'turn/end', { turn: 1 }, 11);
  built.event(s2, 'workspace/changes', { turn: 1 }, 40);
  setSummary(built, 40, 1, ['src/new.ts', 'src/bin.dat', 'src/big.ts', 'src/gone.ts']);

  r = await call(built.routes, { sessionId: 's2', turn: '1', path: fresh });
  ok(r.status === 200 && r.body.before.kind === 'absent' && r.body.after.text === 'created\n', '新增文件：before=absent');
  r = await call(built.routes, { sessionId: 's2', turn: '1', path: bin });
  ok(r.status === 200 && r.body.binary === true, '含 NUL 字节 → binary=true');
  r = await call(built.routes, { sessionId: 's2', turn: '1', path: big });
  ok(r.status === 200 && r.body.oversized === true, '单侧超过 1 MiB → oversized=true');
  r = await call(built.routes, { sessionId: 's2', turn: '1', path: gone });
  ok(r.status === 200 && r.body.before.text === 'will be deleted\n' && r.body.after.kind === 'absent', '删除文件：after=absent');

  // ── [8] shell 直接改动：清单里有、但取不到全文 → no-text ──────
  console.log('[8] shell 直接改动 → no-text（让扩展退回 P0，而不是误报「没变更」）');
  const s3 = { id: 's3' };
  write('src/shell.sh', 'a\n');
  built.event(s3, 'turn/start', { turn: 1 }, 20);
  // 没有 write-intent：模拟 bash 里的 `echo b >> src/shell.sh`
  fs.writeFileSync(path.join(cwd, 'src/shell.sh'), 'a\nb\n');
  built.event(s3, 'turn/end', { turn: 1 }, 21);
  built.event(s3, 'workspace/changes', { turn: 1 }, 50);
  setSummary(built, 50, 1, ['src/shell.sh']);
  r = await call(built.routes, { sessionId: 's3', turn: '1', path: path.join(cwd, 'src/shell.sh') });
  ok(r.status === 200 && r.body.matched === true && r.body.unavailable === 'no-text', '清单里有但无捕获 → matched=true + unavailable=no-text');

  // ── [9] 会话释放 / 旧 dsh ─────────────────────────────────────
  console.log('[9] 会话释放与旧 dsh（AC-4/10）');
  built.emit('session/disposed', s1);
  r = await call(built.routes, { sessionId: 's1', turn: '3', path: a });
  ok(r.status === 404 && r.body.error === 'released', '会话释放后 → 404 released（提示「已随会话释放」）');

  const oldCtx = makeCtx();
  oldCtx.ctx.workspaceChanges = { summary: undefined, diff: undefined };
  mod.apply(oldCtx.ctx);
  const s4 = { id: 's4' };
  oldCtx.event(s4, 'turn/start', { turn: 1 }, 1);
  const oldFile = write('src/old.ts', 'x\n');
  await oldCtx.writeIntent(oldFile, { agent: { session: s4 } });
  write('src/old.ts', 'y\n');
  oldCtx.event(s4, 'turn/end', { turn: 1 }, 2);
  oldCtx.event(s4, 'workspace/changes', { turn: 1 }, 90);
  setSummary(oldCtx, 90, 1, ['src/old.ts']);
  r = await call(oldCtx.routes, { sessionId: 's4', turn: '1', path: oldFile });
  ok(r.status === 404 && r.body.error === 'unavailable', '服务形状不符（旧 dsh）→ 404 unavailable');

  // ── [10] 同轮两条 workspace/changes 取最新 seq ──────────────
  console.log('[10] 同轮多条事件取最新 seq');
  const s5 = { id: 's5' };
  const f5 = write('src/e.ts', 'e0\n');
  built.event(s5, 'turn/start', { turn: 2 }, 60);
  await built.writeIntent(f5, { agent: { session: s5 } });
  write('src/e.ts', 'e1\n');
  built.event(s5, 'turn/end', { turn: 2 }, 61);
  built.event(s5, 'workspace/changes', { turn: 2 }, 70);
  setSummary(built, 70, 2, ['src/e.ts']);
  built.event(s5, 'workspace/changes', { turn: 2 }, 71);
  setSummary(built, 71, 2, ['src/e.ts']);
  r = await call(built.routes, { sessionId: 's5', turn: '2', path: f5 });
  ok(r.status === 200 && r.body.after.text === 'e1\n', '同轮多条事件取最新 seq');

  // ── [11] edit 工具（fs/edit-intent）同样被捕获 ────────────────
  // 真机回归：dsh 的 edit 工具走的是 `fs/edit-intent`（与 write 的 `fs/write-intent`
  // 不同名）。漏钩它时，「先建后编」的文件会返回 no-text → 扩展退 P0 →
  // 未跟踪文件只剩普通打开，用户看到「点了没变更」。
  console.log('[11] edit 工具的 fs/edit-intent 同样被捕获');
  const s6 = { id: 's6' };
  const f6 = write('src/edit.ts', 'v1\n'); // 上一轮已存在
  built.event(s6, 'turn/start', { turn: 1 }, 80);
  await built.editIntent(f6, { agent: { session: s6 } }); // edit 工具：只有 edit-intent
  write('src/edit.ts', 'v2\n');
  built.event(s6, 'turn/end', { turn: 1 }, 81);
  built.event(s6, 'workspace/changes', { turn: 1 }, 95);
  setSummary(built, 95, 1, ['src/edit.ts']);
  r = await call(built.routes, { sessionId: 's6', turn: '1', path: f6 });
  ok(r.status === 200 && r.body.matched === true && !r.body.unavailable, 'edit 工具的改动也能取到两侧全文');
  ok(r.body.before.text === 'v1\n' && r.body.after.text === 'v2\n', 'before=编辑前原文、after=轮结束内容');

  // 同一轮混用 write 与 edit：仍是同一条净变更
  const s7 = { id: 's7' };
  const f7 = write('src/mix.ts', 'm0\n');
  built.event(s7, 'turn/start', { turn: 1 }, 100);
  await built.writeIntent(f7, { agent: { session: s7 } });
  write('src/mix.ts', 'm1\n');
  await built.editIntent(f7, { agent: { session: s7 } });
  write('src/mix.ts', 'm2\n');
  built.event(s7, 'turn/end', { turn: 1 }, 101);
  built.event(s7, 'workspace/changes', { turn: 1 }, 96);
  setSummary(built, 96, 1, ['src/mix.ts']);
  r = await call(built.routes, { sessionId: 's7', turn: '1', path: f7 });
  ok(r.body.before.text === 'm0\n' && r.body.after.text === 'm2\n', 'write+edit 混用仍合并为一条净变更（AC-1 语义）');

  console.log('\n全部通过：' + passed + ' 项断言 ✓');
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
