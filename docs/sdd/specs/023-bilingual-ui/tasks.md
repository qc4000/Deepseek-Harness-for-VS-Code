# 任务清单 023：中英双语界面

> 顺序即依赖：`[test]` 先红 → `[impl]` 变绿 → 分批转换 → 文档。
> 全程 `TMPDIR=/tmp npm test`（或 `npm run test:one -- <子串>`）验证。
> 进度统计（转换期随时可跑）：
> `node -e "const {findBareChinese}=require('./test/lib/js-scan.js');const fs=require('fs');console.log(findBareChinese(fs.readFileSync('extension.js','utf8')).length)"`

## 阶段 1 · 骨架（先红后绿）

- [x] `[test]` 新增 `test/bilingual-ui.test.js`：`resolveLocale` 全分支（AC-1）、
      `tr` 选语/占位符/缺英文回退（AC-2）→ **红**（`i18n.js` 不存在）
- [x] `[impl]` 新增 `i18n.js`：`tr`/`trPair`/`setLocale`/`getLocale`/`resolveLocale`/`htmlLang` +
      跨语言成对常量 `DSH_ANSWER_MARKERS` + `__internals`
- [x] `[impl]` 词法守卫抽成共享模块 `test/lib/js-scan.js`（测试与转换期进度统计共用）
- [x] `[impl]` `extension.js` 接线：顶部 `require('./i18n')`、`applyLocale()` 在 `activate` 调用、
      `onDidChangeConfiguration(LOCALE_KEY)` 重算（AC-7）、导出到 `__internals`
- [x] `[impl]` `package.json` 新增 `dshPanel.locale`（`auto|zh|en`，默认 `auto`，描述走 `%key%`）
- [x] `[impl]` 产地标记改「写入按当前语言、读取中英都认」：`findDshAnswerMarker()`（AC-9）
- [x] `[impl]` `scripts/run-tests.js` 语法检查纳入 `i18n.js`

## 阶段 2 · 静态守卫（先红）

- [x] `[test]` 静态守卫：`extension.js` 去注释后无裸中文字面量（AC-4）→ **红（376 处起）**
- [x] `[test]` 静态守卫：`tr` 调用形态（≥2 参、前两参为字面量、英文参无中文）
- [x] `[test]` 静态守卫：`package.json` 展示字段全为 `%key%`、`package.nls.json` 与
      `package.nls.zh.json` 键集一致且覆盖全部 `%key%`（AC-5）→ **红**
- [x] `[test]` 静态守卫：`dsh-plugins/*/lib/*.js` 无裸中文字面量 → **红（3 处）**
- [x] `[test]` 格式标记白名单 `FORMAT_LITERALS`（`用户：` 等 5 条读回协议）+ 防死条目断言
- [x] `[test]` **守卫自检 [0]**（守卫本身也要回归用例）：模板裸段 vs `${}` 分开判、白名单、tr 形态 16 条
- [x] `[test]` **顶层求值守卫** `findEagerLocaleEval`（顶层 const 求值会把语言锁死）→ 红 2 处

## 阶段 3 · 运行时文案转换（分批，每批一绿）

- [x] `[impl]` 批次 1（67 处）：安装/启动/认证引导、四个生成页模板（工具条 const 提升、
      `<html lang="${htmlLang()}">` ×4、生成脚本用 `jsonForScript`）、外链与 focusDshInput
- [x] `[impl]` 批次 2（109 处）：快捷键转发配置/状态 Markdown、诊断、工作区跟随等
      （子代理在收尾汇报前失败，但主体完成且全量 24/25 绿 → 判定有效交付）
- [x] `[impl]` 批次 3（95 处）：调试日志、诊断输出面板、webview 消息、插件/面板准备、
      RPC 会话解析、会话回写、模型漂移告警、提供方注册
- [x] `[impl]` 批次 4（52 处）：`diagnoseModels`/`showChatStatus`/`authStatusText`/激活与命令收尾
- [x] `[impl]` 两处**顶层求值**改惰性：`SYNTHETIC_PROGRESS_TEXTS` → `syntheticProgressTexts()`、
      `DSH_MODEL_DEFS` → `buildDshModelDefs()`（同步 7 处测试引用 + `ARCHITECTURE.md` 两处表述）
- 每批完成即跑：`node --check extension.js` + 违规计数下降 + 相关套件绿

## 阶段 4 · 清单 nls

- [x] `[test]` 守卫用例先写（阶段 2 已红）
- [x] `[impl]` 55 处展示字段 → `%key%`；`package.nls.json`（英）+ `package.nls.zh.json`（中）
      共 **59 键**，两份键集一致、覆盖全部占位、en 纯英文
- [x] `[impl]` `key-bridge` / `external-link-open` 两处断言改走 `resolveManifestText()`（意图不变）

## 阶段 5 · 插件 reason 机器码

- [x] `[test]` `test/workspace-pin.test.js` 客户端侧 `reasonCode` 断言（AC-6 前半）
- [x] `[impl]` `dsh-vscode-workspace/lib/client.js`：3 条 reason 改英文短文本 + `reasonCode`
      （`ready-timeout` / `unknown-error` / `contract-mismatch`；DSH 自有错误透传不带码）
- [x] `[test]` 宿主侧：中继白名单转发 `reasonCode`（4 条红灯断言）+ `bilingual-ui` [8] 本地化 14 条
- [x] `[impl]` `extension.js`：中继按 `/^[a-z][a-z0-9-]{0,31}$/` 放行、
      `workspacePinResultText`/`workspacePinReasonText` 按码本地化、缺失透传 → 变绿
- [x] `[impl]` 插件 `package.json` + client `PLUGIN_VERSION` **bump 0.1.0 → 0.2.0**（维护者已确认；
      版本不 bump 则已安装用户拿不到新插件）+ 版本一致性断言
- [x] `[test]`+`[impl]` **AC-11**：清单语言 ≠ 运行时语言（如显示语言中文 + `dshPanel.locale=en`）时
      弹**一条**提示说明原因与统一办法——纯函数 `localeSplitWorthNotifying` 全分支 + 一次性 + 恢复缺省；
      `package.nls*` 的 `cfg.dshPanel.locale.desc` 与 README 同步点破该机制差异
      （测试坑：桩的 `get(k)` 是分节内键名，要写 `settings['locale']` 而非 `'dshPanel.locale'`）

## 阶段 6 · 验证与文档

- [x] `[test]` `TMPDIR=/tmp npm test` 全绿：**25 套 / 1494 项断言**
- [x] `[test]` `npm run test:all`（真实 dsh 0.2.2-rc.1 e2e）：**26 套 / 1494 项断言**
      （本会话 `HOME` 只读，需 `DSH_HOME=/tmp/… HOME=/tmp/…` 才能跑）
- [x] `[docs]` `docs/TESTING.md` 测试地图补 `bilingual-ui.test.js`（117 断言）+ `workspace-pin` 74→98
- [x] `[docs]` `AGENTS.md` / `docs/TESTING.md` / `README.md` 命令说明改 25 套 / 1480 断言
- [x] `[docs]` `AGENTS.md` §4 与 `docs/CONVENTIONS.md` 改为「用户文案中英双语」约定
- [x] `[docs]` README 补 `dshPanel.locale` 表行 + 双语说明段；CHANGELOG 待发 1.1.3 下新增小节
- [x] `[docs]` spec 023 置 `implemented`，验证记录补全（含 AC→断言映射）
- [ ] `[release]`（**需维护者确认**，当前决定：先不发版）扩展版本号 + CHANGELOG 定稿 + tag —— 不自动执行
