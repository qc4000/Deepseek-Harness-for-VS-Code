# 规格 010：工作区外文件链接也能在 VS Code 里看变更

| 项 | 内容 |
| --- | --- |
| 编号 | 010 |
| 状态 | implemented（离线 21 套 / 942 项断言通过；`file-link-diff` 105、`dsh-changes-plugin` 52） |
| 负责人 | @Vithrive |
| 关联 | 扩充 [005](../005-file-link-turn-diff/spec.md) · 基线 [001](../001-workspace-file-links/spec.md) · 目标版本 `1.0.7` |
| 创建 / 更新 | 2026-10-30 / 2026-10-30 |

## 1. 背景与问题

005 让 `workspaceFileLinkAction=diffAndOpen` 时点击对话里的文件链接直接看「该轮」的并排
diff。但用户实测（2026-10-30）：**DSH 改的文件不在当前 VS Code 打开的文件夹里时，点击
链接不会在 VS Code 里打开变更，而是回落到 DSH 侧边栏**。

原因在宿主侧的顺序，与数据无关：

- `revealWorkspaceTarget()` 先调 `resolveWorkspaceTarget()`，它要求目标**位于某个 VS Code
  工作区文件夹内且 `stat` 成功**（001 的安全边界）。工作区外一定返回 `null`。
- `null` 分支直接 `replyRevealResult(ok:false)` → 插件回放原始点击 → DSH 侧栏打开。
  **轮级取数（P1）根本没被调用**。

而轮级 diff 的两侧全文完全来自 DSH 自己的记录（`dsh-vscode-changes` 路由按「会话 + 轮 +
已记录文件清单」匹配），宿主既不读盘、也不在资源管理器定位，所以「工作区外不能打开原文件」
并不等于「工作区外不能看该轮变更」——这是 005 遗留的边界过窄，不是安全要求。

同一处顺序问题还带来两个次生现象：

- 该轮**删除**了某个文件时，文件已不存在 → `stat` 失败 → 同样落到 DSH 侧栏，
  「删除」这种最该看 diff 的改动反而看不到。
- DSH 当前工作区与 VS Code 打开的文件夹不一致（`dshPanel.pinWorkspaceToVSCode` 关闭、
  或 DSH 里手动换了工作区）时，**整场对话的所有链接**都退化成 DSH 侧栏。

## 2. 目标

- `diffAndOpen` 下，工作区外文件链接点击后**在 VS Code 打开该轮并排 diff**（标题
  `名称 · 第 N 轮`），DSH 侧栏不再打开。
- 数据只来自 DSH 记录：宿主不为工作区外链接读盘、不在资源管理器定位、不做 HEAD 对比。
- 拿不到轮级数据时**照旧**回落到 DSH 侧栏，并给出原因与出路（不静默）。
- 其余模式（`revealAndOpen` / `revealOnly` / `off`）与工作区内链接的现有行为完全不变。

## 3. 非目标

- **不放开「打开/定位工作区外文件」**：`revealAndOpen` / `revealOnly` 仍要求目标在工作区内
  且 `stat` 成功（宪法第五条）。想做的是「看记录里的变更」，不是「把任意路径交给编辑器」。
- 不为工作区外链接做 P0（`HEAD` ↔ 工作树）：那需要在该文件所在目录跑 git，等于把读盘
  扩展到工作区外。
- 不改 `dsh-vscode-file-links` 客户端协议：点击本来就带 `{path, change}`，坐标与路径够用。
- 不新增配置项：行为挂在既有的 `dshPanel.workspaceFileLinkAction=diffAndOpen` 之下。

## 4. 用户故事

- 作为 **VS Code 用户**，我希望 DSH 改到工作区外的文件时，点击链接也能看到「这一轮改了
  什么」，以便不离开编辑器去比对。
- 作为 **维护者**，我希望这条新链路只消费 DSH 的记录、不碰本地磁盘，以便安全边界不因
  修 bug 而扩大。

## 5. 验收标准（必须可执行）

> 数据源：P1 = 轮级（`dsh-vscode-changes` 路由，两侧全文来自 DSH 记录）；P0 = git
> `HEAD` ↔ 工作树（仅工作区内）；L0 = 普通打开（仅工作区内）。

- **AC-1**：Given `diffAndOpen`、目标在工作区外且该轮改过它，When 点击，Then 打开虚拟文档
  并排 diff（左右 = 该轮开始/结束内容，标题 `名称 · 第 N 轮`），**不执行** `revealInExplorer`，
  回执 `ok:true`（插件不回放、DSH 侧栏不打开）。（断言：`vscode.diff` 被调用、
  `revealInExplorer` 未调用、`dsh-reveal-result.ok === true`）
- **AC-2**：Given 同上但该轮没有它的变更记录（`{matched:false}`），When 点击，
  Then 回执 `ok:false`（DSH 侧栏照旧打开），状态栏提示「该文件在 VS Code 工作区外 + 该轮
  没有它的变更记录」。（断言：回执 false 且提示含「工作区外」）
- **AC-3**：Given 链接带行号后缀（`:12` / `#L12`），When 原样路径未命中，Then 去掉后缀
  再查一次（最多两次请求），命中即打开 diff。（断言：`fetchTurnChange` 依次收到
  `a.ts:12`、`a.ts`）
- **AC-4**：Given 消息里没有合法的 `change` 坐标（客户端取不到会话/轮），When 点击工作区外
  链接，Then **不**请求路由、不回执成功，提示「无法确定它属于哪一轮」。
- **AC-5**：Given 轮级数据不可用（404 `unavailable`/`released`/`no-record`、`no-text`、
  二进制、超大、超时、网络错），When 点击，Then 回执 `ok:false`，且全程**不读本地磁盘**
  （不调用 git 基线、不对越界路径 `stat`），提示给出原因与出路（重启 dsh web / DSH 侧栏）。
- **AC-6**：Given `revealAndOpen` / `revealOnly`，When 点击工作区外链接，Then 与 1.0.6
  完全一致（不取轮级数据、不读盘），提示里给出「改成 `diffAndOpen` 可看该轮变更」的出路；
  `off` 时连提示也不变（不接管）。
- **AC-7**：Given 工作区内链接，When 点击，Then 三级降级（P1 → P0 → L0）与 1.0.6 一致
  （回归断言不得减少）。
- **AC-8**：Given 链接写法为 `../x`、`a/../x`、`C:\d\x`（Windows），When 插件把链接路径与
  summary 的 `path`/`display` 比对，Then `changeCandidates` 至少给出一个**折叠 `..` 后的
  绝对路径**候选。（断言：`changeCandidates('/w/proj', '../other/a.ts')` 含 `/w/other/a.ts`）
- **AC-9**：Given 安全边界，Then 新链路只把「会话 + 轮 + 路径字符串」发给 DSH 插件路由；
  路由仍只按已记录清单匹配、绝不按请求路径读盘；宿主不因工作区外链接访问文件系统。

## 6. 兼容矩阵

| 场景 | 新版 dsh（含 `workspaceChanges`） | 旧版 dsh | 说明 |
| --- | --- | --- | --- |
| Windows 本地 | P1（工作区外）→ DSH 侧栏 | DSH 侧栏 + 提示 | 路径写法含 `\` / 盘符，候选归一后匹配 |
| macOS 本地 | 同 Windows | 同 Windows | 无平台分支 |
| Linux 本地 | 同 Windows | 同 Windows | — |
| WSL Remote / Remote-SSH / 容器 | 同 Linux | 同 Linux | 轮级路由与扩展同侧，webview 只传坐标 |
| 面板未加载插件 / 独立浏览器 | 不适用 | 不适用 | 无握手即不接管，沿用 001 |

## 7. 约束（引用宪法）

- 第一条：不注入、不改 DSH 页面；diff 仍在 VS Code 侧渲染。
- 第三条：失败必可见——每种失败都有中文状态栏文案与出路。
- 第四条：旧 dsh / 旧插件组合仍可用：轮级 404 就回落 DSH 侧栏，行为等同 1.0.6。
- 第五条：**不扩大读盘面**。工作区外链接只走 P1（数据来自 DSH 记录），不碰 P0/L0；
  `revealAndOpen` / `revealOnly` 的「工作区内且 `stat` 成功」边界保持不变。
- 第六条：新逻辑（`openOutOfWorkspaceDiff` 等）挂 `module.exports.__internals` 可离线测。
- 第七条：README 配置说明 / CHANGELOG / 版本号同步（发版需维护者确认）。

## 8. 失败与提示

| 失败场景 | 用户可见提示（中文文案要点） | 出口动作 |
| --- | --- | --- |
| 无轮坐标 | 「该文件在 VS Code 工作区外，且无法确定它属于哪一轮：已在 DSH 侧栏打开」 | 在 DSH 侧栏查看 |
| 该轮没改这个文件（`matched:false`） | 「…工作区外，该轮没有它的变更记录：已在 DSH 侧栏打开」 | 同上 |
| 轮级不可用（404 `unavailable`） | 「…工作区外，轮级对比需要重启 dsh web 后生效：已在 DSH 侧栏打开」 | 命令面板「重启 dsh web」 |
| 会话已释放 / 轮无记录 / 取不到全文 | 「…工作区外，该轮的对比数据已随会话释放 / 还没准备好 / 取不到全文：已在 DSH 侧栏打开」 | 在 DSH 侧栏查看 |
| 二进制 / 超 1 MiB / 超时 / 网络错 | 「…工作区外，文件是二进制 / 超过 1 MiB / 取数超时 / 取数失败：已在 DSH 侧栏打开」 | 无 |
| 非 diff 模式点到工作区外链接 | 「该文件在 VS Code 工作区外，无法在资源管理器定位：已在 DSH 侧栏打开（改成 diffAndOpen 可看该轮变更）」 | 改配置 |

## 9. 风险与开放问题

| 风险 / 未知 | 影响 | 应对 / 待验证 |
| --- | --- | --- |
| 链接标题的写法（相对/绝对/带 `..`）与 summary 的 `path`/`display` 不一致 | 匹配不到 → 仍回落侧栏 | `changeCandidates` 同时给原文 / 折叠后绝对路径 / 相对 cwd 三种候选；行号后缀去一次再试 |
| 同名文件在工作区内外都存在 | 可能选错一个 | 工作区内能解析时**优先**走原三级链路（本规格只在解析失败时才介入） |
| 工作区外路径可能很长/含控制字符 | 注入风险 | 复用 001 的净化（长度 ≤ 4096、拒绝控制字符），坐标经 `sanitizeChangeCoord` |
| 用户其实想要「打开工作区外原文件」 | 能力缺口 | 属 001 的安全边界，另立规格评估；本规格只解决「看变更」 |

## 10. 验证记录

| 日期 | 方式 | 结论 |
| --- | --- | --- |
| 2026-10-30 | `npm test`（21 套 / 942 项断言；`file-link-diff` 74 → 105、`dsh-changes-plugin` 45 → 52） | 通过。先红后绿：`openOutOfWorkspaceDiff is not a function` / 「折叠 .. 后的绝对候选」/ 「绝对写法也命中」三条红断言依次转绿 |
| 2026-10-30 | `npm run test:all` | 未跑：本次未改 dsh 契约字段（只多了路径候选，路由参数与响应不变） |
| 待验证 | 实机 F5：VS Code 打开项目 A、DSH 工作区为项目 B，点击 B 内文件链接 | 待用户验证（dev 包已交付） |

## 11. 变更历史

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-10-30 | 初稿 | 用户实测：工作区外文件链接无法看变更，直接落到 DSH 侧栏 |
| 2026-10-30 | 实现并转 implemented；补「反推相对 cwd」候选 | 先红后绿时发现：点击给绝对路径、记录给 `../x` 时仍匹配不到（真机最常见的那一半） |
