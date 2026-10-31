# 规格 011：相对路径按 DSH 工作区解析 + 老会话链接仍可看变更

| 项 | 内容 |
| --- | --- |
| 编号 | 011 |
| 状态 | implemented（离线 21 套 / 992 项断言通过；`file-link-diff` 125、`dsh-changes-plugin` 64、`file-link-client-sim` 56、`workspace-file-link` 93） |
| 负责人 | @Vithrive |
| 关联 | 修复 [010](../010-out-of-workspace-file-link/spec.md) · 扩充 [005](../005-file-link-turn-diff/spec.md) · 目标版本 `1.0.7` |
| 创建 / 更新 | 2026-10-30 / 2026-10-30 |

## 1. 背景与问题

`1.0.7-dev.2` 实机验证暴露两个问题：

**问题一：相对路径被按 VS Code 文件夹解析，指到了同名的别处文件。**

DSH 对话里的链接如果是相对路径（`src/a.ts`），语义是「相对 DSH 当前会话的工作目录」。
宿主此前把相对路径对**每个 VS Code 工作区文件夹**各拼一次（`<vscodeRoot>/src/a.ts`）——
碰巧存在同名文件时就会定位/打开/对比**另一个文件**，用户看到「定位到 VS Code 里、路径不对」；
不存在时才落到工作区分支。DSH 工作区与 VS Code 文件夹不一致时（`pinWorkspaceToVSCode`
关闭、或在 DSH 里手动换了工作区），这条错误路径是常态。

**问题二：老会话（本版之前创建、或在其上继续提问）里点链接几乎都开 DSH 侧栏。**

工作区外文件只能靠轮级数据出 diff（规格 010）。而轮级取数依赖两个坐标：

- `turn`：客户端从对话 DOM 的 `data-chat-turn` 读。**历史消息（页面从会话记录恢复的）常常
  没有这个标记**，`nearestTurnBefore()` 也找不到 → 不携带坐标 → 宿主只能回 `ok:false`。
- 该轮的记录：`turn/start` 之后由 `dsh-vscode-changes` 捕获，**dsh web 重启前的老轮没有**。

于是「只有当前 webview 里刚流式生成的消息 » 偶尔成功」，其余全部退化成 DSH 侧栏。

## 2. 目标

- 相对路径一律按 **DSH 当前会话的 cwd** 解析；拿不到 cwd 时才退回「对每个 VS Code 文件夹各试」。
- 链接没有轮坐标、或该轮没有记录时，不再直接放弃：改为让 DSH 插件回答
  「**这个文件在本会话里最后一次被改动是哪一轮**」，用那一轮的两侧全文出 diff，并在标题/提示里
  写明实际轮次。
- 失败仍可见、可诊断：客户端保留最近若干次点击的环形日志（`__dshVscodeFileLinks.log()`）。
- 工作区内链接的既有三级降级、`revealAndOpen`/`revealOnly` 的工作区边界不变。

## 3. 非目标

- 不猜轮：`latest` 由 DSH 插件按「已记录清单」算出，客户端与宿主都不做推算。
- 不给工作区外文件做 P0（`HEAD` ↔ 工作树）：读盘边界仍限工作区内（宪法第五条）。
- 不改 DSH 页面 DOM、不注入样式；cwd 只从 DSH 公开客户端服务读。

## 4. 用户故事

- 作为 **VS Code 用户**，我在 DSH 里换过工作区时，点相对路径链接应打开**那个**文件，
  而不是 VS Code 里恰好同名的另一个。
- 作为 **VS Code 用户**，我打开几天前的会话、或在其上继续提问后点链接，也应该看到变更，
  而不是每次都被丢回 DSH 侧栏。

## 5. 验收标准（必须可执行）

- **AC-1**：Given 链接是相对路径 `src/a.ts`、DSH 会话 cwd=`/w/other`、VS Code 打开 `/w/proj`
  且 `/w/proj/src/a.ts` 存在，When 点击，Then **不**按 `/w/proj` 解析：
  在 `diffAndOpen` 下按 `/w/other/src/a.ts` 取轮级变更；在 `revealAndOpen` 下回执 `ok:false`
  （不在工作区内）并提示。（断言：`resolveWorkspaceTarget('src/a.ts', '/w/other')` 为 null；
  且 `candidateLinkUris` 在给了 cwd 时只产出 cwd 候选）
- **AC-2**：Given 给了 cwd 且该路径确实在 VS Code 工作区内（cwd 与文件夹一致或 cwd 在其下），
  When 点击，Then 照常定位 + 打开/diff（行为与 010 一致）。
- **AC-3**：Given 客户端拿不到 cwd（老版 dsh 无 `sessions` 服务），When 点击，Then 退回
  「对每个 VS Code 文件夹各试」的旧行为，不报错。
- **AC-4**：Given 消息没有轮标记（历史消息），但能取到 `sessionId`，When 点击工作区外链接，
  Then 客户端发 `change = {sessionId, latest:true}`，宿主向路由请求 `turn=latest`，
  插件在该会话记录里找**这个文件最后一次被改动**的轮并回两侧全文；标题写实际轮次，
  状态栏提示「已展示本会话最近一次改动（第 N 轮）」。
- **AC-5**：Given 指定的轮在该会话里没有这个文件的变更记录（`matched:false`），When 点击，
  Then 再按 `latest` 查一次；命中即展示（同上一条的提示），仍未命中才回 `ok:false` 交回 DSH 侧栏。
- **AC-6**：Given 该会话在 `dsh-vscode-changes` 里完全没有记录（重启 dsh web 后的老会话），
  When 点击，Then 路由回 `404 no-record`，宿主回 `ok:false`（DSH 侧栏），提示说明原因与出路。
- **AC-7**：Given 路由收到 `turn=latest`，When 匹配，Then **仍然只按已记录清单**匹配，
  绝不按请求路径读盘；`turn` 缺省且非 `latest` 时仍回 400。
- **AC-8**：Given 任意点击，Then 客户端把 `{path, cwd, change, result}` 记入定长环形日志
  （≤ 20 条，`__dshVscodeFileLinks.log()` 可读、`.clear()` 可清），不写磁盘、不包含文件内容。
- **AC-9**：Given 工作区内链接 / `revealAndOpen` / `revealOnly` / `off`，
  Then 既有断言保持通过（010/005 行为不倒退）。

## 6. 兼容矩阵

| 场景 | 新版 dsh（≥0.2.1，带 `sessions`/`workspaceChanges`） | 旧版 dsh | 说明 |
| --- | --- | --- | --- |
| Windows 本地 | cwd 解析 + `latest` 兜底 | 退回 VS Code 根解析 | `D:\` 写法先归一化 |
| macOS 本地 | 同上 | 同上 | 无平台分支 |
| Linux 本地 | 同上 | 同上 | — |
| Remote（WSL/SSH/容器） | 同上（DSH 与扩展同侧） | 同上 | cwd 是服务端路径 |
| 独立浏览器打开 DSH | 不接管 | 不接管 | 沿用 001 |

## 7. 约束（引用宪法）

- 第五条：`latest` 仍只在**已记录的清单**里找，不新增读盘；工作区外不做 P0。
- 第三条：`latest` 命中必须让用户知道「这不是你点的那一轮」，否则只 `console.log` 不允许。
- 第四条：老 dsh 无 `sessions` 服务 → 无 cwd → 退回旧解析；无 `workspaceChanges` → 404
  `unavailable`，一切照旧降级。
- 第六条：新纯函数（`sameOrigin`… 不适用）与判定逻辑进 `__internals` 可离线测。

## 8. 失败与提示

| 失败场景 | 用户可见提示（中文文案要点） | 出口动作 |
| --- | --- | --- |
| 会话里没有该文件的任何记录 | 「…已在 DSH 侧栏打开」 | 侧栏查看 |
| 展示的是最近一次改动而非点击的轮 | 「该链接没有轮次信息 / 该轮没有它的变更，已展示本会话最近一次改动（第 N 轮）」 | 无 |
| 拿不到会话 cwd | 无额外提示（退回旧解析） | 无 |

## 9. 风险与开放问题

| 风险 / 未知 | 影响 | 应对 / 待验证 |
| --- | --- | --- |
| `sessions.list` 的 `cwd` 与 DSH 渲染链接用的基准不一致 | 解析偏一个目录 | 与 `dsh-vscode-workspace` 用同一来源（该能力已在真机验证）；不一致时仍可回退 |
| 历史消息确实没有 `data-chat-turn` | 轮坐标只能靠 `latest` | AC-4/AC-5 即为此设计；`latest` 由插件算，不猜 |
| `latest` 选中「别的轮」被误读成点击轮 | 误导 | 标题写实际轮次 + 状态栏明说「最近一次改动」 |

## 10. 验证记录

| 日期 | 方式 | 结论 |
| --- | --- | --- |
| 2026-10-30 | `npm test`（21 套 / 981 项断言） | 通过。先红后绿：`latest` 命中 / `latest` 坐标透传 / cwd 基准解析 / 中继透传 cwd 四条断言依次转绿 |
| 待验证 | 实机 F5：DSH 工作区≠VS Code 文件夹时点相对链接；老会话（无轮标记）点链接 | 待用户用 dev 包验证 |

## 11. 变更历史

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-10-30 | 初稿 | dev.2 实机：相对路径指到 VS Code 同名文件；老会话链接几乎全退侧栏 |
| 2026-10-30 | 实现并转 implemented；补「反推相对 cwd」候选 | 先红后绿时发现：点击给绝对路径、记录给 `../x` 时仍匹配不到 |
| 2026-10-30 | **真机复验后补三处**：① 路由匹配不到 `summary` 时按**自捕获记录**兜底（DSH 的 `workspace/changes` 只统计工作区，工作区外文件常常不在清单里——这是「工作区外必失败」的主因）；② 宿主换 latest 的原因集扩到 `no-record`/`no-text`（DOM 轮号与事件轮号可能不同源）；③ 失败回执带 `reason`，页面日志可看到断点 | 用户 `__dshVscodeFileLinks.log()` 复现：工作区内 `ok`、工作区外全部 `failed` |
