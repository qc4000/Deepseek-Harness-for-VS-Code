# 规格 022：会话历史游标改用 dsh 0.2.2 新语义（修 Copilot 桥接回放失败）

| 项 | 内容 |
| --- | --- |
| 编号 | 022 |
| 状态 | implemented |
| 负责人 | @Vithrive |
| 关联 | [spec 014（外链）](../014-external-link-open/spec.md) · dsh 0.2.2 契约变更 |
| 创建 / 更新 | 2026-11-12 / 2026-11-12 |

## 1. 背景与问题

Copilot 桥接靠 `session/page` 轮询会话历史做流式回写。旧实现是「两步游标」：

1. 故意用 `throughSeq = Number.MAX_SAFE_INTEGER` 越界探测；
2. 从报错文案里解析当前游标：正则 `/past cursor (-?\d+)/`；
3. 再按该游标取尾部一页。

dsh **0.2.2** 把文案改成 `session history cut <cursor> exceeds <observation.cursor>`
（`gateway/bad-request`），`past cursor` 已从 dsh 中消失。于是探测解析失败 →
`fetchSessionHistory` 抛错 → 桥接在「读取 DSH 任务状态」处报错并结束本轮
（`replayDshAnswer` 那条路径则静默 return）。

同时 0.2.2 的 `session/page` 已支持**省略 `throughSeq`**：语义是「到最新游标为止的尾部一页」，
返回体自带 `{ cursor, records, hasMore }`（见 dsh `dsh-api-session-controller` 的 `history()`）。
即：新版本根本不需要「从报错里读游标」。

## 2. 目标

- 新语义优先：`session/page` 不带 `throughSeq` 取尾部一页，直接读 `records`/`cursor`，**不依赖错误文案**。
- 旧语义回退：新语义失败时，按旧法越界探测，并**同时识别两代文案**
  （`past cursor N` 与 `session history cut N exceeds M`）。
- 兜底：两者都不可用时回落老版本 `session.history {sessionId}`（015 之前的行为）。
- 新增调试留痕：每次会话记录「走了哪条路径、游标、条数」，同一会话同一路径只写一条（避免轮询刷日志）。
- 不改调用方（`replayDshAnswer` / 桥接轮询）的语义，只修数据来源。

## 3. 非目标

- 不改 `session/prompt`、事件回写、`applyDshEvents`。
- 不引入新的 dsh 依赖；不改 e2e 的其它步骤（只把游标探测改成新语义）。
- 不做「历史增量缓存」等优化。

## 4. 用户故事

- 作为 **Copilot 用户**，我希望在 dsh 0.2.2 上把 DSH 当模型用时能正常拿到回答（不再「读取任务状态失败」）。
- 作为 **维护者**，我希望日志里能看出这次历史是走新语义还是旧探测、游标是多少。

## 5. 验收标准（必须可执行）

- **AC-1（新语义优先）**：Given `session/page` 对「不带 throughSeq」的调用返回
  `{cursor:41, records:[…]}`，When 拉历史，Then 只发 **1 次** RPC、不传 `throughSeq`、
  `records` 归一化为 `{events}`（解包 `{event}`）。
- **AC-2（旧语义回退 + 旧文案）**：Given 新语义调用失败、探测报 `past cursor 41`，
  Then 第二次用 `MAX_SAFE_INTEGER` 探测、第三次带 `throughSeq=41` 取尾部。
- **AC-3（0.2.2 文案）**：Given 探测报 `session history cut 9007199254740991 exceeds 17`，
  Then 解析出 **17**（第二个数字才是当前游标）。
- **AC-4（空会话）**：Given 探测报 `past cursor -1`，Then 返回 `{events:[]}`，不抛错。
- **AC-5（老 dsh 兜底）**：Given `session.page` 两次都失败且文案不含游标，
  Then 回落 `session.history {sessionId}` 并原样返回。
- **AC-6（留痕）**：Given 开启 `debugLogToFile`，When 新语义成功一次，
  Then 日志出现 `[history] path=page-tail sid=… cursor=41 n=…`；同会话再次成功不重复写。

## 6. 兼容矩阵

| dsh 版本 | 走的路径 | 依据 |
| --- | --- | --- |
| 0.2.2+ | `page-tail`（省略 `throughSeq`） | 返回体自带 cursor |
| 0.1.2-rc.x ~ 0.2.1 | `page-probe`（`past cursor N`） | 旧文案 |
| 0.2.2 但新语义偶发失败 | `page-probe`（`session history cut … exceeds N`） | 双文案解析 |
| 0.1.x 早期 | `legacy`（`session.history`） | 端点不存在 |

## 7. 约束（引用宪法）

- 第三条：失败由桥接层给出可见提示（`⚠️ 读取 DSH 任务状态失败：…`），并用日志留痕。
- 第五条：三代契约都有回退路径，旧 dsh 行为不变。
- 第六条：AC-1..AC-6 全部离线可测（RPC 注入 + 假响应）。

## 8. 失败与提示

| 失败场景 | 行为 | 出口 |
| --- | --- | --- |
| 新语义 + 旧探测都失败、文案无游标 | 回落 `session.history` | 老 dsh 正常路径 |
| 全部失败 | 抛错给调用方 → 桥接提示「读取 DSH 任务状态失败：…」 | 去 DSH 面板查看 |
| 会话不存在 | 探测文案无法解析 → 回落 → 报错透出 | 同上 |

## 9. 风险与开放问题

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 旧语义下 `page-tail` 若被老 dsh 接受但语义不同 | 尾部页可能为空 | 仅当返回 `records` 数组才采信；否则回退 |
| 日志过量 | 轮询每 1.5s 一次 | 每会话每路径只写一条 + 64 条上限 |

## 10. 验证记录

| 日期 | 方式 | 结论 |
| --- | --- | --- |
| 2026-11-12 | 定位依据 | dsh 0.2.2 源码 `history()` 文案 = `session history cut N exceeds M`；`past cursor` 全仓已无 |
| 2026-11-12 | `test/session-history.test.js`（新增套件） | 通过：21 项断言（AC-1..AC-6） |
| 2026-11-12 | `TMPDIR=/tmp npm test` | 通过：23 套 / 1279 项断言 |
| 2026-11-12 | `DSH_HOME=/tmp/dsh-e2e TMPDIR=/tmp npm run test:all`（真实 dsh 0.2.2） | 通过：24 套（含 e2e）/ 1279 项断言——e2e 的 `session/page` 步骤原本必红，现已转绿 |

## 11. 变更历史

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-11-12 | 初稿 + 实现：新语义优先、双文案旧探测回退、legacy 兜底、`[history]` 留痕 | dsh 0.2.2 改了越界文案，桥接在 0.2.2 上拉不到历史 |
