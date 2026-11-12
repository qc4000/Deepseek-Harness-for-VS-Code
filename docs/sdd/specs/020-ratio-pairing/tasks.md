# 任务清单 020：比例按请求-应答配对采信

## 阶段 1 · 中继

- [x] `[impl]` `pickRatio` 只接受「应答 + stage 未变」的样本；其它一律沿用上次可信值
- [x] `[impl]` `maybeRequestCalibration()`（未校准时请求、500ms 限流、抽屉态不请求）
- [x] `[impl]` `applyLayout` 末尾触发；`apply(scale)` 清零并重校
- [x] `[test]` `[14]` 重写：未配对不采信/发一次请求、配对后 0.875 与 1.25 生效、拖动作废、
      抽屉不发请求、缺失/越界回退、`ratio-request` 留痕

## 阶段 2 · 扫描与回归

- [x] `[test]` 扫描派发 `request-layout` 并在应答前同步 `innerWidth`（模拟页面重排）
- [x] `[test]` 四档缩放 × 240–1400 仍收敛且 `round(轨道×s)`
- [x] `[test]` `TMPDIR=/tmp npm run test:one -- dsh-sidebar` → `TMPDIR=/tmp npm test` 全绿

## 阶段 3 · 文档

- [x] `[docs]` 016 AC-4 修订（采信条件）+ 变更历史指向 020
- [x] `[docs]` README / ARCHITECTURE 一句（比例只在配对时生效）
- [x] `[docs]` TESTING 地图（断言数 + 020 覆盖）、AGENTS 断言数
- [x] `[docs]` 020 验证记录回填

## 阶段 4 · 发布（需维护者确认）

- [ ] `CHANGELOG` + 版本号 + tag
