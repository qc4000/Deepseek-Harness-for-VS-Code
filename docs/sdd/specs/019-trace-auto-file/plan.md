# 技术方案 019：事件流自动落盘

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：implemented） |
| 负责人 | @Vithrive |
| 更新 | 2026-11-12 |

## 1. 方案概述

中继本来就把每个事件压进内存环形缓冲（016 的 `diagLogPush`）。这里只加一个开关：
**开启落盘时**把同一条目顺手塞进增量队列，1 秒一包（或满 200 条立即发）用
`{type:'dsh-sidebar-trace'}` 推给扩展；扩展用同一套白名单净化后，**一包一次 append**。
关闭时队列不存在、定时器不启动、消息不发——每个事件只多一次 `if (!debugFileLog) return;`。

```
事件 → diagLogPush(entry) → [内存环形 120]
                         └→ traceQueue（仅开启）→ 1s/200 条攒批 → postMessage
扩展 ← dsh-sidebar-trace → normalizeDiagEntries → debugLog('sidebar-trace', 多行一次追加)
```

## 2. 影响面

| 文件 / 函数 | 改动性质 | 触碰安全数据流 | 对应 AC |
| --- | --- | --- | --- |
| `extension.js` 中继：`traceQueue/traceFlush`、`debugFileLog` 注入、`dsh-debug-log-file` 热切换 | 新增 | webview 消息 | AC-1..AC-4 |
| `extension.js`：`buildIframeHtml(..., debugFile)` 可选参数 | 修改 | 否 | AC-2、AC-4 |
| `extension.js`：`dsh-sidebar-trace` 分支 + `normalizeDiagEntries` 抽取 + `diagClock` + `onDebugLogSettingChanged` 热推 + `[env]` | 新增/修改 | 文件系统（018 路径） | AC-2、AC-5、AC-6 |
| `test/dsh-sidebar.test.js`：`[21]` 段 + `makeRealm` 支持 `debug` | 扩展 | — | 全部 |
| `docs/*`：README/ARCHITECTURE/TESTING/019 验证记录 | 更新 | — | — |

## 3. 契约变更与兼容

| 契约 | 新形态 | 旧形态 / 回退 | 探测方式 |
| --- | --- | --- | --- |
| 宿主 → 页面 `dsh-debug-log-file` | `{enabled:boolean}` 热切换 | 旧页面忽略未知 type（不会推流） | 字段严格 `=== true` |
| 页面 → 宿主 `dsh-sidebar-trace` | `{entries:[{t,ev,v}]}` ≤200 条 | 旧宿主忽略未知 type | 数组 + 白名单校验 |
| `buildIframeHtml` 签名 | 新增可选第 6 参 `debugFile`（缺省读设置） | 旧调用点省略 → 走默认 | 参数 `undefined` 判断 |
| 日志内容 | 新增 `[sidebar-trace]` 与 `[env]` 行 | 原有 `[sidebar-diag]` 不变 | 行前缀 |

## 4. 状态与并发

| 状态 | 位置 | 谁置位 | 谁清理 | 失效策略 |
| --- | --- | --- | --- | --- |
| `debugFileLog` | 中继内存 | 构建注入 / `dsh-debug-log-file` | 面板重建 | 关闭即 false |
| `tracePending` / `traceTimer` | 中继内存 | 事件入队 | 发送/关闭/面板销毁 | 关闭时清空 |
| `debugLogState` 等 | 扩展宿主（018 既有） | — | — | — |

并发：单线程；攒批满 200 立即发送，避免消息风暴；定时器只有开启时存在。

## 5. 安全审查

- [x] 事件条目与诊断包走同一净化（`t` 有限数、`ev` 小写短枚举、`v` 去控制字符 ≤160、条数 ≤200）。
- [x] 不含 token/路径/对话内容；落盘仍经 `scrubDebugText`（018）。
- [x] 新增消息只从「本面板 iframe + DSH origin」接收（既有 `fromOurFrame`），宿主 → 页面消息不带用户输入。

## 6. 测试策略（先红后绿）

| 层 | 断言（映射 AC） |
| --- | --- |
| vm 中继 | AC-1（关闭不产生消息）、AC-2（开启 1s 批量含 layout）、AC-3（单包 200 上限）、AC-4（热开关） |
| 扩展宿主 | AC-2（落盘 `[sidebar-trace]`）、AC-5（净化）、AC-6（`[env]`） |

## 7. 实施步骤

1. `[impl]` 中继：`debugFileLog` 注入 + `traceQueue/traceFlush` + 热切换消息。
2. `[impl]` 扩展：`normalizeDiagEntries` 抽取、`dsh-sidebar-trace` 分支（一次追加）、`[env]`、设置变更热推。
3. `[test]` `[21]` 段断言（关闭/开启/上限/热切换/净化/env）。
4. `[test]` 全量绿 + 性能微基准（关闭 0.27µs/包、开启 471µs/包 ≤1/s）。
5. `[docs]` 同步 README/ARCHITECTURE/TESTING/019。

## 8. 回退方案

| 层级 | 手段 | 触发条件 |
| --- | --- | --- |
| 功能 | 关闭 `dshPanel.debugLogToFile` | 任何性能/磁盘顾虑 |
| 代码 | 去掉 `traceQueue(entry)` 调用即回到 018 行为 | 实机验证发现副作用 |
| 发布 | 补丁版本 | 线上故障 |

## 9. 被否方案与原因

| 方案 | 否决原因 |
| --- | --- |
| 每条事件立即 postMessage | 拖动时会放大消息量；攒批把成本压到 ≤1 包/秒 |
| 扩展轮询面板要日志 | 需要常驻定时器与请求协议，复杂且同样有开销 |
| 页面插件也推流 | 与中继的 `layout` 条目重复；需要时仍可手动导出完整页面日志 |
| 开启时把整包诊断（含页面日志）每秒全量落盘 | 体积与写盘都翻倍，且 `layout` 已覆盖关键信息 |

## 10. 开放问题

- 若实机发现 `[sidebar-trace]` 太多导致轮转过快，可把 `TRACE_BATCH_MS` 提到 2s 或对 `layout` 做采样。
- 页面侧 `trace` 是否值得推流，取决于实机复盘是否足够——目前判断「够用」。
