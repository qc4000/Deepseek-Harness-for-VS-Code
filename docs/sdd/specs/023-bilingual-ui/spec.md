# 规格 023：中英双语界面（zh/en 按环境切换）

| 项 | 内容 |
| --- | --- |
| 编号 | 023 |
| 状态 | implemented |
| 负责人 | @Vithrive |
| 关联 | [宪法](../../CONSTITUTION.md) 第二/三条 · [spec 006（工作区跟随）](../006-dsh-workspace-pin/spec.md)（插件 reason 双语化） |
| 创建 / 更新 | 2026-11-20 / 2026-11-20 |

## 1. 背景与问题

扩展的全部用户可见文案目前只有中文：`extension.js` 去注释后约 350 条中文字面量
（通知、状态栏、webview 工具条 `aria-label`/`title`、错误页、QuickPick、输出面板提示），
`package.json` 有 45 处展示字段（13 个命令标题 + 31 个设置项的描述/枚举说明 + 扩展描述），
`dsh-vscode-workspace` 插件有 3 条上报给宿主的 reason 文本。

在 VS Code 显示语言为英文（`en`/`ja`/`de`…）的环境里，用户看到的仍是中文提示，
无法理解「下一步该做什么」；反过来，中文用户在英文环境里也拿不到中文。
本规格让**扩展自己的界面文案**按环境双语：**中文环境显示中文，其它环境显示英文**。

## 2. 目标

- 运行时文案（通知 / 状态栏 / 工具条 / 错误页 / QuickPick / 输出面板）按语言二选一：
  `vscode.env.language` 以 `zh` 开头 → 中文，其它 → 英文。
- 清单文案（命令标题、设置项描述与枚举说明、扩展描述）按 VS Code 显示语言双语，
  走 VS Code 原生 manifest nls（`%key%` + `package.nls.json` / `package.nls.zh.json`）。
- 新增设置 `dshPanel.locale`（`auto|zh|en`，默认 `auto`）可强制单语，`auto` 跟随 VS Code。
- `dsh-vscode-workspace` 插件上报的失败原因带稳定机器码 `reasonCode`，显示文案由宿主本地化；
  旧插件（无 `reasonCode`）原样透传，不丢提示。
- 中文路径必须**逐字节保持现状**（既有断言中文的测试全绿）。

## 3. 非目标

- 不改 DSH 页面（Web GUI）自身的语言与文案——红线一：不向 DSH 页面注入脚本/改 DOM。
- 不做 zh/en 之外的第三种语言；不做文档（README/CHANGELOG/docs）双语。
- 不引入 `@vscode/l10n`、不加任何依赖（红线二：零依赖零构建）。
- 不改 DSH 协议既有字段语义；`reasonCode` 是**新增可选**字段。
- 不翻译配置项的**取值**（`auto`/`show`/`revealAndOpen` 等持久化值恒为英文）。
- **不翻译序列化格式标记**（`用户：`、`助手：`、`【文件引用】`、`【Copilot 记忆】`、
  `【Copilot 其他模型回答】`）：它们是扩展 ↔ Copilot/DSH 之间写入后还要读回的匹配协议
  （`startsWith`/`indexOf` 共 8 处），语言失配会直接打断 Copilot 桥接——按数据格式处理，
  由守卫白名单（`FORMAT_LITERALS`）固定，见 `test/lib/js-scan.js`。
  唯一例外是**用户可见的 ⏳ 产地标记**：写入按当前语言、读取两种语言都认（AC-9）。

## 4. 用户故事

- 作为 **VS Code 用户**（英文界面），我希望提示与设置说明是英文，以便知道失败原因和下一步动作。
- 作为 **VS Code 用户**（中文界面），我希望文案与现在完全一致，以便不产生回归。
- 作为 **维护者**，我希望有一条静态守卫测试挡住「新代码又写了裸中文」，以便双语不随时间腐烂。

## 5. 验收标准（必须可执行）

- **AC-1（语言判定）**：`resolveLocale(lang, setting)` 满足
  `('zh-cn'|'zh-tw'|'zh-Hans'|'zh')→'zh'`；`('en'|'ja'|'de')→'en'`；
  `undefined/''→'zh'`（测试环境缺省中文）；`setting='zh'|'en'` 优先于 `lang`；
  `setting='auto'/非法值` 回落到按 `lang` 判定。
- **AC-2（tr 选语与占位符）**：`setLocale('zh')` 后 `tr('中文', 'English')==='中文'`（逐字节）；
  `setLocale('en')` 后返回 `'English'`；`tr('失败 {n} 次', 'failed {n} times', {n:3})` 替换 `{n}`；
  未提供的占位符原样保留；英文缺省（空串）时回退中文并 `console.warn` 一次（不静默）。
- **AC-3（运行时双语）**：Given `setLocale('en')`，When `buildIframeHtml(...)`，
  Then 工具条 `aria-label` 为英文（`Hide DSH sidebar` / `Show DSH sidebar`）；
  Given `setLocale('zh')`，Then 与现状逐字节一致（`隐藏 DSH 侧栏`）。
- **AC-4（静态守卫·运行时）**：`extension.js` 去掉注释后，**不存在**未被 `tr(` 包裹的中文字面量；
  `dsh-plugins/*/lib/*.js` 同理（注释里的中文不受限）。
- **AC-5（清单双语）**：`package.json` 所有用户可见字段为 `%key%` 形式、无裸中文；
  `package.nls.json`（英文）与 `package.nls.zh.json`（中文）键集完全一致，
  且覆盖 `package.json` 里出现的每一个 `%key%`；两文件均无嵌套 `%…%` 残留。
- **AC-6（插件 reason 双语）**：Given 插件上报 `{status:'failed', reason:'…', reasonCode:'ready-timeout'}`，
  When 宿主在 `setLocale('en')` 下处理，Then 状态栏提示为英文且含下一步动作；
  `setLocale('zh')` 下为中文；Given 旧插件只带 `reason`（无 `reasonCode`），
  Then 原样透传该 `reason`（回退路径，提示仍可见）。
- **AC-7（热切换）**：Given `dshPanel.locale` 从 `auto` 改为 `en`，When 配置变更事件触发，
  Then 后续提示按英文；改回 `auto` 后按 `vscode.env.language`。
- **AC-8（不注入）**：双语实现只改扩展宿主侧与清单；DSH 页面 DOM/脚本零改动
  （既有「不碰 DOM」静态断言仍绿）。
- **AC-9（产地标记跨语言读回）**：Given `setLocale('en')` 时向转录写入
  `⏳ Submitted to DeepSeek Harness（…）`，When 在 `setLocale('zh')` 下再序列化/判定该消息，
  Then 仍能剥掉占位前缀并识别为 DSH 产出（中文标记同理反向成立；历史中文消息在英文环境下不失配）。
- **AC-10（新文件随包分发）**：Given 新增运行时文件 `i18n.js`、`package.nls.json`、`package.nls.zh.json`，
  When 按 `.vscodeignore` 判定这些路径，Then 三者与 `dsh-plugins/**` **都不被忽略**（随 vsix 分发），
  而 `test/**`、`docs/**`、`scripts/**` 仍被忽略（匹配器带正例，防止「恒不忽略」架空断言）。
- **AC-11（清单语言与运行时语言拧开时提示一次）**：Given 显示语言为中文而 `dshPanel.locale=en`
  （或反向 / 显示语言为第三种语言而设置为 `zh`），When 扩展激活或该设置变更，
  Then 弹出**一条**信息提示说明「命令菜单与设置说明跟随 VS Code 显示语言」及统一办法
  （`Configure Display Language` 或改回 `auto`），同一会话不重复；Given `auto` 或两者一致，
  Then 不弹。

## 6. 兼容矩阵

| 场景 | 新版 dsh | 旧版 dsh | 说明 |
| --- | --- | --- | --- |
| Windows 本地 | 不适用（与 dsh 版本无关） | 不适用 | 语言判定只读 `vscode.env.language` |
| macOS 本地 | 不适用 | 不适用 | 同上 |
| Linux 本地 | 不适用 | 不适用 | 同上 |
| WSL Remote | 不适用 | 不适用 | `vscode.env.language` 取 VS Code 实例显示语言 |
| Remote-SSH / Dev Containers | 不适用 | 不适用 | 同上；插件 reason 仍走原 postMessage 链路 |
| 系统浏览器打开 DSH（非面板内） | 不适用 | 不适用 | 扩展文案不进入 DSH 页面 |

插件侧兼容：新插件 + 旧宿主（手工装新版插件到旧扩展）→ `reasonCode` 被忽略、`reason` 照常显示（英文/中文原文），提示不丢；
旧插件 + 新宿主 → 无 `reasonCode`，走 AC-6 回退透传。

## 7. 约束（引用宪法）

- **宪法第二条（零依赖零构建）**：自研 `i18n.js`（CommonJS，无依赖），不用 `@vscode/l10n`、不加构建步骤。
- **宪法第三条（禁止静默降级）**：英文文案缺失时回退中文并 `console.warn`（`[DeepSeek Harness]` 前缀），不能只留中文不吭声。
- **宪法第四条（安全默认）**：`tr` 只做字符串选择与 `{name}` 替换，不触碰 spawn/webview CSP；
  HTML 插值仍走既有 `escapeHtml`/`jsonForScript`；英文文案禁止含 `"`（HTML 属性直插处）。
- **配置开关**：`dshPanel.locale`，默认 `auto`；`off` 语义不适用（三值枚举）。
- **测试**：先红后绿；静态守卫测试防止回归；既有断言中文的用例必须保持绿。

## 8. 失败与提示

| 失败场景 | 用户可见提示（要点） | 出口动作 |
| --- | --- | --- |
| 英文文案缺失（第二参为空） | 回退显示中文原文 + console 警告一次 | 不阻断功能 |
| `dshPanel.locale` 取值非法 | 按 `auto` 处理（跟随 VS Code 语言） | 不弹错（设置页枚举已限制） |
| 清单 nls 文件缺失/键不齐 | VS Code 回落显示 `%key%` 原文 | 静态守卫测试在 CI 拦住，不允许发布 |
| 插件 reason 无 `reasonCode`（旧插件） | 原样显示 `reason` 文本（可能非当前语言） | 提示仍可见，不丢 |

## 9. 风险与开放问题

| 风险 / 未知 | 影响 | 应对 / 待验证 |
| --- | --- | --- |
| 约 350 条文案的英文翻译质量 | 英文用户体验 | 逐批人工复核；模板类文案保持「原因 + 下一步」结构 |
| 模板字面量里生成 JS/HTML 源码时插值转义 | 历史坑：注入脚本语法错误 | 英文文案禁 `"`；HTML 走 `escapeHtml`；生成物做 `node --check`（既有测试覆盖） |
| devMode（F5 调试）下清单 nls 只读 `package.nls.json` | 开发调试时命令标题/设置说明显示英文 | 已知取舍，写入本节；待 F5 实机确认（VS Code 源码 `findMessageBundles`：`devMode‖pseudo‖!language` 直取默认文件） |
| `tr` 在 `setLocale` 之前被调用（模块顶层求值） | 首条提示语言不对 | 约束：`tr` 只允许在函数体内调用；静态评审 + 测试 |
| 顶层 `description` 超长文案翻译 | 市场页显示 | 保留原结构逐句翻译 |

## 10. 验证记录

| 日期 | 方式 | 结论 |
| --- | --- | --- |
| 2026-11-20 | `TMPDIR=/tmp npm test`（24 套 / 1353 断言，改造前基线） | 通过 |
| 2026-11-20 | `TMPDIR=/tmp npm test`（**25 套 / 1494 断言**，含新 `bilingual-ui` 117 断言） | 通过 |
| 2026-11-20 | `DSH_HOME=/tmp/… HOME=/tmp/… npm run test:all`（**26 套 / 1494 断言**，含真实 dsh 0.2.2-rc.1 e2e） | 通过（本会话 `HOME` 只读，e2e 需把 `DSH_HOME` 指到可写目录，否则 dsh 写 `~/.dsh/profiles/web/cordis.yml` 报 EROFS） |
| 2026-11-20 | 静态守卫：`findBareChinese(extension.js) === 0`、`findMalformedTrCalls === []`、`findEagerLocaleEval === 0`、生成物裸段零 `tr(`、CSP/`<meta>` 与改造前逐行一致 | 通过 |
| 2026-11-20 | 实机 F5 / 切换 VS Code 显示语言实测 | **待验证**（沙箱无 VS Code 图形界面；manifest nls 加载逻辑已从本机 VS Code 源码 `findMessageBundles` 确认，devMode 只读 `package.nls.json` 一项仍需实机复核） |

**AC → 断言映射**：AC-1/AC-2 → `bilingual-ui` [4][5]；AC-3 → [6]；AC-4 → [0][1][2]；
AC-5 → [3]；AC-6 → [8] + `workspace-pin`（中继白名单 5 条）；AC-7 → [6]「切回 zh 恢复中文」+ `applyLocale` 接线；
AC-8 → 既有「不碰 DOM」静态断言（`workspace-pin`/`file-link-client-sim`）仍绿；AC-9 → [7]；
AC-10 → [9]；AC-11 → [10]（`localeSplitWorthNotifying` 全分支 + 一次性 + 恢复缺省）。

## 11. 变更历史

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-11-20 | 初稿 | 中英双语界面立项 |
