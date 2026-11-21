'use strict';
/**
 * 中英双语界面（spec 023）回归测试。
 * 运行：node test/bilingual-ui.test.js
 *
 * 覆盖：
 *   AC-1  resolveLocale 全分支（zh 系 / 其它语言 / 未知 / 设置覆盖）
 *   AC-2  tr 选语、{name} 占位符、英文缺省回退（不静默）
 *   AC-3  buildIframeHtml 工具条与 <html lang> 双语
 *   AC-4  静态守卫：extension.js 与各插件 lib 源码无「裸中文字面量」
 *   AC-5  静态守卫：package.json 展示字段全为 %key%；两份 nls 键集一致且全覆盖
 *   AC-6  插件 reasonCode 机器码与宿主本地化（阶段 5 追加断言）
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

// 词法守卫实现在 test/lib/js-scan.js（测试与转换期进度统计共用）。
const { CJK_RE, findBareChinese, findMalformedTrCalls, findEagerLocaleEval, formatLiteralStatus } = require('./lib/js-scan.js');

function reportViolations(label, list) {
  for (const v of list.slice(0, 8)) {
    console.error('    · L' + v.line + '：' + v.text);
  }
  if (list.length > 8) console.error('    · …… 另有 ' + (list.length - 8) + ' 处');
  ok(false, label + '（' + list.length + ' 处违规，见上）');
}

// ═══════════════════════════════════════════════════════════════════
// vscode 桩：只实现本套件用到的 API
// ═══════════════════════════════════════════════════════════════════
const settings = {};
const infoMessages = [];
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (Object.prototype.hasOwnProperty.call(settings, k) ? settings[k] : d) }),
    workspaceFolders: []
  },
  env: { remoteName: undefined },
  window: {
    showWarningMessage: async () => undefined,
    showInformationMessage: async (m) => { infoMessages.push(String(m)); return undefined; }
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

// =====================================================================
console.log('[0] 守卫词法器自检（守卫本身也要有回归用例）');
{
  const count = (src) => findBareChinese(src).length;

  // 模板字面量：裸段与 ${} 表达式区要分开判（2026-11-20 修的缺陷：整段原文判中文会把
  // 「内联 tr」误判成违规，导致计数永远降不到 0）
  ok(count('const h = `<div>${tr(\'中文\', \'en\')}</div>`;') === 0,
    '模板内联 tr( 中文, 英文 ) → 不算违规');
  ok(count('const h = `<div>中文</div>`;') === 1, '模板裸段中文 → 算违规');
  ok(count('const h = `<div>${x + \'中文\'}</div>`;') === 1, '模板 ${} 里没包 tr 的中文 → 算违规');
  ok(count('const h = `<p>标题</p>${tr(\'正文\', \'body\')}`;') === 1,
    '裸段中文 + 内嵌 tr → 只算裸段那 1 处');
  ok(count('const s = tr(`多行\\n中文`, \'en\');') === 0, 'tr 第一参本身是模板 → 不算违规');
  ok(count('const s = \'<div aria-label="\' + tr(\'中文\', \'en\') + \'">\'\;') === 0,
    '字符串拼接里的 tr → 不算违规');
  ok(count('// 注释里的中文 用户： 助手：\nconst a = 1;') === 0, '注释里的中文 → 不算违规');
  ok(count('const a = \'用户：\';') === 0, '格式标记白名单（读回协议）→ 不算违规');
  ok(count('const a = \'\\n\\n【文件引用】\\n\';') === 0, '格式标记嵌在前后缀里 → 同样放行');
  ok(count('const a = \'这是裸中文\'; const b = tr(\'包好的\', \'ok\');') === 1,
    '同一文件里裸中文与 tr 并存 → 只算裸的那处');

  // tr 形态：必须两参、前两参为字面量、英文侧不能混中文
  ok(findMalformedTrCalls('tr(\'中文\', \'English\');').length === 0, '规范 tr 调用 → 无违规');
  ok(findMalformedTrCalls('tr(\'只有中文\');').length === 1, '缺英文字面量 → 违规');
  ok(findMalformedTrCalls('tr(\'中文\', someVar);').length === 1, '第二参不是字面量 → 违规');
  ok(findMalformedTrCalls('tr(DSH_ANSWER_MARKERS.zh, DSH_ANSWER_MARKERS.en);').length === 2,
    '成对常量直接进 tr（成员表达式）→ 违规（应改用 trPair）');
  ok(findMalformedTrCalls('trPair(DSH_ANSWER_MARKERS); tr(\'中文\', \'English\');').length === 0,
    'trPair(成对常量) → 不在 tr 形态检查范围内');
  ok(findMalformedTrCalls('tr(\'中文\', \'还带中文的 English\');').length === 1, '英文参数混中文 → 违规');
}

// =====================================================================
console.log('[1] 静态守卫：extension.js 无裸中文字面量（AC-4）');
{
  const src = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
  const bare = findBareChinese(src);
  if (bare.length > 0) reportViolations('extension.js 去注释后不得残留未包 tr() 的中文字面量', bare);
  ok(true, 'extension.js 无裸中文字面量');

  // 白名单防呆：格式标记必须真实存在（防有人删了读回标记却没改白名单）。
  const fmt = formatLiteralStatus(src);
  ok(fmt.missing.length === 0, '格式标记白名单条目均真实存在（缺：' + fmt.missing.join('、') + '）');

  const malformed = findMalformedTrCalls(src);
  if (malformed.length > 0) {
    for (const m of malformed.slice(0, 8)) console.error('    · ' + m);
    ok(false, 'tr 调用形态合法（' + malformed.length + ' 处）');
  }
  ok(true, 'tr 调用形态全部合法');

  // 顶层求值守卫：顶层 const 里的中文 / tr( 在 require 时就算好了，
  // 而语言要到 activate() 的 applyLocale() 才设置 → 英文环境会被锁死成中文。
  const eager = findEagerLocaleEval(src);
  if (eager.length > 0) {
    for (const e of eager.slice(0, 8)) console.error('    · L' + e.line + '：' + e.text);
    ok(false, '顶层不得有求值的中文 / tr（' + eager.length + ' 处，需改为使用点惰性求值）');
  }
  ok(true, '无顶层求值的中文 / tr（语言不被锁死在缺省值）');
}

// =====================================================================
console.log('[2] 静态守卫：dsh-plugins/*/lib/*.js 无裸中文字面量（AC-4）');
{
  const pluginRoot = path.join(ROOT, 'dsh-plugins');
  const dirs = fs.readdirSync(pluginRoot).sort();
  let checked = 0;
  for (const name of dirs) {
    for (const rel of ['lib/index.js', 'lib/client.js']) {
      const file = path.join(pluginRoot, name, rel);
      if (!fs.existsSync(file)) continue;
      checked += 1;
      const src = fs.readFileSync(file, 'utf8');
      const bare = findBareChinese(src);
      if (bare.length > 0) {
        for (const v of bare.slice(0, 5)) console.error('    · ' + name + '/' + rel + ' L' + v.line + '：' + v.text);
        ok(false, name + '/' + rel + ' 无裸中文字面量（' + bare.length + ' 处）');
      }
      const malformed = findMalformedTrCalls(src);
      if (malformed.length > 0) ok(false, name + '/' + rel + ' tr 形态合法（' + malformed.length + ' 处）');
    }
  }
  ok(checked >= 13, '插件源码已全部纳入扫描（' + checked + ' 个文件）');
}

// =====================================================================
console.log('[3] 静态守卫：package.json 与 nls 文件（AC-5）');
{
  const pkgRaw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw);
  const pkgChinese = [];
  (function walk(node, where) {
    if (typeof node === 'string') { if (CJK_RE.test(node)) pkgChinese.push(where + '：' + node.slice(0, 50)); return; }
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], where + '.' + k);
    }
  })(pkg, 'package.json');
  if (pkgChinese.length > 0) {
    for (const c of pkgChinese.slice(0, 8)) console.error('    · ' + c);
    ok(false, 'package.json 不得残留中文字面量（' + pkgChinese.length + ' 处）');
  }
  ok(true, 'package.json 无裸中文');

  const keys = Array.from(pkgRaw.matchAll(/%([A-Za-z][A-Za-z0-9._-]*)%/g), (m) => m[1]);
  ok(keys.length >= 40, 'package.json 使用了 %key% 占位（' + keys.length + ' 个）');

  const nlsPath = path.join(ROOT, 'package.nls.json');
  const nlsZhPath = path.join(ROOT, 'package.nls.zh.json');
  ok(fs.existsSync(nlsPath), 'package.nls.json 存在（英文，非 zh locale 兜底）');
  ok(fs.existsSync(nlsZhPath), 'package.nls.zh.json 存在（中文，zh-* 回退命中）');
  const en = JSON.parse(fs.readFileSync(nlsPath, 'utf8'));
  const zh = JSON.parse(fs.readFileSync(nlsZhPath, 'utf8'));

  const missingEn = keys.filter((k) => typeof en[k] !== 'string' || en[k] === '');
  const missingZh = keys.filter((k) => typeof zh[k] !== 'string' || zh[k] === '');
  if (missingEn.length) console.error('    · 英文缺键：' + missingEn.slice(0, 8).join(', '));
  if (missingZh.length) console.error('    · 中文缺键：' + missingZh.slice(0, 8).join(', '));
  ok(missingEn.length === 0 && missingZh.length === 0, '两份 nls 覆盖 package.json 的每一个 %key%');

  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();
  ok(enKeys.length === zhKeys.length && enKeys.every((k, i) => k === zhKeys[i]),
    '两份 nls 键集完全一致（' + enKeys.length + ' 个键）');
  ok(enKeys.length >= 40, 'nls 键数量合理（' + enKeys.length + '）');

  const enChinese = Object.keys(en).filter((k) => CJK_RE.test(String(en[k])));
  ok(enChinese.length === 0, 'package.nls.json 是纯英文（' + enChinese.length + ' 处中文）');

  const nested = Object.keys(zh).filter((k) => /%[A-Za-z][A-Za-z0-9._-]*%/.test(String(zh[k]))
    || /%[A-Za-z][A-Za-z0-9._-]*%/.test(String(en[k])));
  ok(nested.length === 0, 'nls 值内不残留 %key%（避免二次替换）');

  const locale = pkg.contributes.configuration.properties['dshPanel.locale'];
  ok(!!locale, '新增设置 dshPanel.locale');
  ok(locale && locale.default === 'auto', 'dshPanel.locale 默认 auto');
  ok(locale && JSON.stringify(locale.enum) === JSON.stringify(['auto', 'zh', 'en']), 'dshPanel.locale 枚举 auto|zh|en');
}

// =====================================================================
console.log('[4] resolveLocale 语言判定（AC-1）');
const i18n = require(path.join(ROOT, 'i18n.js'));
{
  const rl = i18n.resolveLocale;
  ok(rl('zh-cn', 'auto') === 'zh', 'zh-cn → zh');
  ok(rl('zh-tw', 'auto') === 'zh', 'zh-tw → zh');
  ok(rl('zh-Hans', 'auto') === 'zh', 'zh-Hans → zh');
  ok(rl('zh', 'auto') === 'zh', 'zh → zh');
  ok(rl('en', 'auto') === 'en', 'en → en');
  ok(rl('ja', 'auto') === 'en', 'ja → en（非中文一律英文）');
  ok(rl('de', 'auto') === 'en', 'de → en');
  ok(rl(undefined, 'auto') === 'zh', 'undefined → zh（测试桩缺省中文）');
  ok(rl('', 'auto') === 'zh', '空串 → zh');
  ok(rl('en', 'zh') === 'zh', '设置覆盖：zh 优先于 vscode.env.language');
  ok(rl('zh-cn', 'en') === 'en', '设置覆盖：en 优先于 vscode.env.language');
  ok(rl('en', 'bogus') === 'en', '非法设置值 → 回落按语言判定');
  ok(rl(undefined, 'bogus') === 'zh', '非法设置值 + 未知语言 → zh');
}

// =====================================================================
console.log('[5] tr 选语 / 占位符 / 回退（AC-2）');
{
  const tr = i18n.tr;
  i18n.setLocale('zh');
  ok(tr('中文文案', 'English copy') === '中文文案', 'zh 下选中文');
  ok(i18n.getLocale() === 'zh', 'getLocale 反映当前语言');
  i18n.setLocale('en');
  ok(tr('中文文案', 'English copy') === 'English copy', 'en 下选英文');
  ok(tr('失败 {n} 次', 'failed {n} times', { n: 3 }) === 'failed 3 times', 'en 下 {n} 占位替换');
  i18n.setLocale('zh');
  ok(tr('失败 {n} 次', 'failed {n} times', { n: 3 }) === '失败 3 次', 'zh 下 {n} 占位替换');
  ok(tr('缺 {a} 和 {b}', 'has {a} and {b}', { a: 'X' }) === '缺 X 和 {b}', '未提供的占位符原样保留');
  ok(tr('无插值', 'no vars') === '无插值', '无 vars 不做替换');

  // 英文缺省 → 回退中文 + console.warn（宪法第三条：不静默）
  const warns = [];
  const origWarn = console.warn;
  console.warn = (msg) => { warns.push(String(msg)); };
  try {
    i18n.setLocale('en');
    ok(tr('只有中文', '') === '只有中文', '英文缺省 → 回退中文（可见）');
    ok(tr('只有中文', '') === '只有中文', '重复调用仍回退');
    ok(warns.length === 1 && /\[DeepSeek Harness\]/.test(warns[0]), '缺英文只警告一次（带 [DeepSeek Harness] 前缀）');
    ok(tr('另一条', '') === '另一条', '不同文案各自警告一次');
    ok(warns.length === 2, '第二条文案也警告（' + warns.length + ' 次）');
  } finally {
    console.warn = origWarn;
    i18n.setLocale('zh');
  }
  ok(i18n.htmlLang() === 'zh-CN', 'zh → html lang=zh-CN');
  i18n.setLocale('en');
  ok(i18n.htmlLang() === 'en', 'en → html lang=en');
  i18n.setLocale('zh');
}

// =====================================================================
console.log('[6] 运行时双语：buildIframeHtml 工具条与 lang（AC-3）');
const I = require(path.join(ROOT, 'extension.js')).__internals;
{
  const DSH_ORIGIN = 'http://127.0.0.1:3080';
  const build = () => I.buildIframeHtml(DSH_ORIGIN, 1, 'revealAndOpen', { policy: 'auto', override: null }, undefined, false);

  i18n.setLocale('zh');
  const zh = build();
  ok(zh.includes('aria-label="隐藏 DSH 侧栏"'), 'zh：工具条按钮 aria-label 中文');
  ok(zh.includes('>隐藏侧栏<'), 'zh：工具条按钮文字中文');
  ok(zh.includes('<html lang="zh-CN">'), 'zh：html lang=zh-CN');

  i18n.setLocale('en');
  const en = build();
  ok(en.includes('aria-label="Hide DSH sidebar"'), 'en：工具条按钮 aria-label 英文');
  ok(en.includes('>Hide sidebar<'), 'en：工具条按钮文字英文');
  ok(en.includes('<html lang="en">'), 'en：html lang=en');
  // 只判「用户看得见的文本」：生成的中继脚本与 CSS 允许保留中文注释（不是界面文案），
  // 所以先剥掉 <script> / <style> 与 HTML 注释再扫中文。
  const visibleHtml = (html) => html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  ok(!CJK_RE.test(visibleHtml(en)), 'en：面板可见文本零中文（生成脚本的中文注释不算）');
  ok(CJK_RE.test(visibleHtml(zh)), 'zh：面板可见文本含中文（对照组，证明剥离没有把断言架空）');

  i18n.setLocale('zh');
  const back = build();
  ok(back.includes('aria-label="隐藏 DSH 侧栏"'), '切回 zh 恢复中文（热切换）');
}

// =====================================================================
console.log('[7] 产地标记跨语言读回（AC-9）');
{
  i18n.setLocale('en');
  const enMarker = I.dshAnswerMarker();
  ok(enMarker === '⏳ Submitted to DeepSeek Harness', 'en 下写入英文标记');
  const enMessage = enMarker + '（deepseek-flash）\n\n真正的回答正文';
  const zhMarkerAtEn = I.dshAnswerMarker();

  i18n.setLocale('zh');
  const hit = I.findDshAnswerMarker(enMessage);
  ok(hit !== null && hit.index === 0 && hit.length === enMarker.length,
    'zh 环境读回英文标记消息仍命中（切换语言不失配）');
  ok(enMessage.slice(hit.index + hit.length).indexOf('\n\n') >= 0, '占位前缀后的正文可定位（可剥前缀）');

  const zhMarker = I.dshAnswerMarker();
  ok(zhMarker === '⏳ 已提交给 DeepSeek Harness', 'zh 下写入中文标记');
  ok(zhMarkerAtEn === enMarker, 'en 下两次取值稳定');

  i18n.setLocale('en');
  const hitZh = I.findDshAnswerMarker(zhMarker + '（deepseek-flash）\n\n历史中文回答');
  ok(hitZh !== null && hitZh.index === 0, 'en 环境读回历史中文标记消息仍命中');
  ok(I.findDshAnswerMarker('没有标记的消息') === null, '无标记 → null');
  ok(I.findDshAnswerMarker(null) === null, '非字符串 → null（不抛）');

  const msg = { role: 'assistant', content: zhMarker + ' x' };
  ok(I.isDshProducedAnswer(msg) === true, 'zh 标记的 assistant 被识别为 DSH 产出');
  ok(I.isDshProducedAnswer({ role: 'assistant', content: enMarker + ' x' }) === true,
    'en 标记的 assistant 同样被识别（en 环境读 zh 历史消息）');
  ok(I.isDshProducedAnswer({ role: 'user', content: zhMarker }) === false, '非 assistant 角色不误判');
  ok(I.isDshProducedAnswer({ role: 'assistant', content: '普通回答' }) === false, '无标记不误判');

  i18n.setLocale('zh');
}

// =====================================================================
console.log('[8] 工作区跟随失败提示本地化（AC-6 宿主侧）');
{
  const txt = I.workspacePinResultText;

  i18n.setLocale('zh');
  ok(txt('unsupported') === '当前 dsh 版本不支持自动切换工作区，请在 DSH 侧栏手动选择工作区。',
    'zh：unsupported 文案与改造前逐字节一致');
  ok(txt('failed', 'DSH said no') === '自动切换到当前 VS Code 工作区失败：DSH said no。请在 DSH 侧栏手动选择工作区。',
    'zh：失败文案与改造前逐字节一致（含 reason）');
  ok(txt('failed', '') === '自动切换到当前 VS Code 工作区失败：未知原因。请在 DSH 侧栏手动选择工作区。',
    'zh：空 reason → 未知原因');
  ok(txt('failed', 'x', 'ready-timeout') === '自动切换到当前 VS Code 工作区失败：等待 DSH 工作区列表就绪超时。请在 DSH 侧栏手动选择工作区。',
    'zh：ready-timeout 本地化（与插件原文一致）');
  ok(txt('failed', 'x', 'unknown-error').indexOf('未知错误') > 0, 'zh：unknown-error 本地化');
  ok(txt('failed', 'x', 'contract-mismatch').indexOf('workspace/create 未返回 workspaceId') > 0,
    'zh：contract-mismatch 本地化');

  i18n.setLocale('en');
  ok(txt('unsupported').indexOf('DSH sidebar') > 0 && !CJK_RE.test(txt('unsupported')),
    'en：unsupported 英文且无中文');
  const enFailed = txt('failed', 'raw reason');
  ok(enFailed.indexOf('Failed to switch') === 0 && enFailed.indexOf('raw reason') > 0 && !CJK_RE.test(enFailed),
    'en：失败文案英文且透传 reason');
  ok(txt('failed', 'x', 'ready-timeout').indexOf('timed out waiting') > 0, 'en：ready-timeout 英文');
  ok(txt('failed', 'x', 'unknown-error').indexOf('unknown error') > 0, 'en：unknown-error 英文');
  ok(txt('failed', 'x', 'contract-mismatch').indexOf('did not return') > 0, 'en：contract-mismatch 英文');
  ok(!CJK_RE.test(txt('failed', '', 'ready-timeout')), 'en：未知/空 reason 也不出现中文');
  ok(txt('failed', 'DSH said no', 'not-a-known-code').indexOf('DSH said no') > 0,
    '未知 reasonCode → 原样透传 reason（旧插件回退）');
  ok(txt('failed', 'DSH said no').indexOf('DSH said no') > 0, '无 reasonCode → 原样透传 reason（旧插件回退）');

  i18n.setLocale('zh');
}

// =====================================================================
console.log('[9] 新增运行时文件随包分发（.vscodeignore 不得挡住）');
{
  // 仓库易错点：新增文件若被 .vscodeignore 挡掉，装出来的 vsix 里根本没有它，
  // 运行时 require 失败 → 扩展整体打不开。这里用简化 gitignore 语义做绊线，
  // 并用「必须被忽略」的正例证明匹配器不是恒 false。
  function globToRegExp(pattern) {
    let p = pattern.replace(/\\/g, '/');
    const anchored = p.charAt(0) === '/';
    if (anchored) p = p.slice(1);
    let body = '';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === '*') {
        if (p[i + 1] === '*') {
          body += '.*';
          i += 1;
          if (p[i + 1] === '/') { body += '/?'; i += 1; }
          continue;
        }
        body += '[^/]*';
        continue;
      }
      if (c === '?') { body += '[^/]'; continue; }
      if ('\\^$+.()|{}[]'.indexOf(c) >= 0) { body += '\\' + c; continue; }
      body += c;
    }
    const hasSlash = pattern.indexOf('/') >= 0;
    return new RegExp((anchored || hasSlash ? '^' : '(^|/)') + body + '$');
  }

  const patterns = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.charAt(0) !== '#');
  const isIgnored = (rel) => patterns.some((p) => globToRegExp(p).test(rel));

  // 正例：必须被忽略（证明匹配器有效）
  ok(isIgnored('test/bilingual-ui.test.js'), '匹配器有效：test/ 下的文件被忽略');
  ok(isIgnored('docs/TESTING.md'), '匹配器有效：docs/ 下的文件被忽略');
  ok(isIgnored('scripts/run-tests.js'), '匹配器有效：scripts/ 下的文件被忽略');

  // 新增运行时文件必须随包分发
  for (const rel of ['i18n.js', 'package.nls.json', 'package.nls.zh.json', 'extension.js']) {
    ok(!isIgnored(rel), rel + ' 不被 .vscodeignore 忽略（随 vsix 分发）');
  }
  ok(!isIgnored('dsh-plugins/dsh-vscode-workspace/lib/client.js'),
    'dsh-plugins/ 运行时读盘分发，不被忽略');
}

// =====================================================================
console.log('[10] 清单语言 ≠ 运行时语言时的一次性提示（AC-11）');
{
  // 命令菜单/设置说明来自清单、按 VS Code 显示语言解析；dshPanel.locale 只管运行时提示。
  // 两者被拧开会出现中英混排 → 扩展会提示一次并给出统一办法。
  const split = I.localeSplitWorthNotifying;
  ok(split('zh-cn', 'en') === true, '显示语言中文 + 强制 en → 提示（提示英文、菜单中文会混排）');
  ok(split('zh-tw', 'en') === true, 'zh-tw 同样算中文显示语言');
  ok(split('en', 'zh') === true, '显示语言英文 + 强制 zh → 反向混排也提示');
  ok(split('ja', 'zh') === true, '非中显示语言（清单回落英文）+ 强制 zh → 提示');
  ok(split('en', 'en') === false, '一致 → 不提示');
  ok(split('zh-cn', 'zh') === false, '一致 → 不提示');
  ok(split('zh-cn', 'auto') === false, 'auto 下运行时与清单同源 → 不提示');
  ok(split('ja', 'en') === false, '非中显示语言 + 强制 en（清单本就是英文）→ 不提示');
  ok(split(undefined, 'en') === false, '未知显示语言（测试桩缺 env.language）→ 不提示');
  ok(split('zh-cn', 'bogus') === false, '非法设置值按 auto → 不提示');

  // 一次性：同一会话内只弹一条；语言按当前 locale 输出。
  // 注意测试桩的 get(k) 是「分节内键名」——`getConfiguration('dshPanel').get('locale')` → k === 'locale'。
  infoMessages.length = 0;
  settings['locale'] = 'en';
  vscodeStub.env.language = 'zh-cn';
  I.applyLocale();
  ok(infoMessages.length === 1 && infoMessages[0].indexOf('dshPanel.locale=en') >= 0,
    '拧开时弹出一条提示（英文文案 + 指出 locale）');
  ok(!CJK_RE.test(infoMessages[0]), 'en 下提示为纯英文');
  I.applyLocale();
  ok(infoMessages.length === 1, '连调两次仍只有一条（每会话一次）');

  // 收尾恢复：清掉设置与显示语言，避免影响后续（本套件此后无断言）
  delete settings['locale'];
  vscodeStub.env.language = undefined;
  I.applyLocale();
  ok(i18n.getLocale() === 'zh', '恢复 auto + 未知显示语言 → 回到缺省 zh');
}

console.log('\n全部通过：' + passed + ' 项断言 ✓');
process.exit(0);
