# 代码与协作约定

> 目标：让下一个人（或代理）读你的 diff 时，能立刻看出「为什么这么改」。
> 语言：**注释、日志、用户文案一律中文**（技术标识符、API 名保持原样）。

## 1. 语言与格式

- CommonJS：`require('vscode')`、`module.exports = { activate, deactivate }`；不引入 ESM/TS。
- 2 空格缩进；单引号字符串；语句结尾分号；同行大括号（`if (x) {`）；空行分隔逻辑段。
- 行宽不必强制，但避免超长链式表达；复杂表达式先取中间变量并起有语义的名字。
- 对象多行时尾随逗号按现有文件习惯（`extension.js` 多为无尾逗号，`package.json` 保持 JSON 合法）。
- 不擅自格式化整文件（避免 diff 噪音）；只改必要行。

## 2. 注释：写「为什么」

- 每个函数上方 JSDoc：一句话用途 + `@param` + `@returns`（说明失败语义）。
  例：

```js
/**
 * 探测当前 dsh 的 web 子命令是否支持 --no-open（读 `dsh web --help` 输出）。
 * 结果按进程缓存；探测异常时按支持处理（保留 dshNoOpenBroken 回退兜底）。
 * @param {{cmd: string, prefix: string[]}} inv
 * @returns {Promise<boolean>}
 */
```

- 历史事故、平台差异、协议怪癖**必须**在代码里留下原因（否则下一个人会「优化」掉）：
  例 `buildIframeHtml` 里「必须写成 `\\/\\/`，否则模板字面量把 `\/` 折叠成 `/`，整段脚本语法错误」。
- 分节注释：大节用

```js
// =====================================================================
// dsh web 浏览器认证（dsh 0.1.2-rc 起新增）与本地受管认证代理
// ---------------------------------------------------------------------
// …背景与设计约束…
// =====================================================================
```

  小节用 `// ── 标题 ──`（如「配置输入净化」「磁盘直读」）。
- 行内注释用于解释非显然的取巧写法（`catch { /* 页面正在切换：忽略 */ }`）。
  空 `catch` 必须带原因注释，禁止裸 `catch {}`。

## 3. 命名与函数形态

| 前缀 | 语义 | 例 |
| --- | --- | --- |
| `get*` | 读配置/纯取值，不产生副作用 | `getUrl`、`getWorkspaceDir`、`getFontScale` |
| `ensure*` | 幂等保证（已就绪则直接返回） | `ensureAuthProxy`、`ensureRunningOnce`、`ensureDshPlugins` |
| `resolve*` | 解析出目标（可能失败，返回 `null`/对象） | `resolvePanelTarget`、`resolveWorkspaceTarget`、`resolveDshModelSelection` |
| `build*` | 产出字符串/HTML | `buildIframeHtml`、`buildErrorHtml` |
| `is*` / `has*` | 布尔判定 | `isLocalLoopbackTarget`、`isInsideFolder` |
| `maybe*` | 带冷却/条件的可选引导 | `maybeGuideAuth` |
| `try*` | 尽力而为，失败返回 `false` | `tryDshPluginAdd` |
| `replay*` | 回放既有内容 | `replayDshAnswer` |

- 模块级可变状态集中在文件顶部并逐行注释用途（`managedChild`、`authProxy`、`ensurePromise`…）；
  新增全局状态必须写清楚「谁置位、谁清理、并发怎么去重」。
- 并发去重两种既有形态：单飞 Promise（`ensurePromise`、`authProxyPromise`）与
  `Map<key, Promise>`（认证代理的 `exchanges`）。需要时照抄，不要新造模式。
- 纯函数优先：能被单测直接调用的判定逻辑不要藏在 I/O 回调里（参见 `applyDshEvents`）。

## 4. 错误处理与日志

- **可失败路径** best-effort：返回 `false`/`null`，并在 `catch` 里写原因注释；
  只有「用户需要知道」的失败才弹消息。
- 用户可见失败：`vscode.window.showWarningMessage/showErrorMessage/showInformationMessage` 或
  `progress.report`/状态栏，文案必须包含「发生了什么 + 怎么办」。
- 日志前缀：扩展侧 `[DeepSeek Harness]`，dsh 子进程 stderr `[dsh web]`。
  `console.warn/error` 只用于排障，不能作为唯一的失败告知（宪法第三条）。
- 不把 token、Cookie、完整认证 URL 写进日志或错误消息。
- 超时统一用 `setTimeout` + `settled` 标记（`runCommandOk`、`exchangeFor`），避免重复 resolve。

## 5. 子进程与安全

- 所有命令参数先净化：`getHost()`（`HOST_PATTERN` 白名单）、`getPort()`（整数 + 1..65535）、
  `sanitizeCommand()`（拒绝 `SHELL_META_PATTERN`）。
- Windows：`shell: true`（命中 `dsh.cmd` shim，Node ≥18.20 必需），含空格且存在的路径整体加引号；
  POSIX：`execFile` + 参数数组（无 shell）。**不要统一两端实现**。
- 新增外部输入（配置项、消息字段、URL、路径）时，先问：它会进 `spawn`/`exec`/`fs`/`webview` 吗？
  会则必须净化 + 测试。

## 6. webview / HTML 生成

- CSP 模板：`default-src 'none'`；`frame-src` 只写精确 origin；`style-src 'unsafe-inline'`；
  脚本必须 `script-src 'nonce-<nonce>'` 且标签带 `nonce`（`makeNonce()`）。
- 任何插入 HTML 的值走 `escapeHtml()`；插入 `<script>` 的值走 `jsonForScript()`
  （转义 `<`/`>`/`&`/U+2028/U+2029）。
- 生成的内联脚本用 ES5 写法（`var`、`function`），与 `dsh-plugins/` 一致。
- iframe 缩放用 `zoom`，不用 `transform: scale`（非整数倍会整页模糊）。
- 新增 `postMessage` 类型时：webview 侧必须校验 `origin` 与 `source`；宿主侧必须校验字段类型并截断长度
  （现有做法：`token.slice(0,64)`、`path.slice(0,4096)`）。

## 7. 测试代码约定

- 文件名 `<主题>.test.js`；顶部块注释写「运行方式 + 覆盖点」。
- 自带 `vscode` 桩：拦截 `Module._load`，只实现该套件用到的 API；配置用可变对象支持 case 切换。
- 断言统一 `ok(cond, name)`：失败打印 `✗` 并抛出，成功打印 `✓` 并计数。
- 结尾打印 `全部通过：N 项断言 ✓` 后 `process.exit(0)`；异常路径 `process.exit(1)`。
- 临时目录用 `fs.mkdtempSync(path.join(os.tmpdir(), …))`，结束 `rmSync`；端口用高位随机/固定测试端口
  并先探测空闲；测试不得写入真实用户目录（需要 `os.homedir` 时改为临时目录并恢复）。

## 8. 配置项与贡献点

- 新配置项：`package.json` 的 `contributes.configuration.properties` 写 `type`/`default`/`description`（中文，
  说清默认行为与关闭影响），代码里通过 `cfg().get('<key>', <default>)` 读取并**再做一次类型/范围收敛**
  （参照 `getHost`/`getPort`）。
- 新命令：`contributes.commands`（标题用 `DeepSeek Harness: 中文动作`）+ `registerCommand` +
  `context.subscriptions.push`；需要时在 `menus` 挂位置。
- 注意 `activationEvents`：只有视图/命令/启动三类；新增独立命令若需在面板未打开时可用，
  确认激活时机。

## 9. 版本与发布约定

- **发版需维护者确认**：修改 `package.json` 版本号、提交版本变更、打 tag、push、打包交付均需先征得确认；
  代理/贡献者不得自行发版（本地验证、测试与文档修改不受限）。
- 语义化版本：行为变更 `MINOR`，修复 `PATCH`，不兼容变更 `MAJOR`。
- **调试/候选包命名**（不打 tag、不进 Release）：临时把 `package.json` 的 `version` 改为
  semver 预发布号——日常调试 `X.Y.Z-dev.N`（每次重打包递增 `N`），候选验证 `X.Y.Z-rc.N`；
  用 `npx --yes @vscode/vsce package <版本> --no-git-tag-version --allow-missing-repository`
  打包。vsix 文件名由 vsce 自动生成（`<name>-<version>.vsix`），**不要手改**；
  **预发布号一律不打 tag**：`v*` 会触发 Release 工作流并生成正式 Release。验证完用
  `git checkout -- package.json` 恢复；正式发版仍用 `X.Y.Z` + tag `vX.Y.Z`。
- `CHANGELOG.md` 顶部新增版本小节，按「Copilot 桥接 / 忠实窗口（面板）/ 测试」分组，用户视角描述。
- 提交信息：`<type>: <描述>（v<版本>）`；`type ∈ feat|fix|test|docs|chore|security|merge`。
- 一次提交只做一组相关改动；「顺手重构」单独提交，并在信息里说明 `chore:`。
- 用户可见文案改动（README 配置表、错误提示）与代码同提交。

## 10. 历史坑（回归清单）

> 下面每一条都对应一次真实事故或线上故障。改到相关代码时，先看它，再动手。
> `AGENTS.md` 只保留最常用的几条，完整清单以此为准。

| 坑 | 现象 | 正确做法 |
| --- | --- | --- |
| 模板字面量里的正则反斜杠 | 生成的内联脚本语法错误，相关功能整体失效 | 生成 JS 源码时反斜杠写 `\\\\`（见 `buildIframeHtml` 的 `\/\/` 注释） |
| `tabReloadFn` 声明顺序 | 打开标签页 TDZ 报错 | 先声明 `reloadTab`，再把引用赋给 `tabReloadFn`（v0.8.43） |
| 双 webview 同时加载 DSH | DSH 前端插件加载互斥、页面异常 | 维持「单活动视图」：标签页接管时侧边栏显示占位 |
| `session.page` 的 `throughSeq` 越界 | 网关报 `past cursor N` | 先用大值探测游标、从错误里解析，再按游标取尾部一页 |
| 只认 `assistant/chunk` | Copilot 侧「已提交但无回答」 | 两代事件都认（`dshEventText`）；本轮无正文要明确提示 |
| 模型条目用 API 兼容旧名 | DSH `session.selectModel` 静默回落默认模型 | 映射用 DSH 在册 id（如 `deepseek-flash`）+ `checkDshModelDrift` 告警 |
| `transform: scale` 缩放 iframe | 非整数倍缩放整页模糊 | 用 CSS `zoom`（重新布局渲染） |
| 把文件内容透传给 DSH | token 爆炸、上下文污染 | 附件只透传**路径**（`【文件引用】` 块），内容不透传 |
| 全对话拼接做去重签名 | 拖入新文件被误判为重复投递 | 附件签名只取**最后一条**用户消息 |
| 新增文件忘记 `.vscodeignore` | 文档/脚本被打进 `.vsix` | 新增非运行时目录时同步更新 `.vscodeignore` |
| 在 webview 里直连 dsh 裸地址 | 新版 dsh 401（SameSite=Strict Cookie 不随第三方 iframe 发送） | 走受管认证代理；仅在回环 + 非真远程场景启用 |
| 新插件复用中继的 `ack` 消息类型 | `dsh-vscode-file-links` 的 `layoutOnly` 判别被新字段误判，`diffMode` 被覆盖成 false，之后所有点击只开原文 | 新插件用独立消息类型（`workspace-pin` / `workspace-pin-result`）；`ack` 只留既有语义 |
| 以为 `workspace/create` 或进程 `cwd` 能改变 DSH 当前工作区 | 面板打开仍停在旧项目（`recentWorkspace()` 按最近活动选） | 选中态在页面里：由客户端插件调 `ctx.workspaces.create` + `ctx.uiWorkspace.openWorkspace`（006） |

## 11. 禁止事项

- 新增 npm 依赖 / 构建步骤 / TS / 打包器。
- 向 DSH 页面注入脚本或改写 DOM（宪法第一条）。
- 用 `console.log` 代替用户可见提示。
- 在测试里依赖真实 dsh（除 `test/e2e-real-dsh.test.js`）或真实用户配置目录。
- 把 `.vsix`、`.dsh-debug/`、`node_modules/`、`.vscode/` 提交进仓库。
