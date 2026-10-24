#!/usr/bin/env node
'use strict';
/**
 * 零依赖测试运行器（遵循项目「零依赖、零构建」约束）。
 *
 * 用法：
 *   node scripts/run-tests.js            # 语法检查 + 全部离线单测（跳过真实 dsh 的 e2e）
 *   node scripts/run-tests.js --e2e      # 额外运行 test/e2e-real-dsh.test.js（需本机已装 dsh）
 *   node scripts/run-tests.js --only file-link   # 只跑文件名含该子串的套件
 *   node scripts/run-tests.js --verbose  # 打印每个套件的完整输出（TDD 时用）
 *
 * 约定（与 test/*.test.js 一致）：
 *  - 每个套件是独立进程，自带 `vscode` 桩，成功时打印「全部通过：N 项断言 ✓」并以 0 退出；
 *  - 失败以非 0 退出，运行器汇总后整体非 0 退出（CI 据此判红）；
 *  - 套件串行执行：多个套件会绑定回环端口，并行会互相抢端口。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const UNIT_TIMEOUT_MS = 180000;
const E2E_TIMEOUT_MS = 420000;

const argv = process.argv.slice(2);
const withE2E = argv.includes('--e2e');
const verbose = argv.includes('--verbose') || argv.includes('-v');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '') : '';

function isE2E(file) {
  return /e2e/i.test(file);
}

/** 语法检查：扩展主体 + 内置插件（含 ESM 的 lib/index.js）。 */
function syntaxCheck() {
  // 扩展主体 + 全部内置插件（插件目录新增时自动纳入，无需改这里）
  const targets = ['extension.js'];
  const pluginRoot = path.join(ROOT, 'dsh-plugins');
  let pluginDirs = [];
  try {
    pluginDirs = fs.readdirSync(pluginRoot).sort();
  } catch (e) {
    pluginDirs = [];
  }
  for (const name of pluginDirs) {
    for (const rel of ['lib/index.js', 'lib/client.js']) {
      const file = path.join(pluginRoot, name, rel);
      if (fs.existsSync(file)) targets.push(path.join('dsh-plugins', name, rel));
    }
  }
  const failed = [];
  for (const rel of targets) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) {
      failed.push(rel + '（文件缺失）');
      continue;
    }
    const r = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      failed.push(rel + '\n' + String(r.stderr || r.stdout || '').trim());
    }
  }
  return { failed, pluginFiles: targets.length - 1 };
}

function listSuites() {
  let files;
  try {
    files = fs.readdirSync(TEST_DIR);
  } catch (e) {
    console.error('找不到 test/ 目录：' + e.message);
    process.exit(2);
  }
  return files
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => (only ? f.indexOf(only) >= 0 : true))
    .filter((f) => (isE2E(f) ? withE2E : true))
    .sort((a, b) => Number(isE2E(a)) - Number(isE2E(b)) || a.localeCompare(b));
}

/** 从套件输出里取「全部通过：N 项断言」的 N；取不到返回 0。 */
function assertionCount(output) {
  const m = /全部通过：\s*(\d+)\s*项断言/.exec(output);
  return m ? parseInt(m[1], 10) : 0;
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function main() {
  console.log('▸ 语法检查');
  const syntax = syntaxCheck();
  if (syntax.failed.length > 0) {
    for (const e of syntax.failed) console.error('  ✗ ' + e);
    console.error('\n语法检查未通过，测试未执行。');
    process.exit(1);
  }
  console.log('  ✓ extension.js + dsh-plugins（' + syntax.pluginFiles + ' 个插件文件）');

  const suites = listSuites();
  if (suites.length === 0) {
    console.error('没有匹配的测试套件（--only=' + only + '）。');
    process.exit(2);
  }

  console.log('\n▸ 测试套件（' + suites.length + ' 个' + (withE2E ? '，含 e2e' : '，离线') + '）');
  const failures = [];
  let totalAssertions = 0;

  for (const suite of suites) {
    const file = path.join(TEST_DIR, suite);
    const started = Date.now();
    const r = spawnSync(process.execPath, [file], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: isE2E(suite) ? E2E_TIMEOUT_MS : UNIT_TIMEOUT_MS,
      env: Object.assign({}, process.env, { DSH_TEST_RUNNER: '1' })
    });
    const output = String(r.stdout || '') + String(r.stderr || '');
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const okRun = r.status === 0;
    const count = assertionCount(output);
    totalAssertions += count;

    if (okRun) {
      console.log('  ✓ ' + pad(suite, 38) + pad(count + ' 项断言', 12) + elapsed + 's');
      if (verbose) console.log(output.trimEnd().split('\n').map((l) => '      ' + l).join('\n'));
    } else {
      console.log('  ✗ ' + pad(suite, 38) + pad('失败', 12) + elapsed + 's');
      console.log(output.trimEnd().split('\n').map((l) => '      ' + l).join('\n'));
      failures.push(suite);
    }
  }

  console.log('\n' + '─'.repeat(60));
  if (failures.length > 0) {
    console.error('失败 ' + failures.length + '/' + suites.length + ' 套：' + failures.join(', '));
    process.exit(1);
  }
  console.log('全部通过：' + suites.length + ' 套套件 / ' + totalAssertions + ' 项断言 ✓');
}

main();
