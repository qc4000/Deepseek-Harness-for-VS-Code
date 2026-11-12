# 任务清单 017：抽屉态手动显隐落到宿主覆盖

> 顺序：`[test]` → `[impl]`；单项 ≤ 半个工作日。

## 阶段 1 · 复现与修复（先红后绿）

- [x] `[test]` `[19]` 新增复现序列：抽屉态点「显示」→ 拉宽到 900/1200 → 仍不裁剪、标签保持「隐藏」
      —— 判据：旧实现下**红**（auto 重新裁剪，crop=56）
- [x] `[test]` `[19]` 反向：抽屉态点「隐藏」→ 写覆盖 `hidden=true` → 拉宽后按意图裁剪（crop=56）
      —— 判据：旧实现下红（旧实现不写覆盖，拉宽后 auto 行为相同但无持久意图）
- [x] `[test]` `[10]` 原「抽屉态不写手动覆盖」断言改向：断言点击后恰好一条 `dsh-sidebar-state{hidden:false}`
      —— 判据：旧实现下红（不发该消息）
- [x] `[impl]` `toggleSidebarNow()` 抽屉分支先 `setHidden(!measured.collapsed, reason)` 再发 `layout-toggle`
      —— 判据：上述断言变绿，且每条点击仍只发一条 `layout-toggle`

## 阶段 2 · 回归与文档

- [x] `[test]` `TMPDIR=/tmp npm run test:one -- dsh-sidebar` 全绿（含 015/016 既有项）→ `TMPDIR=/tmp npm test` 全量绿
      —— 判据：输出「全部通过：N 项断言 ✓」
- [x] `[docs]` `015/spec.md` AC-3 修订（「不写覆盖」→「同时写覆盖」）+ 变更历史；`015/plan.md` 状态表行同步
- [x] `[docs]` `docs/ARCHITECTURE.md` §3 一句（抽屉态点击同时写覆盖）；`README.md` 手动切换说明补充
- [x] `[docs]` `docs/TESTING.md` 测试地图 `dsh-sidebar.test.js` 行更新（断言数 + 017 覆盖）
- [x] `[docs]` 017 `spec.md` 验证记录回填（套件 + 断言数 + 实机待补）

## 阶段 3 · 发布（需维护者确认，不自动执行）

- [ ] `[docs]` `CHANGELOG.md` 顶部小节
- [ ] `[impl]` `package.json` 版本号提升（与 CHANGELOG 一致）
- [ ] `[impl]` 打 tag `v<版本>` 并确认 Release 工作流绿

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 | 阶段 1 | `dsh-sidebar.test.js` `[19]` |
| AC-2 | 阶段 1 | `dsh-sidebar.test.js` `[19]` |
| AC-3 | 阶段 1/2 | `dsh-sidebar.test.js` `[9]-[16]` 既有 |
| AC-4 | 阶段 1 | `dsh-sidebar.test.js` `[19]`（去抖后仍按覆盖） |
| AC-5 | 阶段 1 | `dsh-sidebar.test.js` `[19]`（拉回抽屉态 crop 仍 0） |
