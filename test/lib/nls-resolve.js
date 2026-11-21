'use strict';
/** 在测试里模拟 VS Code 的清单 nls 解析：把 %key% 换成指定语言的译文。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CACHE = { en: null, zh: null };

/** 按语言读取 nls 字典：'zh' → package.nls.zh.json，其它 → package.nls.json（devMode 兜底）。 */
function loadDict(locale) {
  const which = locale === 'zh' ? 'zh' : 'en';
  if (!CACHE[which]) {
    const file = which === 'zh' ? 'package.nls.zh.json' : 'package.nls.json';
    CACHE[which] = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  }
  return CACHE[which];
}

/**
 * 把清单原文里的 %key% 替换为指定语言的译文（VS Code 加载期行为的测试替身）。
 * @param {string} raw 清单里的原始字符串（可能含 %key%）
 * @param {string} [locale] 'zh' 走中文表，其它走英文表
 * @returns {string} 解析后的文案；非 %key% 内容原样返回
 */
function resolveManifestText(raw, locale) {
  if (typeof raw !== 'string') return raw;
  const dict = loadDict(locale);
  return raw.replace(/%([A-Za-z][A-Za-z0-9._-]*)%/g, (m, key) => (
    Object.prototype.hasOwnProperty.call(dict, key) && typeof dict[key] === 'string' ? dict[key] : m
  ));
}

module.exports = { resolveManifestText };
