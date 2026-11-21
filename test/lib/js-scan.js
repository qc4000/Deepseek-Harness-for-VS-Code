'use strict';
/**
 * 静态守卫用的极简 JS 词法器（spec 023）：找出「不是 tr( 第一参」的中文字面量，
 * 以及形态不合法的 tr( 调用。只做词法扫描，不执行代码；供 test/bilingual-ui.test.js
 * 与转换期进度统计（node -e）复用。测试目录不进 .vsix（.vscodeignore: test/**）。
 */
// ═══════════════════════════════════════════════════════════════════
// 极简 JS 词法器：只为静态守卫服务（不执行代码）
//  - 认得注释 / 字符串 / 模板字面量（含 ${} 递归）/ 正则（启发式）/ 标识符
//  - 目的：把「含中文的字符串或模板字面量」挑出来，检查它是不是 tr( 的第一参
// ═══════════════════════════════════════════════════════════════════

// 中日韩表意文字 + CJK 标点 + 全角形式（英文文案必须全半角规范，不许混入）
const CJK_RE = /[\u3000-\u303f\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function readSimpleString(src, i) {
  const quote = src[i];
  i += 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') break; // 未闭合字符串：换行即止（源码本身会语法错误，守卫不管）
    if (c === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** 从 `${` 的 `{` 处找配对 `}`（跳过字符串/模板/注释/嵌套花括号），返回 `}` 之后的下标。 */
function matchBrace(src, i) {
  i += 1;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\'' || c === '"') { i = readSimpleString(src, i); continue; }
    if (c === '`') { i = readTemplate(src, i).end; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      i = close < 0 ? src.length : close + 2;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  return i;
}

/** 从反引号读到配对反引号；返回结束下标与内部 `${}` 区域列表（供递归 tokenize）。 */
function readTemplate(src, i) {
  i += 1;
  const inner = [];
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return { end: i + 1, inner };
    if (c === '$' && src[i + 1] === '{') {
      const start = i + 2;
      const close = matchBrace(src, i + 1);
      inner.push([start, Math.max(start, close - 1)]);
      i = close;
      continue;
    }
    i += 1;
  }
  return { end: src.length, inner };
}

function readRegex(src, i, end) {
  i += 1;
  let inClass = false;
  while (i < end) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') break;
    if (inClass) { if (c === ']') inClass = false; i += 1; continue; }
    if (c === '[') { inClass = true; i += 1; continue; }
    if (c === '/') return i + 1;
    i += 1;
  }
  return i;
}

const REGEX_KEYWORDS = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw'];

/** 上一个「有效 token」是否允许后面跟正则字面量（除号一律不满足 → 不会吞代码）。 */
function regexAllowedAfter(toks) {
  let prev = null;
  for (let j = toks.length - 1; j >= 0; j--) {
    if (toks[j].type !== 'comment') { prev = toks[j]; break; }
  }
  if (!prev) return true;
  if (prev.type === 'punct') return '(,=:[!&|?{};+-*%~^<>'.indexOf(prev.value) >= 0;
  if (prev.type === 'ident') return REGEX_KEYWORDS.indexOf(prev.value) >= 0;
  return false;
}

function tokenize(src, from, to) {
  const start = from === undefined ? 0 : from;
  const end = to === undefined ? src.length : to;
  const toks = [];
  let i = start;
  while (i < end) {
    const c = src[i];
    if (c === '\n' || c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const s = i;
      while (i < end && src[i] !== '\n') i += 1;
      toks.push({ type: 'comment', start: s, end: i });
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const s = i;
      const close = src.indexOf('*/', i + 2);
      i = close < 0 || close >= end ? end : close + 2;
      toks.push({ type: 'comment', start: s, end: i });
      continue;
    }
    if (c === '\'' || c === '"') {
      const s = i;
      i = readSimpleString(src, i);
      toks.push({ type: 'string', start: s, end: Math.min(i, end) });
      continue;
    }
    if (c === '`') {
      const s = i;
      const t = readTemplate(src, i);
      const tEnd = Math.min(t.end, end);
      toks.push({ type: 'template', start: s, end: tEnd });
      for (const region of t.inner) {
        if (region[0] >= end) break;
        const sub = tokenize(src, region[0], Math.min(region[1], end));
        for (const st of sub) toks.push(st);
      }
      i = tEnd;
      continue;
    }
    if (c === '/') {
      if (regexAllowedAfter(toks)) {
        const s = i;
        i = readRegex(src, i, end);
        toks.push({ type: 'regex', start: s, end: Math.min(i, end) });
        continue;
      }
      toks.push({ type: 'punct', value: '/', start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const s = i;
      while (i < end && /[A-Za-z0-9_$]/.test(src[i])) i += 1;
      toks.push({ type: 'ident', value: src.slice(s, i), start: s, end: i });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const s = i;
      while (i < end && /[0-9a-fA-FxXoObBeE._]/.test(src[i])) i += 1;
      toks.push({ type: 'number', start: s, end: i });
      continue;
    }
    // 箭头整体认成一个 token：`=>` 是「后面是惰性函数体/表达式」的信号（顶层求值判定用）
    if (c === '=' && src[i + 1] === '>') {
      toks.push({ type: 'punct', value: '=>', start: i, end: i + 2 });
      i += 2;
      continue;
    }
    toks.push({ type: 'punct', value: c, start: i, end: i + 1 });
    i += 1;
  }
  return toks;
}

function prevCodeToken(toks, k) {
  for (let j = k - 1; j >= 0; j--) if (toks[j].type !== 'comment') return toks[j];
  return null;
}

function lineAt(lineIndex, pos) {
  let lo = 0;
  let hi = lineIndex.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineIndex[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

function buildLineIndex(src) {
  const idx = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') idx.push(i + 1);
  return idx;
}

/**
 * 生成物（HTML/中继脚本）是「裸模板」：里面的中文注释不算文案。
 * 只剥掉 // 与 /* *\/ 两段后再判中文——尽力而为，够当回归绊线。
 */
function stripGeneratedComments(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const k = line.indexOf('//');
      return k >= 0 ? line.slice(0, k) : line;
    })
    .join('\n');
}

/**
 * 找出「含中文但不是 tr( 第一参」的字符串/模板字面量。
 * @param {string} src
 * @returns {{line:number, text:string}[]}
 */
/**
 * 序列化格式标记白名单（spec 023 非目标）。
 * 这些中文字面量是扩展 ↔ Copilot/DSH 之间的**读回匹配协议**：写进转录后还要
 * `startsWith` / `indexOf` 读回来（`用户：` 5 处、`【文件引用】` 3 处……）。
 * 翻译它们会让「切换语言 / 旧消息」直接失配——那是 Copilot 桥接「已提交但无回答」
 * 级别的故障，所以按数据格式处理：语言稳定、不双语。
 * 守卫只放行这一个集合：集合外的中文必须包 tr(；集合内的必须真实存在（防死条目）。
 */
const FORMAT_LITERALS = new Set([
  '用户：',
  '助手：',
  '【文件引用】',
  '【Copilot 记忆】',
  '【Copilot 其他模型回答】'
]);

/** 内容里含任一格式标记即视为格式字面量（标记可能嵌在前后缀里，如 '\n\n【文件引用】\n'）。 */
function isFormatLiteral(raw) {
  const content = literalContent(raw);
  for (const s of FORMAT_LITERALS) if (content.indexOf(s) >= 0) return true;
  return false;
}

/** 去掉字符串字面量的引号，取内容（用于白名单比对）。 */
function literalContent(raw) {
  if (raw.length >= 2 && (raw[0] === '\'' || raw[0] === '"') && raw[raw.length - 1] === raw[0]) {
    return raw.slice(1, -1);
  }
  return raw;
}

function findBareChinese(src) {
  const toks = tokenize(src);
  const lineIndex = buildLineIndex(src);
  const out = [];
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.type !== 'string' && tk.type !== 'template') continue;
    let text = src.slice(tk.start, tk.end);
    if (tk.type === 'template') {
      // 模板里的 ${...} 是**代码**（由嵌套 token 单独判定）：整段模板原文里会带着
      // 内嵌的 tr('中文', …)，不挖掉就会把「已经包好 tr 的内联写法」误判成违规。
      // 只保留模板的裸文本段来判中文——裸段里的中文才是真的没包 tr。
      const regions = readTemplate(src, tk.start).inner;
      const base = tk.start;
      for (let r = regions.length - 1; r >= 0; r--) {
        const from = Math.max(0, regions[r][0] - 2 - base); // `${`
        const to = Math.min(text.length, regions[r][1] + 1 - base); // `}`
        if (to > from) text = text.slice(0, from) + ' '.repeat(to - from) + text.slice(to);
      }
      text = stripGeneratedComments(text);
    }
    if (!CJK_RE.test(text)) continue;
    if (isFormatLiteral(src.slice(tk.start, tk.end))) continue;
    const p1 = prevCodeToken(toks, k);
    const p2 = p1 ? prevCodeToken(toks, toks.indexOf(p1)) : null;
    const isTrFirstArg = !!(p1 && p1.type === 'punct' && p1.value === '('
      && p2 && p2.type === 'ident' && p2.value === 'tr');
    if (isTrFirstArg) continue;
    out.push({
      line: lineAt(lineIndex, tk.start),
      text: text.replace(/\s+/g, ' ').slice(0, 70)
    });
  }
  return out;
}

/**
 * 白名单条目在源码里的存在情况：缺哪个、多了哪些裸中文，交给测试断言。
 * @param {string} src
 * @returns {{missing:string[], present:string[]}}
 */
function formatLiteralStatus(src) {
  const toks = tokenize(src);
  const found = new Set();
  for (const tk of toks) {
    if (tk.type !== 'string') continue;
    const content = literalContent(src.slice(tk.start, tk.end));
    for (const s of FORMAT_LITERALS) if (content.indexOf(s) >= 0) found.add(s);
  }
  return {
    missing: Array.from(FORMAT_LITERALS).filter((s) => !found.has(s)),
    present: Array.from(found)
  };
}

/**
 * 每个 tr( 调用必须是 tr(中文字面量, 英文字面量[, vars]) 形态。
 * @param {string} src
 * @returns {string[]} 违规描述
 */
function findMalformedTrCalls(src) {
  const toks = tokenize(src);
  const lineIndex = buildLineIndex(src);
  const out = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].type !== 'ident' || toks[k].value !== 'tr') continue;
    const open = toks[k + 1];
    if (!open || open.type !== 'punct' || open.value !== '(') continue;
    // 收集顶层实参（按括号/花括号深度切分）
    const args = [];
    let depth = 1;
    let cur = null;
    for (let j = k + 2; j < toks.length; j++) {
      const t = toks[j];
      const isSep = t.type === 'punct' && (t.value === '(' || t.value === ')' || t.value === '[' || t.value === ']' || t.value === '{' || t.value === '}');
      if (isSep) {
        if (t.value === '(' || t.value === '[' || t.value === '{') depth += 1;
        else if (t.value === ')') { depth -= 1; if (depth === 0) break; }
        else depth -= 1;
      }
      if (depth === 1 && t.type === 'punct' && t.value === ',') { args.push(cur); cur = null; continue; }
      if (depth === 1 && cur === null) cur = t;
    }
    if (cur) args.push(cur);
    const line = lineAt(lineIndex, toks[k].start);
    if (args.length < 2) { out.push('L' + line + '：tr( 实参不足 2 个（缺英文字面量）'); continue; }
    if (args[0].type !== 'string' && args[0].type !== 'template') out.push('L' + line + '：tr 第一参不是字符串/模板字面量');
    if (args[1].type !== 'string' && args[1].type !== 'template') out.push('L' + line + '：tr 第二参不是字符串/模板字面量');
    const en = src.slice(args[1].start, args[1].end);
    if (CJK_RE.test(en)) out.push('L' + line + '：tr 英文参数里混入中文');
  }
  return out;
}


/**
 * 找「模块顶层求值」的中文 / tr( 调用。
 *
 * 为什么这是 bug：`tr` / `trPair` 读的是**当前**语言，而语言要到 `activate()` 里
 * `applyLocale()` 才设置——顶层 `const X = ['中文']` 或 `const X = tr('中文','en')`
 * 在 require 时就求值，英文环境会被永久锁死成中文。
 * 判定：顶层 `const/let/var` 语句里出现中文字面量或 `tr(`/`trPair(` 调用；
 * 语句里已出现 `function` / `=>` 的（值是惰性函数体）放过——那种在调用时才求值。
 *
 * @param {string} src
 * @returns {{line:number, text:string}[]}
 */
function findEagerLocaleEval(src) {
  const toks = tokenize(src);
  const lineIndex = buildLineIndex(src);
  const out = [];
  const stack = [];
  let stmtStart = -1;
  let sawFunction = false;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === 'punct') {
      if (t.value === '(' || t.value === '[' || t.value === '{') stack.push(t.value);
      else if (t.value === ')' || t.value === ']' || t.value === '}') stack.pop();
      else if (t.value === ';' && stack.length === 0) { stmtStart = -1; sawFunction = false; }
      // 箭头是 punct，得在这里认：`=> …` 之后是惰性求值（函数体或表达式体）
      else if (t.value === '=>' && stmtStart >= 0) sawFunction = true;
      continue;
    }
    if (stack.length === 0 && t.type === 'ident'
      && (t.value === 'const' || t.value === 'let' || t.value === 'var') && stmtStart < 0) {
      stmtStart = k;
      sawFunction = false;
      continue;
    }
    if (stmtStart < 0) continue;
    if (t.type === 'ident' && (t.value === 'function' || t.value === '=>')) sawFunction = true;
    if (sawFunction) continue;
    const isTrCall = t.type === 'ident' && (t.value === 'tr' || t.value === 'trPair')
      && toks[k + 1] && toks[k + 1].type === 'punct' && toks[k + 1].value === '(';
    const isCjkLiteral = (t.type === 'string' || t.type === 'template')
      && CJK_RE.test(src.slice(t.start, t.end))
      && !isFormatLiteral(src.slice(t.start, t.end));
    if (isTrCall || isCjkLiteral) {
      out.push({
        line: lineAt(lineIndex, t.start),
        text: (isTrCall ? t.value + '( …' : src.slice(t.start, t.end)).replace(/\s+/g, ' ').slice(0, 70)
      });
      stmtStart = -1; // 一条语句只报一次，避免刷屏
      sawFunction = false;
    }
  }
  return out;
}

module.exports = { CJK_RE, FORMAT_LITERALS, findBareChinese, findMalformedTrCalls, findEagerLocaleEval, formatLiteralStatus, stripGeneratedComments, tokenize };
