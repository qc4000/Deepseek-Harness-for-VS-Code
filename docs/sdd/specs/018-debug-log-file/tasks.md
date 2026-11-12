# 任务清单 018：调试日志落盘

> 顺序：`[test]` → `[impl]`；单项 ≤ 半个工作日。

## 阶段 1 · 落盘件与开关

- [x] `[impl]` `package.json`：配置项 `dshPanel.debugLogToFile`（boolean，默认 false）+ 命令
      `dshPanel.openDebugLog` —— 判据：贡献点存在，默认关闭
- [x] `[impl]` `debugLogPath/scrubDebugText/ensureDebugLog/rotateDebugLog/debugLog/resetDebugLogState`
      —— 判据：路径固定 `<homedir>/.dsh-debug/dsh-vscode-debug.log`，超 2MB 轮转，脱敏生效
- [x] `[test]` `[20]` 默认关闭不建文件 + 配置项默认 false —— 判据：红→绿
- [x] `[test]` `[20]` 开启后诊断包落盘 + 首次提示含路径 —— 判据：红→绿
- [x] `[test]` `[20]` token 脱敏、2MB 轮转、命令打开/指引、不可写降级 —— 判据：红→绿
- [x] `[impl]` 接线：诊断包（`writeSidebarDiag`/`Missing`）、`sidebar-state`、策略变更、诊断命令、
      插件安装变化、激活版本 —— 判据：日志文件里能看到对应 `[tag]`

## 阶段 2 · 验证与文档

- [x] `[test]` 变异红验证（临时禁用 `debugLogEnabled` → 「开启后生成日志文件」失败）→ 恢复
      —— 判据：断言确实依赖功能
- [x] `[test]` `TMPDIR=/tmp npm run test:one -- dsh-sidebar` → `TMPDIR=/tmp npm test` 全绿
- [x] `[docs]` `README.md` 配置表 + 排查说明（设置 + 命令）
- [x] `[docs]` `docs/ARCHITECTURE.md` 诊断段补「可选落盘」
- [x] `[docs]` `docs/TESTING.md` 测试地图（断言数 + 018 覆盖）
- [x] `[docs]` 018 `spec.md` 验证记录回填

## 阶段 3 · 发布（需维护者确认，不自动执行）

- [ ] `[docs]` `CHANGELOG.md` 顶部小节
- [ ] `[impl]` `package.json` 版本号提升（与 CHANGELOG 一致）
- [ ] `[impl]` 打 tag `v<版本>`

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 | 阶段 1 | `dsh-sidebar.test.js` `[20]` |
| AC-2 | 阶段 1 | 同上 |
| AC-3 | 阶段 1 | 同上 |
| AC-4 | 阶段 1 | 同上 |
| AC-5 | 阶段 1 | 同上 |
| AC-6 | 阶段 1 | 同上 |
