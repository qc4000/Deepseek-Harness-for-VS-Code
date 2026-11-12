# 任务清单 019：事件流自动落盘

> 顺序：`[test]` → `[impl]`；单项 ≤ 半个工作日。

## 阶段 1 · 中继事件流

- [x] `[impl]` `buildIframeHtml` 第 6 参 `debugFile`（缺省读设置）注入 `debugFileLog`
      —— 判据：关闭时恒 false，不建队列
- [x] `[impl]` `traceQueue/traceFlush`（1s 批量、200 上限、关闭即返回）+ `dsh-debug-log-file` 热切换
      —— 判据：关闭零定时器零消息
- [x] `[test]` `[21]` 关闭不产生消息、开启 1s 批量含 layout、单包 200 上限、热开关
      —— 判据：红→绿

## 阶段 2 · 扩展落盘

- [x] `[impl]` 抽取 `normalizeDiagEntries`（与诊断包共用净化）+ `diagClock`
- [x] `[impl]` `dsh-sidebar-trace` 分支：一包一次追加（`[sidebar-trace]`），关闭时立即返回
- [x] `[impl]` `onDebugLogSettingChanged` 热推 `dsh-debug-log-file` + 写 `[env]`（zoomLevel/字号/fontScale）
- [x] `[test]` `[21]` 落盘行、净化、env 行 —— 判据：红→绿

## 阶段 3 · 验证与文档

- [x] `[test]` `TMPDIR=/tmp npm run test:one -- dsh-sidebar` → `TMPDIR=/tmp npm test` 全绿
- [x] `[test]` 性能微基准：关闭 0.27 µs/包（且中继不发）、开启 471 µs/包且 ≤1 包/秒
- [x] `[docs]` README（文件已自足，不必再导出）、ARCHITECTURE（事件流一段）
- [x] `[docs]` TESTING 地图（断言数 + 019 覆盖）、AGENTS 断言数
- [x] `[docs]` 019 验证记录回填

## 阶段 4 · 发布（需维护者确认，不自动执行）

- [ ] `[docs]` `CHANGELOG.md` 顶部小节
- [ ] `[impl]` `package.json` 版本号提升
- [ ] `[impl]` 打 tag `v<版本>`

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 | 阶段 1 | `dsh-sidebar.test.js` `[21]` |
| AC-2 | 阶段 1/2 | 同上 |
| AC-3 | 阶段 1 | 同上 |
| AC-4 | 阶段 1/2 | 同上 |
| AC-5 | 阶段 2 | 同上 |
| AC-6 | 阶段 2 | 同上 |
