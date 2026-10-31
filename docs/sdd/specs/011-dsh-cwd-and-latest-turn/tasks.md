# 任务清单 011：相对路径按 DSH 工作区解析 + 老会话链接仍可看变更

## 阶段 1 · 路由侧（latest）

- [x] `[test]` `dsh-changes-plugin.test.js`：`turn=latest` 命中最新改动 / 未改动 `matched:false` / 未知会话 404 / 缺 turn 非 latest 400 / still-needs-path —— 判据：红
- [x] `[impl]` `latestTurnOf()` + `handle()` 支持 `turn=latest`（回实际 `turn` + `latest:true`）—— 判据：绿
- [x] `[impl]` 插件版本 `0.2.4 → 0.2.5`

## 阶段 2 · 客户端侧（cwd / latest / 诊断）

- [x] `[test]` `file-link-client-sim.test.js`：无轮标记改发 latest、cwd 上报/缺失、诊断日志 —— 判据：先改断言（红）
- [x] `[impl]` `currentSessionCwd()` + `requestReveal` 带 `cwd`
- [x] `[impl]` `coordsOf()` 退化为 `{sessionId, latest:true}`（不再直接放弃）
- [x] `[impl]` 诊断环形日志 `__dshVscodeFileLinks.log()/.clear()/.cwd()`
- [x] `[impl]` 插件版本 `0.2.5 → 0.2.6`

## 阶段 3 · 宿主侧（解析 + 尝试链）

- [x] `[test]` `workspace-file-link.test.js`：cwd 基准解析 / 空或非法 cwd 退回 / 中继透传 cwd+latest —— 判据：红→绿
- [x] `[impl]` 中继透传 `cwd`、接受 `change.latest`
- [x] `[impl]` `candidateLinkUris`/`resolveWorkspaceTarget` 支持 cwd 基准
- [x] `[impl]` `sanitizeChangeCoord`/`fetchTurnChange`/`parseTurnChangeResponse` 支持 latest
- [x] `[test]` `file-link-diff.test.js`：latest 直达、指定轮无变更→latest、cwd 绝对候选、不可用不重试 —— 判据：红→绿
- [x] `[impl]` `openOutOfWorkspaceDiff` 尝试链 + `notifyLatestHit`
- [x] `[impl]` 新函数挂 `__internals`（`absoluteFromCwd`、`candidateLinkUris`）

## 阶段 4 · 文档与发布

- [x] `[docs]` `README.md`：相对路径基准、latest 兜底、排障入口 `__dshVscodeFileLinks.log()`
- [x] `[docs]` `docs/ARCHITECTURE.md`：消息协议补 `cwd` / `change.latest`，路由补 `turn=latest`
- [x] `[docs]` `docs/TESTING.md`：断言数更新（121 / 59 / 55 / 92）
- [x] `[docs]` `CHANGELOG.md`：1.0.7 小节补这两条修复
- [ ] `[impl]` `package.json` 版本号与 tag —— **需维护者确认后执行**
- [x] `[docs]` spec 状态改 `implemented`，补验证记录

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 / AC-2 / AC-3 | 阶段 3 | `workspace-file-link.test.js` |
| AC-4 / AC-5 | 阶段 1 / 2 / 3 | `dsh-changes-plugin.test.js`、`file-link-diff.test.js`、`file-link-client-sim.test.js` |
| AC-6 / AC-7 | 阶段 1 | `dsh-changes-plugin.test.js` |
| AC-8 | 阶段 2 | `file-link-client-sim.test.js` |
| AC-9 | 全部 | 既有 21 套断言不减少 |

## 例外与决策记录

- 工作区内链接暂不追加「该轮无变更 → latest」重试：那里还有 P0（HEAD 对比）兜底，
  先不动 005 的三级降级；若实机也需要，另立规格。
