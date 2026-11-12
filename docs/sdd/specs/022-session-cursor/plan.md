# 技术方案 022：会话历史游标（新语义优先）

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：implemented） |
| 负责人 | @Vithrive |
| 更新 | 2026-11-12 |

## 1. 方案概述

```
fetchSessionHistory(base, sid)
  └ fetchSessionHistoryWith(rpc, base, sid)      // rpc 可注入（测试）
      1) session/page { address, maxMessages }  // 省略 throughSeq = 最新尾部
         └ 有 records → { events }              // 记 page-tail / cursor / n
      2) 回退：session/page { throughSeq: MAX }  // 越界探测
         ├ 报 past cursor N                    → N
         └ 报 session history cut N exceeds M   → M
         └ cursor < 0 → { events: [] }           // 空会话
         └ session/page { throughSeq: cursor } → { events }   // 记 page-probe
      3) 回退：session/history { sessionId }    // 老 dsh，记 legacy
```

## 2. 影响面

| 文件 / 函数 | 改动 | 对应 AC |
| --- | --- | --- |
| `extension.js` `fetchSessionHistory`：改为委托 `fetchSessionHistoryWith(dshRpc, …)` | 修改 | AC-1..AC-5 |
| `extension.js` 新增 `sessionCursorFromError` / `noteHistoryPath` / `historyPathSeen` | 新增 | AC-3、AC-6 |
| `test/session-history.test.js` 新增套件（21 条） | 新增 | 全部 |
| `test/e2e-real-dsh.test.js` 游标步骤改为新语义 | 修改 | AC-1 |
| `docs/CONSTITUTION.md` 第一条：允许内置插件调用 DSH 公开客户端服务（不改 DOM） | 修改 | — |

## 3. 契约与回退

| 契约 | 新形态 | 回退 |
| --- | --- | --- |
| `session/page` 入参 | 省略 `throughSeq` | 带 `throughSeq`（旧 dsh 必填） |
| 越界文案 | `session history cut N exceeds M` | `past cursor N` |
| 返回体 | `{cursor, records, hasMore}` | `{records}` / `session.history` |

## 4. 安全

- [x] 只读请求；`sid` 来自既有会话，无新增外部输入。
- [x] 日志只记 sid 前 12 字符 + 数值，沿用 018 脱敏。

## 5. 测试策略

| 层 | 断言 |
| --- | --- |
| 纯函数 | `sessionCursorFromError` 两代文案、无法解析、空输入 |
| 注入 RPC | 新语义单次调用、旧探测三步、0.2.2 文案、空会话、legacy 兜底 |
| 日志 | 开启落盘后 `[history] path=page-tail …`，同会话不重复 |

## 6. 回退方案

- 代码：`fetchSessionHistoryWith` 只保留旧探测分支即回到 0.2.1 行为。
- 功能：无用户开关（历史拉取是桥接内部路径），失败已有可见提示。

## 7. 被否方案

| 方案 | 否决原因 |
| --- | --- |
| 只把正则改成两代都认 | 仍依赖错误文案做控制流，dsh 再改一次还会坏 |
| 只走新语义、删旧探测 | 旧 dsh（0.1.2-rc.x ~ 0.2.1）要求显式 `throughSeq`，会直接坏 |
| 缓存游标跨轮次 | 多标签/多会话下不可靠，且不是本次故障点 |
