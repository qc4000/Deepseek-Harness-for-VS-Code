# 技术方案 020：缩放比例按「请求-应答配对」采信

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：implemented） |
| 负责人 | @Vithrive |
| 更新 | 2026-11-12 |

## 1. 方案概述

问题的本质是**配对**：`innerWidth`（页面测）与 `iframe 实宽`（宿主测）必须来自同一渲染时刻。
自发上报永远可能跨帧，所以改成宿主主动要一次：

```
需要裁剪(未知比例) → request-layout（记下请求时的 stage）
页面收到 → 按当前裁剪重排 → report(带新的 innerWidth)
宿主收到 → 若 stage 未变 → ratio = rect/innerWidth → 记为可信（ratio-set）
         └ 若 stage 变了（还在拖）→ 作废，沿用上次可信值（初始 1）
```

一旦可信，裁剪直接用，不再请求；`dsh-font-scale` 变化时把可信值清零并重校。

## 2. 影响面

| 文件 / 函数 | 改动性质 | 对应 AC |
| --- | --- | --- |
| `extension.js` 中继 `pickRatio`：改为只接受「应答 + stage 未变」的样本 | 修改 | AC-1..AC-4、AC-6 |
| `extension.js` `maybeRequestCalibration()`（500ms 限流） | 新增 | AC-1、AC-4 |
| `extension.js` `applyLayout()` 末尾触发校准；`apply(scale)` 清零重校 | 修改 | AC-1、AC-5 |
| `test/dsh-sidebar.test.js` `[14]` 重写 + 扫描派发 `request-layout` 并同步 `innerWidth` | 修改 | 全部 |

## 3. 契约变更与兼容

| 契约 | 新形态 | 回退 | 说明 |
| --- | --- | --- | --- |
| 宿主 → 页面 `request-layout` | 用于校准（此前仅用于转调回执） | 旧插件无响应 → 比例恒 1 | 频率：未校准时 + 500ms 限流 |
| `layout` 的 `innerWidth` | 采信条件更严 | 无 `innerWidth` → 1 | 不改变字段本身 |

## 4. 状态与并发

| 状态 | 位置 | 清理 |
| --- | --- | --- |
| `trustedRatio` | 中继内存 | 字号变化清零 |
| `calibPendingStage` / `calibLastAskAt` | 中继内存 | 应答/作废/超时可重试 |

## 5. 安全审查

- [x] 只发固定 `{source,type}` 消息；不携带用户输入。
- [x] `innerWidth` / `rect` 都做有限正数校验；`ratio` 区间 [0.5, 2]。

## 6. 测试策略

| 层 | 断言 |
| --- | --- |
| vm 中继 | 未配对不采信 + 发一次请求、配对后 0.875/1.25 生效、stage 变化作废、抽屉不发请求、缺失/越界回退、`ratio-request` 留痕 |
| 扫描 | 四档缩放 × 240–1400 收敛且 `round(轨道×s)`（扫描里派发请求并同步 innerWidth） |

## 7. 实施步骤

1. 中继：`pickRatio` 重写 + `maybeRequestCalibration` + `applyLayout` / `apply(scale)` 接线。
2. 测试：`[14]` 重写；扫描支持请求派发。
3. 全量绿 + 更新 016/README/ARCHITECTURE/TESTING。

## 8. 回退方案

- 关闭 `dshPanel.debugLogToFile`（只影响日志，不影响校准）。
- 代码级：去掉 `maybeRequestCalibration()` 调用即回到「比例恒 1」（= 015 行为）。

## 9. 被否方案与原因

| 方案 | 否决原因 |
| --- | --- |
| 只按 `stage` 是否变化决定采信（不请求） | 静置场景下一次上报后没有第二次上报，永远校准不了 |
| 连续两次样本一致才采信 | 同上：drag 结束后没有后续样本，校准永远不完成 |
| 直接用 `fontScale` 静态乘算 | 1.0.2 失败路径；且 CSS zoom 语义仍未实测确认 |
| 拖动中按「上一帧 stage」粗筛 | 仍有跨帧窗口，实机日志已证明会产生 1.05~1.35 假比例 |

## 10. 开放问题

- 若实机日志里 `rect/(stage+crop) ≠ 1`，说明盒子被缩放 → 分子改用 `stage+crop`；日志字段已具备。
- 校准请求在「面板一直拖动、从未静置」时不会成功 → 比例保持 1（安全）。
