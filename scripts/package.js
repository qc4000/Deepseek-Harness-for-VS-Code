#!/usr/bin/env node
'use strict';
/**
 * 打包脚本：调试版 / 候选版 / 正式版（命名规则见 docs/CONVENTIONS.md §9「调试/候选包命名」）。
 *
 * 用法：
 *   node scripts/package.js debug            日常调试：X.Y.Z-dev.N
 *   node scripts/package.js rc               候选（预览）验证：X.Y.Z-rc.N
 *   node scripts/package.js release          正式发版：X.Y.Z（package.json 必须已是正式号）
 *   node scripts/package.js <debug|rc> X.Y.Z 显式基版本：不看 package.json，直接用它出包
 *                                            （例 npm run package:rc -- 1.1.3 → 1.1.3-rc.1 …）
 *   node scripts/package.js <mode> --out <目录>    输出目录，默认 out/
 *   npm run package:debug | package:rc | package:release   （npm run package = release）
 *
 * 版本号 N 的取法：max(out/ 里「同 base 同族」已有的 N、package.json 当前同族的 N) + 1，
 * 即每次重打包自动递增；换 base（如 1.1.2 → 1.1.3）后从 1 重新计数。
 * 正式版要求 package.json 已是 X.Y.Z——带预发布号会被拒绝并提示先定稿（docs/CI-CD.md §4）。
 *
 * 过程：临时把 package.json 的 version 写成目标号 → vsce 打到 `<out>/<name>-<version>.vsix`
 * → **无论成败都把 package.json 逐字节恢复**（不产生 diff、不吞掉真实版本）。
 * 产物不进 git（.gitignore: out/ 与 *.vsix）、也不被打进 vsix（.vscodeignore: out/**）。
 *
 * ⚠️ 预发布号一律不打 tag：`v*` 会触发 Release 工作流并生成正式 Release（docs/CI-CD.md）。
 * 零依赖：只用 Node 内置模块；Windows 下 npx 需 shell（仓库已知坑），POSIX 不加 shell。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MODES = ['debug', 'rc', 'release'];

/** 取 semver 的 `X.Y.Z` 基础版本（丢掉预发布号与构建元数据）。 */
function baseVersion(version) {
  const m = /^(\d+\.\d+\.\d+)/.exec(String(version || ''));
  if (!m) throw new Error('package.json 的 version 不是 semver X.Y.Z：' + version);
  return m[1];
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 计算目标版本号（纯函数，便于测试）。
 * @param {'debug'|'rc'|'release'} mode
 * @param {string} current package.json 当前 version
 * @param {number[]} [seed] out/ 里同 base 同族已有的 N 列表
 * @param {string} [explicitBase] 命令行显式指定的基版本 `X.Y.Z`（debug/rc 用；release 忽略它）
 * @returns {string}
 */
function computeVersion(mode, current, seed, explicitBase) {
  if (mode === 'release') {
    // 正式版永远以 package.json 为准：版本必须先经发版流程写进 package.json（docs/CI-CD.md §4），
    // 不允许命令行临时指定，否则会绕过「定稿」这道门。
    if (current !== baseVersion(current)) {
      throw new Error('正式版要求 package.json 已是正式版本号，当前 ' + current
        + ' 是预发布号——先按 docs/CI-CD.md §4 定稿 ' + baseVersion(current) + ' 再打包（候选包请用 package:rc）');
    }
    return baseVersion(current);
  }
  const kind = mode === 'debug' ? 'dev' : (mode === 'rc' ? 'rc' : null);
  if (!kind) throw new Error('未知打包模式：' + mode + '（可用：' + MODES.join(' | ') + '）');
  const base = explicitBase ? baseVersion(explicitBase) : baseVersion(current);
  let max = 0;
  // package.json 自己就是**同 base 同族**预发布号时，也要参与递增（避免从 1 重新数）
  const self = new RegExp('^' + escapeRegExp(base) + '-' + kind + '\\.(\\d+)$').exec(String(current));
  if (self) max = parseInt(self[1], 10);
  for (const n of seed || []) {
    if (Number.isFinite(n) && n > max) max = n;
  }
  return base + '-' + kind + '.' + (max + 1);
}

/**
 * 扫描输出目录里已有的同 base 同族预发布包，取出它们的 N。
 * 只认 `<name>-<base>-<kind>.N.vsix`，其它 base / 其它族一律忽略（换版本后从 1 计数）。
 * @param {string} outDir
 * @param {string} name 扩展名（package.json 的 name）
 * @param {string} base `X.Y.Z`
 * @param {'dev'|'rc'} kind
 * @returns {number[]}
 */
function scanPrerelease(outDir, name, base, kind) {
  let entries = [];
  try {
    entries = fs.readdirSync(outDir);
  } catch (e) {
    return []; // 目录还不存在：没有历史包
  }
  const re = new RegExp('^' + escapeRegExp(name) + '-' + escapeRegExp(base) + '-' + kind + '\\.(\\d+)\\.vsix$');
  const found = [];
  for (const file of entries) {
    const m = re.exec(file);
    if (m) found.push(parseInt(m[1], 10));
  }
  return found;
}

/**
 * 解析命令行：`<debug|rc|release> [X.Y.Z] [--out <目录>]`。
 * 可选的 `X.Y.Z` 只对 debug/rc 有意义：**打包用这个基版本**（不看 package.json 当前值），
 * 便于不改 package.json 就为下一版打候选包（如 `npm run package:rc -- 1.1.3`）。
 * @param {string[]} argv
 * @returns {{mode: string, outDir: string, version: string|null, help?: boolean}}
 */
function parseArgs(argv) {
  let mode = null;
  let outDir = 'out';
  let version = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { mode: null, outDir: outDir, version: null, help: true };
    if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out 需要一个目录参数');
      outDir = value;
      continue;
    }
    if (arg.indexOf('--') === 0) throw new Error('未知参数：' + arg);
    if (!mode) { mode = arg; continue; }
    if (!version) {
      if (mode === 'release') {
        throw new Error('正式版不接受版本号参数：版本必须先按 docs/CI-CD.md §4 写进 package.json');
      }
      baseVersion(arg); // 只校验形态（`1.1.3-rc.1` 之类会取其基版本），非法直接报错
      version = arg;
      continue;
    }
    throw new Error('多余参数：' + arg);
  }
  if (!mode) throw new Error('缺少打包模式：' + MODES.join(' | '));
  if (MODES.indexOf(mode) < 0) throw new Error('未知打包模式：' + mode + '（可用：' + MODES.join(' | ') + '）');
  return { mode: mode, outDir: outDir, version: version };
}

/**
 * 目录能不能当 npx 缓存用：先建目录，再**真写一次**探针文件。
 * 注意不能只用 `accessSync(W_OK)`——它只看权限位，认不出只读挂载（EROFS）。
 * @param {string} dir
 * @returns {boolean}
 */
function isUsableCache(dir) {
  const probe = path.join(dir, '.write-probe-' + process.pid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    try { fs.unlinkSync(probe); } catch (e2) { /* 探针本来就没建成 */ }
    return false;
  }
}

/**
 * 决定 npx 的缓存目录：`npm run` 会把 `npm_config_cache` 指到 `$HOME/.npm`，
 * 而只读 HOME / 只读 tmpdir 的沙箱里它写不进去（EROFS，报错还很难懂）。
 * 规则：当前生效的缓存真能写就返回 null（不干预）；否则换成一个真能写的候选；
 * 都不行返回 null，让 npm 自己报错（不掩盖真实错误）。
 * @returns {string|null} 需要写进 env 的缓存目录；null 表示不动 env
 */
function resolveNpmCache() {
  const declared = process.env.npm_config_cache;
  const homeCache = path.join(os.homedir(), '.npm');
  const effective = declared || homeCache;
  if (isUsableCache(effective)) return null;
  const candidates = [path.join(os.tmpdir(), 'npm-cache')];
  // 有的沙箱里 os.tmpdir() 指向只读的宿主临时目录：POSIX 下退回系统 /tmp 再试一次。
  if (process.platform !== 'win32' && os.tmpdir() !== '/tmp') candidates.push('/tmp/npm-cache');
  if (homeCache !== effective) candidates.push(homeCache);
  for (const dir of candidates) {
    if (isUsableCache(dir)) return dir;
  }
  return null;
}

/**
 * 调 vsce 打包。
 * @param {string[]} args 传给 vsce 的参数
 * @param {string} root 仓库根
 * @returns {number} 退出码
 */
function runVsce(args, root) {
  const env = Object.assign({}, process.env);
  const cache = resolveNpmCache();
  if (cache) env.npm_config_cache = cache;
  const result = spawnSync('npx', ['--yes', '@vscode/vsce'].concat(args), {
    cwd: root,
    stdio: 'inherit',
    env: env,
    // 仓库已知坑：Windows 的 npx 是 .cmd，必须 shell:true；POSIX 必须无 shell。
    shell: process.platform === 'win32'
  });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}

/**
 * 打一个包：临时改版本 → vsce → 逐字节恢复 package.json。
 *
 * @param {{mode: string, outDir?: string, root?: string, version?: string,
 *          runVsce?: (args: string[], root: string) => number|Promise<number>}} opts
 *   `version` 为显式基版本（debug/rc）：打包用它而不是 package.json 当前值。
 * @returns {Promise<{version: string, outFile: string, previousVersion: string}>}
 */
async function packageExtension(opts) {
  const o = opts || {};
  const root = o.root || ROOT;
  const outDir = path.resolve(root, o.outDir || 'out');
  const pkgPath = path.join(root, 'package.json');
  const original = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(original);

  const base = o.version ? baseVersion(o.version) : baseVersion(pkg.version);
  const kind = o.mode === 'debug' ? 'dev' : (o.mode === 'rc' ? 'rc' : null);
  const seed = kind ? scanPrerelease(outDir, pkg.name, base, kind) : [];
  const target = computeVersion(o.mode, pkg.version, seed, o.version);
  const outFile = path.join(outDir, pkg.name + '-' + target + '.vsix');

  fs.mkdirSync(outDir, { recursive: true });
  const staged = JSON.parse(original);
  staged.version = target;
  fs.writeFileSync(pkgPath, JSON.stringify(staged, null, 2) + '\n');
  try {
    const run = o.runVsce || runVsce;
    const code = await run(['package', '--allow-missing-repository', '--out', outFile], root);
    if (code !== 0) throw new Error('vsce 打包失败（退出码 ' + code + '）');
    if (!fs.existsSync(outFile)) throw new Error('vsce 未产出预期文件：' + outFile);
    return { version: target, outFile: outFile, previousVersion: pkg.version };
  } finally {
    // 无论成功、vsce 报错还是抛异常，都逐字节还原，避免把预发布号留在工作区里。
    fs.writeFileSync(pkgPath, original);
  }
}

/**
 * 预防性警告：基版本已有正式 tag `vX.Y.Z` 时，提醒「再打预发布会低于已发布版本」。
 * 只对 debug/rc 有意义——release 就是正式版本身，重打同号是正常操作。
 *
 * 为什么只警告不拦截：往回打（复现旧版）有时确实合理，且 Marketplace 的版本校验
 * 在发布环节还会兜一层；这里只负责在最容易犯错的时刻把后果与正确做法讲清楚。
 * 判断不了（没装 git / 非 git 仓库 / git 报错）一律返回 null，不打扰正常打包。
 *
 * @param {string} root 仓库根（在该目录下执行 git）
 * @param {string} base `X.Y.Z`
 * @returns {string|null} 警告文案；没有 tag 或判断不了 → null
 */
function releaseTagWarning(root, base) {
  let stdout = '';
  try {
    const result = spawnSync('git', ['tag', '-l', 'v' + base], {
      cwd: root,
      encoding: 'utf8',
      // 仓库已知坑：Windows 走 shell（参数是校验过的 semver，无注入面）；POSIX 无 shell。
      shell: process.platform === 'win32'
    });
    if (result.error || result.status !== 0) return null;
    stdout = String(result.stdout || '');
  } catch (e) {
    return null;
  }
  if (stdout.trim() === '') return null;
  return '基版本 ' + base + ' 已有正式 tag v' + base + '：再打预发布会低于已发布的 '
    + base + '（真去 publish 也会被拒）。\n'
    + '     · 要给下一版打候选包 → 传基版本：npm run package:rc -- <下一版>\n'
    + '     · 确实要往回打（复现旧版）→ 忽略本提示即可';
}

function usage() {
  return [
    '用法：node scripts/package.js <debug|rc|release> [X.Y.Z] [--out <目录>]',
    '  debug    调试版 X.Y.Z-dev.N（N 每次重打包递增）',
    '  rc       候选版 X.Y.Z-rc.N（= 预览版）',
    '  release  正式版 X.Y.Z（package.json 必须已是正式号，不接受版本号参数）',
    '  X.Y.Z    可选：显式基版本（仅 debug/rc）——不看 package.json 当前值，',
    '           直接用它出包，N 取 out/ 里同 base 同族已有最大值 +1',
    '           例：npm run package:rc -- 1.1.3  →  1.1.3-rc.1 / 1.1.3-rc.2 …',
    '  --out    输出目录，默认 out/',
    '',
    '预发布号（debug/rc）一律不打 tag：v* 会触发 Release 工作流生成正式 Release。'
  ].join('\n');
}

/**
 * CLI 入口。`opts` 仅供测试注入：`{ root, runVsce }`。
 * @param {string[]} argv
 * @param {{root?: string, runVsce?: (args: string[], root: string) => number|Promise<number>}} [opts]
 */
async function main(argv, opts) {
  const o = opts || {};
  const root = o.root || ROOT;
  const args = parseArgs(argv);
  const explicitBase = args.version ? baseVersion(args.version) : null;
  const currentVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const base = explicitBase || baseVersion(currentVersion);
  console.log('▸ 打包模式 ' + args.mode
    + (explicitBase ? '（基版本 ' + explicitBase + ' ← 显式指定）' : '')
    + '（输出目录 ' + args.outDir + '）');
  // 预防性警告放在打包之前：出包前就看见，而不是打完才后悔。
  if (args.mode !== 'release') {
    const warning = releaseTagWarning(root, base);
    if (warning) console.log('  ⚠️ ' + warning);
  }
  const result = await packageExtension({
    mode: args.mode,
    outDir: args.outDir,
    version: args.version || undefined,
    root: root,
    runVsce: o.runVsce
  });
  console.log('  版本：' + result.previousVersion + ' → ' + result.version);
  console.log('  产物：' + path.relative(root, result.outFile));
  console.log('  package.json 已恢复为 ' + result.previousVersion);
  if (explicitBase && explicitBase !== baseVersion(result.previousVersion)) {
    console.log('  ℹ️ 基版本 ' + explicitBase + ' ≠ package.json 的 ' + baseVersion(result.previousVersion)
      + '（仅打包期间临时改写，已逐字节恢复）');
  }
  if (args.mode !== 'release') {
    console.log('  ⚠️ 预发布包：不打 tag、不进 Release（docs/CONVENTIONS.md §9）');
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error('✗ ' + (e && e.message ? e.message : e));
    console.error('\n' + usage());
    process.exit(1);
  });
}

module.exports = {
  baseVersion,
  computeVersion,
  scanPrerelease,
  parseArgs,
  packageExtension,
  runVsce,
  resolveNpmCache,
  releaseTagWarning,
  main,
  ROOT,
  MODES
};
