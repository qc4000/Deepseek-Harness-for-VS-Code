# 规格 005：点击对话里的文件链接时展示变更（轮级 diff）

| 项 | 内容 |
| --- | --- |
| 编号 | 005 |
| 状态 | implemented（离线 14 套 / 504 项断言通过；2026-10-28 实机验证通过） |
| 负责人 | @Vithrive |
| 关联 | 基线规格 [001](../001-workspace-file-links/spec.md) · 目标版本 `1.0.4` |
| 创建 / 更新 | 2026-10-26 / 2026-10-26 |

## 1. 背景与问题

001 让面板内点击 DSH 对话里的工作区文件链接时，在 VS Code 资源管理器定位并打开原文件。
但用户真正的疑问是「模型**改了什么**」：现在打开的是改完之后的文件，看不到差异；DSH 自己
的工具卡片里其实有 `+N/-M` 与内联 diff，被我们接管后反而看不到了。

DSH 侧的可用数据（读 `@deepseek-ai/dsh-workspace-changes` 源码确认，0.2.1-rc.2）：

- 粒度是**顶层轮**：`turn/start` 拍基线快照，文件工具改动前每路径每轮拷贝一次原文，
  `agent/turn-stopping` / `turn/end` 再拍一次并 `append('workspace/changes', { turn })`；
  `diff()` 的语义就是「该文件在本轮开始与结束时的对比」。同一轮内多次编辑同一文件
  **合并为一条净变更**，中间态不存盘；改回原样则不列出。
- 对外 HTTP 只有 `/api/changes.summary`（清单+增删行）与 `/api/changes.diff`（3 行上下文的
  hunk），**没有整文件**，因此拿不到「历史轮」的完整前后文。
- ~~进程内存里有 `records.set(event.seq, { summary, sources })`，`sources` 才是两侧内容的
  来源……同一会话内任意历史轮都能取到两侧全文~~ —— **2026-10-27 实机勘误**：
  `ctx.workspaceChanges` 只提供 `{ summary(sessionId, seq), diff(...) }`；`records` 是
  dsh 插件 `apply()` 闭包内的 TurnRecorder 私有字段，外部读不到（探针插件在真机上实测
  `Object.keys(ctx.workspaceChanges) === ['summary','diff']`）。初版实现正是读 `records`，
  在真机上 100% 走 404，轮级 diff 从未生效（离线单测因假 ctx 里凭空造了 `records` 而
  全绿——契约不能靠 mock 固化）。
- **现行数据来源**：两侧全文由本插件用 dsh 自家 recorder 同款的公开钩子自行捕获
  （`fs/write-intent` 与 `fs/edit-intent` 前置读「轮内首次改动前」原文 + `turn/end`
  再读一次作「轮结束」内容；`write` 工具发前者、`edit` 工具发后者，两个都要钩）；
  「本轮改了哪些文件」仍以 `summary()`（`workspace/changes` 事件的权威清单）
  为准。shell 直接改动没有 intent 钩子 → 清单里有但取不到全文 → 返回
  `unavailable:'no-text'`，扩展退回 P0 而不是误报「没变更」。

## 2. 目标

- 面板内点击文件链接，若该文件在**点击所处的那个轮**里被改动，就在 VS Code 里打开并排 diff，
  左右两侧分别是**该轮开始**与**该轮结束**的文件原文，标题写明轮次。
- 轮级数据不可得时，退回「工作树 vs `HEAD`」的 git diff（标题明确写「与 HEAD 的差异」），
  再不可得则退回 1.1.x 的普通打开；三级降级全程用户可见、不误导。
- 任意历史轮（会话仍存活）都能看；跨轮各自独立，不出现「累积到最新」的错觉。
- 新能力可通过配置关闭；关闭或未启用时，行为与 1.1.x 完全一致。

## 3. 非目标

- **不做「每次编辑」粒度**：DSH 不存轮内中间态，只能靠日志反演，脆弱且收益低。
- 不给二进制、超大文件、被 shell 单独改动（不在 summary 里）的文件造 diff：没有内容可对比。
- 不依赖 `dsh-git-rollback` 的检查点（作为 P2 另行立项，见第 9 节）。
- 不改写 DSH 页面 DOM、不注入样式、不接管 DSH 侧边栏内的链接（沿用 001 的边界）。
- 不实现行号跳转（`:12` / `#L12` 仍只用于提高路径命中率）。

## 4. 用户故事

- 作为 **VS Code 用户**，我希望点击模型提到的文件时直接看到**这一轮**改了什么，
  以便不离开编辑器就核对改动，而不用自己去找 git 历史。
- 作为 **DSH 二次开发者**，我希望这套增强能一键关掉、且关掉后连配套插件都不安装，
  以便我的定制页面不被干扰。
- 作为 **维护者**，我希望契约风险集中在一处、失败一律降级且可见，
  以便 DSH 升级后最坏情况只是少一个功能，而不是点击失效。

## 5. 验收标准（必须可执行）

> 数据源约定：P1 = 轮级（本规格新增的 DSH 插件路由）；P0 = git `HEAD` ↔ 工作树；L0 = 普通打开（1.1.x 行为）。

- **AC-1**：Given 同一轮内同一文件被编辑 3 次、`workspaceFileLinkAction=diffAndOpen`，
  When 点击该轮回复里的链接，Then 只出现一个 diff，左右为该轮开始/结束的原文，
  标题含「第 N 轮」。（断言：同轮多次编辑只产生一条记录、diff 两侧取自该轮）
- **AC-2**：Given 第 3 轮与第 7 轮都改过同一文件，When 分别点击两处链接，
  Then 两次 diff 的内容不同，且各自等于对应轮的增量（第 7 轮不含第 3 轮的改动）。
- **AC-3**：Given 该文件在某轮内改完又改回原样（或该轮未改动它），When 点击，
  Then 不打开 diff，退回 L0 普通打开，且状态栏提示「本轮没有该文件的变更」。
- **AC-4**：Given P1 不可用（新插件未安装 / 未重启 dsh / 会话已释放 / 路由 404），
  When 点击，Then 退回 P0：打开 `HEAD` ↔ 当前文件的 diff，标题含「与 HEAD 的差异」，
  并状态栏提示轮级数据不可用及下一步动作（重启 dsh web）。
- **AC-5**：Given 非 git 仓库、文件无未提交改动、或 git 不可用，When 点击，
  Then 退回 L0：仅 `vscode.open` 打开原文件，不弹错误、不阻塞点击。
- **AC-6**：Given 该文件为二进制，或任一侧超过 1 MiB，When 点击，Then 退回 L0，
  状态栏提示「文件过大/二进制，无法并排对比」。
- **AC-7**：Given 客户端无法确定会话或轮坐标（`ack.diff` 未置位、DOM 中无轮标记），
  When 点击，Then 只发送 `{path}`（不带 `change`），宿主直接走 P0，不报错。
- **AC-8**：Given `workspaceFileLinkAction` 为 `revealAndOpen` / `revealOnly` / `off`，
  When 点击，Then 行为与 1.1.x 完全一致（不取 P1、不取 P0）；`off` 时不安装任何配套插件。
- **AC-9**：Given 任意调用方请求新路由，When 参数缺失、越界（`turn` 非正整数、
  `sessionId`/`path` 超长）、或路径不匹配任何已记录文件，Then 返回 400/`{matched:false}`，
  **绝不按任意路径读盘**。
- **AC-10**：Given 旧版 dsh（无 `workspaceChanges` 服务）或 `records` 结构变化，
  When 点击，Then 路由返回 404，扩展走 P0，且日志里只有一条说明，不刷屏。
- **AC-11**：Given 宿主取数耗时超过 2.5 s，When 点击，Then 不会同时打开 DSH 侧栏
  （新增 `reveal-ack` 把等待延长到 6 s）；6 s 仍无结果才回放原始点击。
- **AC-12**：Given 标题生成，Then P1 为 `名称 · 第 N 轮`，P0 为 `名称 · 与 HEAD 的差异`，
  两者不得混淆；标签页为非预览（`preview: false`）。
- **AC-13**：Given Remote（WSL / SSH / 容器），When 点击，Then 行为与本地一致：
  git 与新插件都运行在扩展宿主/DSH 所在侧，webview 只负责坐标与展示。

## 6. 兼容矩阵

| 场景 | 新版 dsh（≥0.2.1，含 workspaceChanges） | 旧版 dsh | 说明 |
| --- | --- | --- | --- |
| Windows 本地 | P1 → P0 → L0 | P0 → L0 | git 走 `shell:true`，参数仍经 `sanitizeCommand` |
| macOS 本地 | 同 Windows | 同 Windows | 无平台分支 |
| Linux 本地 | 同 Windows | 同 Windows | POSIX 无 shell |
| WSL Remote | 同 Linux（远端执行） | 同 Linux | 扩展 `extensionKind: workspace` |
| Remote-SSH / Dev Containers | 同 Linux（远端执行） | 同 Linux | 需远端有 `git` |
| 系统浏览器打开 DSH（非面板内） | 不生效（无外层宿主） | 不适用 | 沿用 001 判定 |
| 无 git 的工作区 | P1（文件工具改的文件）→ L0 | L0 | P0 不适用 |

## 7. 约束（引用宪法）

- 第一条：只读监听 + 页面内不改 DOM；diff 全部在 VS Code 侧渲染，不动 DSH 页面。
- 第二条：零依赖零构建。虚拟文档用内置 `TextDocumentContentProvider`；git 用系统 `git`
  或 `vscode.git` 内置扩展，不新增 npm 依赖。
- 第三条：三级降级每一步都有状态栏/标题级提示，禁止只 `console.log`。
- 第四条：旧 dsh、旧宿主、旧客户端插件组合必须能用；协议新增字段全部可选。
- 第五条：进 `spawn` 的值经 `sanitizeCommand`；POSIX 无 shell；新路由只接受坐标
  不接受任意路径；webview 消息字段做类型与长度截断；token/Cookie 不进日志。
- 第六条：判定逻辑抽纯函数挂 `module.exports.__internals`；插件路由可在假 ctx 下测试。
- 第七条：README / CHANGELOG / 版本号三处同步；发版需维护者确认。

- 配置开关：复用 `dshPanel.workspaceFileLinkAction`，新增枚举值 `diffAndOpen`
  （语义：定位 + 「P1 → P0 → L0」打开）。**默认值保持不变（`revealAndOpen`）**，
  由用户在 README 指引下主动切换。
- 安装时机：仅 `diffAndOpen` 时安装 `dsh-vscode-changes`；其它模式沿用 001 的安装规则。

## 8. 失败与提示

| 失败场景 | 用户可见提示（中文文案要点） | 出口动作 |
| --- | --- | --- |
| 新插件未安装/未重启 dsh（404 无 JSON 或 `unavailable`） | 「轮级对比需要重启 dsh web 后生效，已退回与 HEAD 对比」 | 命令面板「重启 dsh web」 |
| 会话已释放 / dsh 已重启（404 `released`） | 「该轮的对比数据已随会话释放，已退回与 HEAD 对比」 | 在 DSH 侧栏查看该轮 |
| 轮还没记录（轮未结束，404 `no-record`） | 「该轮还没有对比数据（可能尚未结束），已退回与 HEAD 对比」 | 无 |
| 清单里有但取不到两侧全文（shell 直接改动，`no-text`） | 「该轮的改动取不到全文（多为 shell 直接改动），已退回与 HEAD 对比」 | 无 |
| 本轮没改过该文件（`{matched:false}`） | 「本轮没有该文件的变更，已打开原文件」 | 无 |
| 二进制 / 单侧 > 1 MiB | 「文件过大或是二进制，无法并排对比，已打开原文件」 | 无 |
| 非 git 仓库且 P1 不可用 | 「当前工作区不是 Git 仓库，无法展示差异，已打开原文件」 | 初始化仓库 |
| 取数超时（6 s） | 无额外文案（回放原始点击，DSH 侧栏照旧打开） | 无 |
| 路径不匹配任何变更 | 无提示（走 P0 或 L0，避免噪音） | 无 |

## 9. 风险与开放问题

| 风险 / 未知 | 影响 | 应对 / 待验证 |
| --- | --- | --- |
| `ctx.workspaceChanges` 只有 `summary`/`diff`，`records` 读不到（**已实机确认**） | 初版 P1 全程 404 | 已改为自捕获两侧全文（公开钩子）+ `summary()` 权威清单；本插件对 dsh 的字段假设只剩这两个公开方法 |
| `fs/write-intent`/`fs/edit-intent` 只覆盖文件工具；shell 直接改动取不到全文 | 该文件退 P0（与 HEAD 对比） | 两个 intent 事件都已钩（2026-10-28 补齐 `edit`）；清单里标注 `no-text` 并给出专门文案，不误报「没变更」 |
| 会话 dispose 后记录消失（DSH 重启亦然） | 历史轮回到 P0 | 既定降级；**实测 dsh 自己的 `/api/changes.summary` 与 `/api/changes.diff` 对重启前会话同样 404**，非我方独有；P2 用 git 检查点补 |
| 客户端拿不到会话/轮坐标 | 只能走 P0 | AC-7 明确允许；按页面上现成的轮标记取值，取不到就不带。已加两条退路：会话服务属性优先、轮次取「前一个」标记行 |
| 同一工作区多个会话都改过同名文件 | 可能匹配到错轮 | 坐标必须带 `sessionId`，只在该会话记录里找 |
| `turn` 号与 `workspace/changes` 事件不是一对一（`turn-stopping`/`turn/end` 各一条） | 取到较旧的一条 | 插件内索引按 `turn` 取**最新** `seq` |
| 1 MiB 上限对超大单文件偏严 | 少部分文件看不到 diff | 上限常量集中一处，后续可配置 |
| 现有会话日志里未见 `workspace/changes` 事件（本机抽查 25 个会话） | 数据源可能不产生 | **已定位**：该插件只在 `dsh-web-app` bundle 里（`grep` 确认 acp/headless 都没有），旧日志是 ACP 会话产生的。web 会话仍待实机最终确认 |
| P2（`dsh-git-rollback` 检查点，重启后仍可看历史轮） | 未做 | 另立规格 006 |

## 10. 验证记录

| 日期 | 方式 | 结论 |
| --- | --- | --- |
| 2026-10-26 | `npm test`（14 套 / 482 项断言，含新增 `file-link-diff` 63 / `dsh-changes-plugin` 45） | 通过 |
| 2026-10-26 | `npm run test:all`（涉及 dsh 契约） | 通过（15 套，含真实 dsh e2e；顺手修了 e2e 清理用 `fuser -k <port>/tcp` 把测试进程自己也 SIGKILL、导致断言全过却判红的问题） |
| 2026-10-27 | 隔离实例实机排查（复制 profile 到 `.dsh-debug`，未动真实 `~/.dsh`） | **发现致命缺陷**：探针插件实测 `Object.keys(ctx.workspaceChanges) = ['summary','diff']`，初版读的 `records` 不存在 → P1 每次 404、轮级 diff 从未生效（单测因假 ctx 造了 `records` 而全绿） |
| 2026-10-27 | 修复后 `npm test`（14 套 / 490 项断言，`dsh-changes-plugin` 42 / `file-link-diff` 74） | 通过（`dsh-sidebar` 有 1 条 zoom 断言待随 1.0.3 回退更新，既有问题、与本规格无关） |
| 2026-10-27 | 隔离实例实机复验新插件（dsh 0.2.1-rc.2） | 插件正常激活（无 pending 告警）；路由返回 400 参数校验、404 `{"error":"released"}`、未登录 401（鉴权围栏完好） |
| 2026-10-28 | 经扩展认证代理直查用户实测会话（`session-2c83d9ea`，turn 1/2 均为 `write` 工具） | 服务端正确返回两侧全文（turn1 `before:absent`、turn2 新旧内容），延迟 15–25 ms → 断点不在服务端 |
| 2026-10-28 | 对照用户第 4 轮（`edit` 工具改 `.vscodeignore`） | 路由返回 `matched:true + unavailable:'no-text'` → **定位缺陷：只钩了 `fs/write-intent`，漏了 `edit` 工具的 `fs/edit-intent`**（dsh recorder 两个都钩） |
| 2026-10-28 | 重启前后对照（dsh 自家接口 vs 本插件路由，同一批老会话） | 双方对重启前会话都 404（`Change summary unavailable.` vs `{"error":"released"}`）→ 重启后失效是共同限制；DSH 页面仍显示的变更来自事件流内嵌 `tool/result` diffs |
| 2026-10-28 | 修复后 `npm test`（14 套 / 504 项断言，`dsh-changes-plugin` 45 / `file-link-client-sim` 46 / `file-link-diff` 74） | 通过（`dsh-sidebar` 1 条 zoom 断言为 1.0.3 回退后既有问题，与本规格无关） |
| 2026-10-28 | 真机定位坐标断点：用户在 Webview DevTools 观察到 `diffMode=false`；手动向宿主发 `hello` 抓到两条 ack：`{"fileLinks":true,"mode":"diffAndOpen","diff":true}` 与 `{"layout":true}` | **根因**：宿主同一 `ack` 类型发两种回执，客户端未区分 → 布局 ack 把 `diffMode` 覆盖成 `false` → 坐标永不发送 → 永远走 P0。已按字段区分并加回归断言（46 项） |
| 2026-10-28 | 实机确认（用户操作）：装 0.2.4 → Reload Window → 重启 dsh web → 点击会话里的文件链接 | **轮级 diff 正常显示**——此前所有「只剩原文」现象均由 ack 二义性导致。收尾 0.2.5：移除全部临时诊断（握手信标 / 逐条消息日志 / 点击诊断），功能代码与 0.2.4 一致 |
| 待验证 | 实机 F5（VS Code + dsh web，真实 web 轮） | 降级文案（`released` / `no-record` / `no-text`）与「重启后历史轮退 P0」的实机表现 |

## 11. 变更历史

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-10-26 | 初稿（P0+P1，P2 不做） | 用户确认范围 |
| 2026-10-26 | 状态 → implementing；补验证记录与数据源定位 | 代码与单测完成；`dsh-workspace-changes` 仅 web bundle 挂载已核实 |
| 2026-10-27 | **数据源勘误并修复 P1**：两侧全文改为插件用公开钩子（`fs/write-intent` + `turn/end`）自捕获，「本轮改了哪些文件」仍以 `summary()` 为准；404 拆成 `released`/`no-record`/`unavailable` 三种含义，新增 `no-text`（清单里有但取不到全文）；插件版本 0.1.0 → 0.2.0 | 实机排查发现 `ctx.workspaceChanges.records` 不存在，初版 P1 全程 404、轮级 diff 从未生效；功能需求不变（仍是「该轮开始 ↔ 结束」两侧全文并排 diff） |
| 2026-10-28 | **补钩 `fs/edit-intent`**（`edit` 工具用它，漏了会让「先建后编」的文件取不到 before）；**客户端坐标两条退路**（会话服务属性优先于 `ctx.get`、轮次退取文档中「前一个」标记行）；两个插件 0.2.0 → 0.2.1 | 用户实测：点击无任何提示且只剩原文件（P1 从未被调用）；服务端经认证代理实测正常，断点在客户端坐标提取 |
| 2026-10-28 | **修复 ack 二义性（真机根因）**：客户端把宿主的两条 `ack` 当同一种，侧栏布局那条（`{layout:true}`，无 `diff` 字段）把 `diffMode` 覆盖成 `false`，坐标从此永不发送、永远走 P0；改为按字段区分（只带 `layout` 的直接忽略），补 6 条回归断言。file-links 0.2.1 → 0.2.4 | 用户在 Webview DevTools 抓到连续两条 ack 的确凿证据；这解释了「该功能加入以来端到端从未生效」 |
| 2026-10-28 | **术语统一**：用户可见文案由「回合 N」改为「第 N 轮」（标题 `a.ts · 第 7 轮`），提示文案与 README/CHANGELOG/ARCHITECTURE/TESTING/AGENTS 同步改用「轮」；插件 `package.json` 描述一并更新 | 维护者要求：对外统一用「轮」 |
