# 任务清单 022：会话历史游标（新语义优先）

## 阶段 1 · 实现

- [x] `[impl]` `sessionCursorFromError`：识别 `past cursor N` 与 `session history cut N exceeds M`
- [x] `[impl]` `fetchSessionHistoryWith(rpc, base, sid)`：新语义（省略 throughSeq）→ 旧探测 → legacy 兜底
- [x] `[impl]` `noteHistoryPath`：`[history] path=… sid=… cursor=… n=…`，每会话每种路径一条
- [x] `[impl]` `fetchSessionHistory` 委托注入版；`__internals` 导出（含 `sessionCursorFromError`）

## 阶段 2 · 测试

- [x] `[test]` 新增 `test/session-history.test.js`：21 条（两代文案、新语义单次调用、旧探测三步、
      0.2.2 文案、空会话、legacy 兜底、日志留痕不重复）
- [x] `[test]` `test/e2e-real-dsh.test.js`：游标步骤改用新语义（省略 throughSeq + 断言返回 cursor）
- [x] `[test]` `TMPDIR=/tmp npm test` → 23 套 / 1279 项断言全绿

## 阶段 3 · 文档

- [x] `[docs]` 宪法第一条：允许内置插件调用 DSH 公开客户端服务（不改 DOM），其余不变
- [x] `[docs]` ARCHITECTURE 契约表：`session/page` 新旧语义
- [x] `[docs]` TESTING 地图 + 套件/断言数；AGENTS 计数
- [x] `[docs]` 022 验证记录

## 阶段 4 · 发布（需确认）

- [ ] `CHANGELOG` + 版本号（建议 1.1.2）+ tag
