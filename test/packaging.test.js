'use strict';
/**
 * 打包脚本（scripts/package.js）回归测试。
 * 运行：node test/packaging.test.js
 * 覆盖：版本号命名（CONVENTIONS §9：X.Y.Z-dev.N / X.Y.Z-rc.N / X.Y.Z）、
 *      out/ 预发布包扫描与递增、参数解析、
 *      打包期间临时改版本 + **逐字节恢复**（成功 / vsce 失败 / 抛异常 / 正式版拒绝预发布号）、
 *      产物不进包不进仓库、npm scripts 接线。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pack = require(path.join(ROOT, 'scripts', 'package.js'));

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

/** 建一个假的扩展根（只放最小 package.json），返回目录与清理函数。 */
function makeTempRoot(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-packaging-'));
  const pkgPath = path.join(dir, 'package.json');
  const content = JSON.stringify({ name: 'deepseek-harness-vscode', version: version }, null, 2) + '\n';
  fs.writeFileSync(pkgPath, content);
  return {
    dir: dir,
    pkgPath: pkgPath,
    original: content,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 尽力清理 */ } }
  };
}

(async function run() {
  console.log('[1] 版本号命名（debug=X.Y.Z-dev.N / rc=X.Y.Z-rc.N / release=X.Y.Z）');
  ok(pack.baseVersion('1.1.2') === '1.1.2', '正式号取基版本');
  ok(pack.baseVersion('1.1.3-rc.2') === '1.1.3', '预发布号丢掉后缀取基版本');
  ok(pack.computeVersion('debug', '1.1.2', []) === '1.1.2-dev.1', '调试版首次 → dev.1');
  ok(pack.computeVersion('debug', '1.1.2', [1, 2]) === '1.1.2-dev.3', 'out/ 已有 dev.1/2 → dev.3');
  ok(pack.computeVersion('debug', '1.1.2-dev.4', []) === '1.1.2-dev.5', 'package.json 自身同族 N 也参与递增');
  ok(pack.computeVersion('debug', '1.1.2-dev.4', [7]) === '1.1.2-dev.8', '取自身与 out/ 的较大者 +1');
  ok(pack.computeVersion('rc', '1.1.2', [2]) === '1.1.2-rc.3', '候选版 → rc.3');
  ok(pack.computeVersion('rc', '1.1.2', [1, 2]) === '1.1.2-rc.3' && pack.computeVersion('debug', '1.1.2', [1, 2]) === '1.1.2-dev.3',
    'dev 与 rc 两族独立计数');
  ok(pack.computeVersion('release', '1.1.2', []) === '1.1.2', '正式版原样打包');
  // 显式基版本（候选/调试可传 X.Y.Z，不看 package.json 当前值）
  ok(pack.computeVersion('rc', '1.1.2', [5], '1.1.3') === '1.1.3-rc.6',
    '显式传 1.1.3 + out/ 已有 1.1.3-rc.5 → 1.1.3-rc.6');
  ok(pack.computeVersion('debug', '1.1.2', [2], '1.1.3') === '1.1.3-dev.3', 'debug 同样支持显式基版本');
  ok(pack.computeVersion('rc', '1.1.3-rc.1', [], '1.1.3') === '1.1.3-rc.2',
    '显式基版本与 package.json 同 base 时，自身 rc.N 仍参与递增');
  ok(pack.computeVersion('rc', '1.1.2', [], '1.1.3-rc.7') === '1.1.3-rc.1',
    '传带预发布号的版本也取其基版本（1.1.3-rc.7 → 1.1.3）');
  ok(pack.computeVersion('release', '1.1.2', [], '1.1.3') === '1.1.2',
    'release 忽略显式版本，永远以 package.json 为准');
  assert.throws(() => pack.computeVersion('release', '1.1.3-rc.1', []), /预发布号/, '正式版拒绝预发布号');
  assert.throws(() => pack.computeVersion('beta', '1.1.2', []), /未知打包模式/, '未知模式报错并列出可用模式');
  assert.throws(() => pack.baseVersion('vnext'), /semver X\.Y\.Z/, '非法版本号报错');

  console.log('[2] 扫描 out/ 里已有的预发布包（只认同 base 同族）');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-out-'));
    try {
      const name = 'deepseek-harness-vscode';
      for (const f of [
        name + '-1.1.2-dev.1.vsix',
        name + '-1.1.2-dev.2.vsix',
        name + '-1.1.3-dev.9.vsix', // 换了 base 的旧包不参与
        name + '-1.1.2-rc.5.vsix',  // 另一族不参与（编号也不同，便于区分）
        'readme.txt'
      ]) fs.writeFileSync(path.join(dir, f), '');
      assert.deepStrictEqual(pack.scanPrerelease(dir, name, '1.1.2', 'dev'), [1, 2], '同 base 同族按 N 排出，且不含 rc 的 5');
      assert.deepStrictEqual(pack.scanPrerelease(dir, name, '1.1.3', 'dev'), [9], '换 base 只认自己的包');
      assert.deepStrictEqual(pack.scanPrerelease(dir, name, '1.1.2', 'rc'), [5], 'rc 族独立计数，且不含 dev 的 1/2');
      ok(true, '扫描结果符合预期（dev 1/2、rc 5、1.1.3 的 9 互不串）');
      ok(pack.scanPrerelease(path.join(dir, 'no-such-dir'), name, '1.1.2', 'dev').length === 0,
        '目录不存在 → 空数组（首次打包）');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 尽力清理 */ }
    }
  }

  console.log('[3] 命令行解析');
  assert.deepStrictEqual(pack.parseArgs(['debug']), { mode: 'debug', outDir: 'out', version: null },
    '默认输出目录 out/、无显式版本');
  assert.deepStrictEqual(pack.parseArgs(['rc', '1.1.3']), { mode: 'rc', outDir: 'out', version: '1.1.3' },
    '候选版可传显式基版本');
  assert.deepStrictEqual(pack.parseArgs(['debug', '1.1.3-rc.1', '--out', 'dist']),
    { mode: 'debug', outDir: 'dist', version: '1.1.3-rc.1' }, '显式版本带预发布号也接受（取其基版本）');
  assert.deepStrictEqual(pack.parseArgs(['rc', '--out', 'dist']), { mode: 'rc', outDir: 'dist', version: null },
    '--out 覆盖目录');
  assert.strictEqual(pack.parseArgs(['--help']).help, true, '--help 标记帮助');
  assert.throws(() => pack.parseArgs([]), /缺少打包模式/, '缺模式报错');
  assert.throws(() => pack.parseArgs(['nightly']), /未知打包模式/, '未知模式报错');
  assert.throws(() => pack.parseArgs(['debug', 'extra']), /semver X\.Y\.Z/, '版本号形态非法报错');
  assert.throws(() => pack.parseArgs(['debug', '1.1.3', 'extra']), /多余参数/, '多余位置参数报错');
  assert.throws(() => pack.parseArgs(['release', '1.1.3']), /正式版不接受版本号参数/,
    '正式版不接受版本号参数（版本必须先写进 package.json）');
  assert.throws(() => pack.parseArgs(['debug', '--out']), /需要一个目录/, '--out 缺值报错');
  ok(true, '11 条解析用例（含 5 类错误输入）');

  console.log('[4] 打包流程：临时改版本 → 产物 → 逐字节恢复');
  {
    const fake = makeTempRoot('1.1.2');
    try {
      // 成功路径：假 vsce 记录当时的版本并按 --out 造出产物
      let seenVersion = null;
      let seenArgs = null;
      const runOk = (args) => {
        seenArgs = args;
        seenVersion = JSON.parse(fs.readFileSync(fake.pkgPath, 'utf8')).version;
        fs.writeFileSync(args[args.indexOf('--out') + 1], '');
        return 0;
      };
      const first = await pack.packageExtension({ mode: 'debug', root: fake.dir, runVsce: runOk });
      ok(seenVersion === '1.1.2-dev.1', '打包期间 package.json 已是目标预发布号（' + seenVersion + '）');
      ok(seenArgs.indexOf('--allow-missing-repository') >= 0 && seenArgs.indexOf('package') === 0,
        '调用 vsce package --allow-missing-repository --out <文件>');
      ok(first.version === '1.1.2-dev.1', '返回目标版本');
      ok(first.outFile === path.join(fake.dir, 'out', 'deepseek-harness-vscode-1.1.2-dev.1.vsix'),
        '产物路径 = <out>/<name>-<version>.vsix');
      ok(fs.existsSync(first.outFile), '产物已生成');
      ok(fs.readFileSync(fake.pkgPath, 'utf8') === fake.original, '成功后 package.json 逐字节恢复');
      ok(JSON.parse(fs.readFileSync(fake.pkgPath, 'utf8')).version === '1.1.2', '恢复出的版本仍是 1.1.2');

      // 第二次打包：out/ 里已有 dev.1 → 递增到 dev.2
      const second = await pack.packageExtension({ mode: 'debug', root: fake.dir, runVsce: runOk });
      ok(second.version === '1.1.2-dev.2', '重打包自动递增（dev.1 → dev.2）');
      ok(fs.readFileSync(fake.pkgPath, 'utf8') === fake.original, '第二次同样逐字节恢复');

      // 显式基版本（候选版可传 X.Y.Z）：不看 package.json 的 1.1.2，按传入的 1.1.3 出包
      const explicit = await pack.packageExtension({ mode: 'rc', root: fake.dir, version: '1.1.3', runVsce: runOk });
      ok(explicit.version === '1.1.3-rc.1', '显式传 1.1.3 → 1.1.3-rc.1（out/ 里没有同 base 的 rc 包）');
      ok(seenVersion === '1.1.3-rc.1', '打包期间 package.json 被临时写成显式基版本（1.1.3-rc.1）');
      ok(fs.readFileSync(fake.pkgPath, 'utf8') === fake.original, '显式基版本打包后 package.json 仍逐字节恢复');
      const explicit2 = await pack.packageExtension({ mode: 'rc', root: fake.dir, version: '1.1.3', runVsce: runOk });
      ok(explicit2.version === '1.1.3-rc.2', '再打同一个显式版本 → 1.1.3-rc.2（按 out/ 递增）');
      ok(fs.readFileSync(fake.pkgPath, 'utf8') === fake.original, '显式基版本第二次同样逐字节恢复');

      // 失败路径：vsce 返回非 0 → 抛错但仍恢复
      await assert.rejects(
        pack.packageExtension({ mode: 'rc', root: fake.dir, runVsce: () => 1 }),
        /vsce 打包失败（退出码 1）/, 'vsce 失败 → 抛错带退出码');
      ok(fs.readFileSync(fake.pkgPath, 'utf8') === fake.original, 'vsce 失败后 package.json 仍逐字节恢复');

      // 异常路径：runner 直接抛 → 仍恢复
      await assert.rejects(
        pack.packageExtension({ mode: 'rc', root: fake.dir, runVsce: () => { throw new Error('boom'); } }),
        /boom/, 'runner 抛异常原样上抛');
      ok(fs.readFileSync(fake.pkgPath, 'utf8') === fake.original, '异常后 package.json 仍逐字节恢复');

      // 产物缺失：返回 0 但没造文件 → 报错且恢复
      await assert.rejects(
        pack.packageExtension({ mode: 'rc', root: fake.dir, runVsce: () => 0 }),
        /未产出预期文件/, 'vsce 未产出文件 → 报错');
      ok(fs.readFileSync(fake.pkgPath, 'utf8') === fake.original, '未产出文件同样恢复');
    } finally {
      fake.cleanup();
    }
  }

  console.log('[5] 正式版拒绝预发布号（且不动 package.json）');
  {
    const fake = makeTempRoot('1.1.3-rc.1');
    try {
      let called = false;
      await assert.rejects(
        pack.packageExtension({ mode: 'release', root: fake.dir, runVsce: () => { called = true; return 0; } }),
        /正式版要求 package\.json 已是正式版本号/, '预发布号打包正式版 → 拒绝并提示先定稿');
      ok(!called, '拒绝时不会去调 vsce');
      ok(fs.readFileSync(fake.pkgPath, 'utf8') === fake.original, '拒绝时 package.json 未被改写');
    } finally {
      fake.cleanup();
    }
  }

  console.log('[6] 产物不进仓库、不进包；npm scripts 接线');
  {
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
    const vscodeignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8').split('\n').map((l) => l.trim());
    ok(gitignore.indexOf('out/') >= 0, '.gitignore 忽略 out/');
    ok(gitignore.indexOf('*.vsix') >= 0, '.gitignore 兜底忽略所有 .vsix');
    ok(vscodeignore.indexOf('out/**') >= 0, '.vscodeignore 忽略 out/**（历史 vsix 不打进新包）');

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const s = pkg.scripts || {};
    ok(s.package === 'node scripts/package.js release', 'npm run package = 正式版脚本');
    ok(s['package:debug'] === 'node scripts/package.js debug', 'npm run package:debug 已接线');
    ok(s['package:rc'] === 'node scripts/package.js rc', 'npm run package:rc 已接线');
    ok(s['package:release'] === 'node scripts/package.js release', 'npm run package:release 已接线');
  }

  console.log('[7] npx 缓存目录兜底（只读 HOME / 只读 tmpdir 的沙箱）');
  {
    const saved = process.env.npm_config_cache;
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npm-cache-'));
    try {
      // a) 指定的缓存真能写 → 不干预（accessSync 认不出只读挂载，脚本用真写探针判断）
      process.env.npm_config_cache = path.join(tmpRoot, 'ok-cache');
      ok(pack.resolveNpmCache() === null, '指定的缓存可用 → 不覆盖调用者设置');

      // b) 指定的缓存写不进去（父路径是个文件，mkdir 必失败）→ 换可用候选或交 npm 自己报错
      const blocker = path.join(tmpRoot, 'not-a-dir');
      fs.writeFileSync(blocker, '');
      process.env.npm_config_cache = path.join(blocker, 'cache');
      const fixed = pack.resolveNpmCache();
      ok(fixed === null || (typeof fixed === 'string' && fs.existsSync(fixed)),
        '指定的缓存不可用 → 换成真能写的候选（' + fixed + '）');

      // c) 未指定 → 默认位置可用就不动，否则挑可用候选
      delete process.env.npm_config_cache;
      const picked = pack.resolveNpmCache();
      ok(picked === null || (typeof picked === 'string' && fs.existsSync(picked)),
        '未指定缓存时：默认可用则不干预，否则挑可用候选（' + picked + '）');
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* 尽力清理 */ }
      if (saved === undefined) delete process.env.npm_config_cache;
      else process.env.npm_config_cache = saved;
    }
  }

  console.log('[8] 预防性警告：基版本已有正式 tag（debug/rc 才给，不拦截）');
  {
    // 判断不了就不打扰：非 git 仓库 / 没装 git 都返回 null
    const plain = makeTempRoot('1.1.2');
    try {
      ok(pack.releaseTagWarning(plain.dir, '1.1.2') === null, '非 git 仓库 → 判断不了就不打扰');
    } finally {
      plain.cleanup();
    }

    let gitAvailable = false;
    try {
      gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
    } catch (e) { gitAvailable = false; }

    if (!gitAvailable) {
      ok(true, '本机没有 git：跳过 tag 判定用例');
    } else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pack-tag-'));
      try {
        const git = (argv) => {
          const r = spawnSync('git', argv, { cwd: dir, encoding: 'utf8' });
          if (r.status !== 0) throw new Error('git ' + argv.join(' ') + ' 失败：' + (r.stderr || r.stdout));
        };
        git(['init', '-q']);
        git(['-c', 'user.email=t@example.com', '-c', 'user.name=t',
          'commit', '-q', '--allow-empty', '-m', 'init']);
        git(['tag', 'v1.1.2']);

        const warn = pack.releaseTagWarning(dir, '1.1.2');
        ok(typeof warn === 'string' && warn.indexOf('v1.1.2') >= 0, '已有 tag → 给出警告（含 tag 名）');
        ok(warn.indexOf('package:rc --') >= 0, '警告里指路「给下一版打要传基版本」');
        ok(pack.releaseTagWarning(dir, '1.1.3') === null, '没有 tag 的基版本 → 不警告');

        // main 层：打印警告但**不拦截**（注入假 vsce，不真打包）
        const pkgPath = path.join(dir, 'package.json');
        const original = JSON.stringify({ name: 'deepseek-harness-vscode', version: '1.1.2' }, null, 2) + '\n';
        fs.writeFileSync(pkgPath, original);
        const fakeRun = (args) => { fs.writeFileSync(args[args.indexOf('--out') + 1], ''); return 0; };
        const logs = [];
        const origLog = console.log;
        console.log = (msg) => { logs.push(String(msg)); };
        try {
          await pack.main(['rc'], { root: dir, runVsce: fakeRun });
        } finally {
          console.log = origLog;
        }
        const text = logs.join('\n');
        ok(text.indexOf('已有正式 tag v1.1.2') >= 0, 'main 在打包前打印了预防性警告');
        ok(text.indexOf('1.1.2-rc.1') >= 0, '警告不拦截：照常产出 1.1.2-rc.1');
        ok(fs.readFileSync(pkgPath, 'utf8') === original, '警告路径下 package.json 仍逐字节恢复');

        logs.length = 0;
        console.log = (msg) => { logs.push(String(msg)); };
        try {
          await pack.main(['release'], { root: dir, runVsce: fakeRun });
        } finally {
          console.log = origLog;
        }
        ok(logs.join('\n').indexOf('已有正式 tag') < 0,
          'release 模式不给「已有 tag」警告（重打正式版是正常操作）');
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 尽力清理 */ }
      }
    }
  }

  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
