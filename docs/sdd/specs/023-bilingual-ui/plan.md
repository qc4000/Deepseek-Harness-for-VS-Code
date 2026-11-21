# 方案 023：中英双语界面

## 1. 总体设计

两套机制，按「文案住在哪里」分工：

| 层 | 机制 | 文件 |
| --- | --- | --- |
| 运行时文案（`extension.js` 里的 ~350 条） | 自研 `tr(zh, en, vars)`，调用点就近双语 | `i18n.js`（新） + `extension.js` |
| 清单文案（`package.json` 45 处展示字段） | VS Code 原生 manifest nls：`%key%` + 两份 nls 文件 | `package.json`、`package.nls.json`、`package.nls.zh.json`（新） |
| 插件上报文本（3 条） | 协议改带机器码 `reasonCode`，宿主本地化 | `dsh-vscode-workspace/lib/client.js` + `extension.js` |

### 1.1 语言判定

```js
// i18n.js
resolveLocale(vscodeLanguage, setting)
// setting === 'zh' | 'en'            → 直接用（dshPanel.locale 覆盖）
// setting === 'auto' / 非法 / 缺省   → 按 vscodeLanguage：
//   以 'zh' 开头（zh-cn/zh-tw/zh-Hans…）→ 'zh'
//   其它非空字符串（en/ja/de…）          → 'en'
//   undefined / ''（测试桩没有 env.language）→ 'zh'（缺省中文：仓库文案以中文为源）
```

- `setLocale()` / `getLocale()` 维护当前语言；`activate()` 里读
  `vscode.env.language` + `vscode.workspace.getConfiguration('dshPanel').get('locale')`，
  并在既有 `onDidChangeConfiguration`（`extension.js:7415`）里重算（AC-7 热切换）。
- 读取全部走防御式访问（测试桩 `vscode.env` 可能没有 `language`，个别桩甚至没有 `env`）。

### 1.2 `tr(zh, en, vars)`

```js
tr('自动切换失败：{reason}', 'Failed to switch workspace: {reason}', { reason })
```

- 只做「选一条 + `{name}` 替换」，不做复数/日期等任何格式化。
- **中文参数必须与现状逐字节一致**（既有中文断言全靠这一点保持绿）。
- 英文缺省（`en` 非字符串或空串）→ 回退中文并 `console.warn('[DeepSeek Harness] 缺少英文文案…')` 一次（宪法第三条：不静默）。
- **函数名用 `tr` 而不是 `t`**：`extension.js` 已有两个局部变量 `t`（`extension.js:2288`、`extension.js:6193`），同名会遮蔽。
- `tr` 只允许出现在函数体内（模块顶层先于 `setLocale` 求值会锁死中文）。

### 1.3 转换规则（对 `extension.js` 的机械改写）

1. 只包**用户可见**的字符串字面量：通知、状态栏、HTML 文本/属性、错误页、QuickPick
   （label/description/detail/prompt/按钮文案）、`throw new Error(...)`（会经 `showErrorMessage` 露出）、
   输出面板与 `debugLog` 文案。
2. 注释（中文）一律不动；标识符、配置取值、协议字段、命令 id、class 名一律不动。
3. 插值：`` `前缀 ${x}` `` → `tr('前缀 {x}', 'prefix {x}', { x })`（表达式只求值一次）。
4. 同一字符串既用来生成按钮又用来比较（`choice === '安装'`）→ 提取
   `const CHOICE_INSTALL = tr('安装', 'Install')` 两边复用，避免语言不一致。
5. 生成 HTML/JS 源码的模板里：HTML 属性与文本走既有 `escapeHtml`（如周边已用），
   英文文案**禁止含 `"`**；生成 JS 源码里的字符串继续走 `jsonForScript`。
6. 不改控制流、不改日志级别、不重排代码。

**不翻译的例外（守卫白名单 `FORMAT_LITERALS`，见 `test/lib/js-scan.js`）**：
`用户：`、`助手：`、`【文件引用】`、`【Copilot 记忆】`、`【Copilot 其他模型回答】`
是写进转录后还要 `startsWith`/`indexOf` 读回的**格式协议**（共 8 处读回），
语言失配会直接打断 Copilot 桥接 → 按数据格式处理、语言稳定。
唯一例外的用户可见标记是 ⏳ 产地标记：`i18n.DSH_ANSWER_MARKERS` 成对托管，
写入按当前语言、读取用 `findDshAnswerMarker()` 中英都认（AC-9）。

### 1.4 清单 nls

- `package.json` 中 45 处展示字段改为 `%key%`，键名规则：
  - 命令标题 → `cmd.<commandId>.title`（如 `cmd.dshPanel.refresh.title`）
  - 设置描述 → `cfg.<settingKey>.desc`；markdown 描述 → `cfg.<settingKey>.mdesc`
  - 枚举说明 → `cfg.<settingKey>.enum.<值>`（数组按下标配对）
  - 扩展 `description` → `ext.description`
- `package.nls.json` = **英文**（所有非 zh locale 的兜底，也是 devMode 下唯一被读的文件）；
  `package.nls.zh.json` = **中文**（`zh-cn`/`zh-tw`/`zh-Hans` 逐级剥连字符回退到 `zh` 命中）。
- 已从本机 VS Code 源码（`extensionsScannerService.getLocalizedMessages` / `findMessageBundles`）
  确认：`package.nls.<locale>.json` 不存在时按 `-` 逐级回退，最终落 `package.nls.json`；
  `devMode‖pseudo‖!language` 时只读 `package.nls.json` → **F5 调试时清单显示英文**（已知取舍）。

### 1.5 插件 reason 机器码

- 客户端新增可选字段 `reasonCode`：`ready-timeout`（等快照就绪超时）、
  `unknown-error`（`messageOf` 拿不到 message）、`contract-mismatch`（`workspace/create` 未返回 `workspaceId`）；
  **`reason` 字段保留且仍非空**（协议兼容，旧宿主直接显示它）。
- 宿主：`reasonCode` 命中已知码 → 用 `tr` 出本地化文案；未命中/缺失 → 原样透传 `reason`（回退路径）。
- 插件侧因此不再产生任何中文字面量（AC-4 覆盖插件目录）。

## 2. 影响面

| 文件 | 改动 |
| --- | --- |
| `i18n.js` | 新增：`tr`/`setLocale`/`getLocale`/`resolveLocale` + `__internals` |
| `extension.js` | 顶部 `require('./i18n')`；`activate` 与配置变更处接语言；~350 处文案包 `tr`；`handleWebviewMessage` 的 workspace-pin 分支按 `reasonCode` 本地化 |
| `package.json` | 45 处展示字段 → `%key%`；新增 `dshPanel.locale` 设置（含 `enum`/`enumDescriptions` 的 `%key%`） |
| `package.nls.json` / `package.nls.zh.json` | 新增，键集必须完全一致 |
| `dsh-plugins/dsh-vscode-workspace/lib/client.js` | 3 条 reason → 英文短文本 + `reasonCode` 机器码 |
| `test/bilingual-ui.test.js` | 新增（i18n 单元 + 静态守卫 + 清单 nls + reasonCode） |
| `test/workspace-pin.test.js` | 补 `reasonCode` 断言与宿主本地化断言 |
| `docs/TESTING.md` | 测试地图补行 |

## 3. 契约与回退

- `workspace-pin-result`：**新增可选** `reasonCode`；旧宿主忽略未知字段，旧插件不发该字段 →
  新宿主 `reasonCode` 缺失时原样透传 `reason`。双向兼容，无版本握手。
- `dshPanel.locale`：新增设置，缺省 `auto` = 现状行为（中文环境零变化）。
- 清单 nls：nls 文件缺失时 VS Code 显示 `%key%` 原文——由静态守卫测试保证不发生。

## 4. 测试策略（先红后绿）

1. **`test/bilingual-ui.test.js`（新，先写）**
   - L1：`resolveLocale` 全分支（AC-1）、`tr` 选语/占位符/缺英文回退（AC-2）。
   - 静态守卫：扫 `extension.js` 与 `dsh-plugins/*/lib/*.js`（去注释后无裸中文字面量，AC-4）；
     扫 `package.json`（展示字段全为 `%key%`，AC-5）；两份 nls 键集一致且覆盖全部 `%key%`。
   - L2：`setLocale('en')` → `buildIframeHtml` 的 `aria-label` 为英文、`setLocale('zh')` 回到中文（AC-3）。
2. **`workspace-pin.test.js`**：客户端上报 `reasonCode`；宿主 en/zh 两态提示文案；无 `reasonCode` 透传（AC-6）。
3. 既有 24 套全部保持绿（中文逐字节一致是前提）。

## 5. 安全审查

- `tr` 不进 `spawn`/`exec` 参数，不改 `sanitizeCommand`/`getHost`/`getPort` 路径。
- webview CSP/nonce 不变；HTML 插值仍走 `escapeHtml`；英文文案禁 `"`，杜绝属性截断。
- 生成的中继脚本仍走既有 `node --check` 与 `vm` 真跑测试。
- 无新数据流、无新落盘、无 token 触碰。

## 6. 回退方案

- 单一回退：`dshPanel.locale = auto` + `vscode.env.language` 非 zh 即英文；
  出问题时把 `package.nls*.json` 两文件删掉 + `package.json` 恢复 `%key%` 前的原文即可回中文（git revert 对应提交）。
- 代码层回退：`i18n.js` 删除后 `extension.js` 顶部 require 失败 → 整体 revert；
  不存在「半套双语」的中间态风险（`tr` 中文参数与原文逐字节一致，回退无行为差异）。
