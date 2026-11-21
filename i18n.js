'use strict';
/**
 * 中英双语文案（spec 023）。
 *
 * 为什么自研而不用 @vscode/l10n：宪法第二条「零依赖零构建」——不加依赖、不加编译步骤。
 * 为什么文案写在调用点（tr(中文, English, vars)）而不用键表：中文是源文本、英文并列贴身，
 * 改一处只动一处，翻译不会与源码错位；也不需要维护几百个键的同步。
 *
 * 语言判定：dshPanel.locale（zh|en 覆盖）> vscode.env.language（zh* → 中文，其它 → 英文）>
 * 未知（测试桩没有 env.language）→ 中文（仓库文案以中文为源）。
 */

/** 缺省语言：未知环境按中文处理（既有中文断言依赖这一点）。 */
const DEFAULT_LOCALE = 'zh';

/** 当前语言（'zh' | 'en'）。 */
let current = DEFAULT_LOCALE;

/** 已经警告过的缺失英文文案（每个文案只警告一次，避免刷屏）。 */
const warnedKeys = new Set();

/**
 * 解析显示语言。
 * @param {string} [vscodeLanguage] `vscode.env.language`（如 'zh-cn' / 'en' / 'ja'）
 * @param {string} [setting] `dshPanel.locale`（'auto' | 'zh' | 'en'，其它值按 auto）
 * @returns {'zh'|'en'}
 */
function resolveLocale(vscodeLanguage, setting) {
  if (setting === 'zh' || setting === 'en') return setting;
  if (typeof vscodeLanguage === 'string' && vscodeLanguage !== '') {
    return vscodeLanguage.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }
  return DEFAULT_LOCALE;
}

/**
 * 设置当前语言（非法值收敛为中文）。
 * @param {'zh'|'en'} locale
 */
function setLocale(locale) {
  current = locale === 'en' ? 'en' : 'zh';
}

/** @returns {'zh'|'en'} 当前语言。 */
function getLocale() {
  return current;
}

/**
 * 取双语文案：按当前语言二选一，再做 {name} 占位替换。
 * 中文参数必须与改造前原文逐字节一致（既有中文断言靠它保持绿）。
 * 英文缺省时回退中文并警告一次（宪法第三条：不静默降级）。
 *
 * @param {string} zh 中文文案（源文本）
 * @param {string} [en] 英文文案
 * @param {Record<string, any>} [vars] 占位替换的变量表（只替换提供的键）
 * @returns {string}
 */
function tr(zh, en, vars) {
  const zhText = typeof zh === 'string' ? zh : String(zh);
  let text = zhText;
  if (current === 'en') {
    if (typeof en === 'string' && en !== '') {
      text = en;
    } else if (!warnedKeys.has(zhText)) {
      warnedKeys.add(zhText);
      console.warn('[DeepSeek Harness] 缺少英文文案，已回退中文：' + zhText.slice(0, 60));
    }
  }
  if (vars !== null && typeof vars === 'object') {
    text = text.replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
    });
  }
  return text;
}

/**
 * 生成 HTML 的 lang 属性值（DSH 页面外层文档的语言标注，不是 DSH 自身文案）。
 * @returns {'zh-CN'|'en'}
 */
function htmlLang() {
  return current === 'zh' ? 'zh-CN' : 'en';
}

/**
 * 跨语言读回的双语常量：**写入按当前语言、读取必须两种语言都认**。
 * 典型是 Copilot 转录里的「⏳ 已提交给 DeepSeek Harness」产地标记——
 * 写进去之后还要在下一轮 `indexOf` 读回来（剥前缀 / 判定 DSH 产出），
 * 切换语言或读历史消息时只认一种语言会直接失配。
 * 放在 i18n.js 而不是 extension.js：静态守卫只放行 tr( 第一参里的中文，
 * 这种「成对常量」必须集中托管（守卫不扫本文件）。
 */
const DSH_ANSWER_MARKERS = Object.freeze({
  zh: '⏳ 已提交给 DeepSeek Harness',
  en: '⏳ Submitted to DeepSeek Harness'
});

/**
 * 取成对双语文案里「当前语言」的那一条。
 * 用于 `DSH_ANSWER_MARKERS` 这类**成对常量**：常量本身不依赖语言（可模块顶层求值），
 * 显示时才按当前语言挑一条。语义上就是 tr(zh, en)，只是实参是成员表达式而不是字面量
 * （静态守卫只放行字面量形态的 tr(，成对常量走这里）。
 * @param {{zh: string, en: string}} pair
 * @returns {string}
 */
function trPair(pair) {
  return current === 'en' ? pair.en : pair.zh;
}

module.exports = {
  tr,
  trPair,
  setLocale,
  getLocale,
  resolveLocale,
  htmlLang,
  DSH_ANSWER_MARKERS,
  __internals: { DEFAULT_LOCALE, warnedKeys }
};
