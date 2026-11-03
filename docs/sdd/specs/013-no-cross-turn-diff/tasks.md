# 任务清单 013：拿不到点击所属轮时不再跨轮展示变更

## 阶段 1 · 先红：4 套件按新语义改断言

- [x] `[test]` `file-link-client-sim.test.js`：无轮标记 → `reveal.change === undefined`（不再发 latest）、全无标记同样不带坐标 —— 判据：红
- [x] `[test]` `workspace-file-link.test.js`：中继脚本不含 `change.latest === true`、仍透传具体轮次 —— 判据：红
- [x] `[test]` `file-link-diff.test.js`：`sanitizeChangeCoord({latest:true}) === null`；latest 坐标零查询走 P0；`openOutOfWorkspaceDiff` 全程只查点击所属轮（no-change / no-record 都不换轮）—— 判据：红
- [x] `[test]` `dsh-changes-plugin.test.js`：`turn=latest → 400`（含未知会话、缺 path）；具体轮次照常出数 —— 判据：红

## 阶段 2 · 后绿：三处实现

- [x] `[impl]` `client.js` `coordsOf()` 无轮次返回 null；`PLUGIN_VERSION 0.2.7 → 0.2.8`；`package.json` 同步
- [x] `[impl]` 中继只透传具体轮次（丢弃 `change.latest`）
- [x] `[impl]` 宿主：`sanitizeChangeCoord` 拒绝 latest、`fetchTurnChange` 只拼具体轮次、`parseTurnChangeResponse` 去 latest 字段、删 `notifyLatestHit`、`notifyDiffFallback(reason)` 单参、`openOutOfWorkspaceDiff` 单坐标按写法重试
- [x] `[impl]` `dsh-vscode-changes` 删 `turn=latest` 与 `latestTurnOf`；`0.2.6 → 0.2.7`
- [x] `[impl]` 新函数/改动挂 `__internals`（既有导出不减少）

## 阶段 3 · 验证

- [x] `[test]` `npm run test:one -- file-link` 与 `npm run test:one -- dsh-changes-plugin` 转绿
- [x] `[test]` `npm test` 全绿（记录套件数 / 断言数）
- [x] `[test]` `npm run test:all`（涉及 dsh 契约的路由改动）—— 22 套 / 1008 项全绿（e2e 需 `DSH_HOME` 指向可写目录）
- [ ] `[impl]` 实机 F5：老会话续问后点先前轮次链接，不得出现「第 N 轮」轮级 diff —— 待用户验证

## 阶段 4 · 文档

- [x] `[docs]` `docs/sdd/specs/011-*/spec.md`：AC-4/AC-5/AC-7 标注被 013 取代，变更历史补行
- [x] `[docs]` `docs/ARCHITECTURE.md`：消息协议去掉 `change.latest`、路由去掉 `turn=latest`
- [x] `[docs]` `README.md`：文件链接行为说明同步（无轮标记 → 按 005 降级）
- [x] `[docs]` `docs/TESTING.md`：4 套件描述与断言数更新
- [x] `[docs]` `CHANGELOG.md`：未发布小节记录本修复
- [x] `[docs]` spec 013 状态改 `implemented`，补验证记录
- [ ] `[impl]` 扩展 `package.json` 版本号与 tag —— **需维护者确认后执行**

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 | 阶段 1 / 2 | `file-link-client-sim.test.js`、`file-link-diff.test.js` |
| AC-2 | 阶段 1 保持项 | `file-link-diff.test.js`、`dsh-changes-plugin.test.js` |
| AC-3 | 阶段 1 / 2 | `file-link-diff.test.js` |
| AC-4 | 阶段 1 / 2 | `workspace-file-link.test.js` |
| AC-5 | 阶段 1 / 2 | `dsh-changes-plugin.test.js` |
| AC-6 / AC-7 | 保持项 | 既有 21 套断言不减少 |

## 例外与决策记录

- 保留 005 的 P0（HEAD 对比）降级：无坐标点击仍可能打开「与 HEAD 的差异」，这是 005 AC-7 的既定行为，
  本次只删除「展示别的轮」的出口（用户 2026-11-02 确认：按之前 spec 的降级来）。
- `isRetryableChangeReason` 保留 `no-record`/`no-text`（坐标链删除后仍用于「换一种写法可能命中」）。
