# 技术方案 018：调试日志落盘

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：implemented） |
| 负责人 | @Vithrive |
| 更新 | 2026-11-12 |

## 1. 方案概述

扩展宿主侧加一个**极小的落盘件**（约 100 行，零依赖）：`debugLog(tag, text)` 逐行 append 到
`<homedir>/.dsh-debug/dsh-vscode-debug.log`。所有诊断文本先经 `scrubDebugText()` 脱敏；
累计字节超 2MB 时把当前文件改名为 `.log.1`（覆盖旧备份）后继续。开关是
`dshPanel.debugLogToFile`（默认 false），关闭时 `debugLog()` 立即返回，零副作用。

```
诊断包/事件 → debugLog(tag,text) → scrubDebugText → 追加（超 2MB 先轮转）
            ↘ 状态栏一次性提示（首次写入 / 首次失败）
输出面板（016）仍原样写入；两条出口共用同一份文本数组
```

## 2. 影响面

| 文件 / 函数 | 改动性质 | 触碰安全数据流 | 对应 AC |
| --- | --- | --- | --- |
| `extension.js` 新增：`debugLogEnabled/debugLogPath/scrubDebugText/ensureDebugLog/rotateDebugLog/debugLog/resetDebugLogState/onDebugLogSettingChanged/openDebugLog` | 新增 | 文件系统（用户主目录，固定文件名） | AC-1..AC-6 |
| `extension.js` `writeSidebarDiag` / `writeSidebarDiagMissing`：改为「先建文本数组 → 面板 + 文件」 | 修改 | 否 | AC-2、AC-3 |
| `extension.js` `applySidebarPolicyChange` / `dsh-sidebar-state` 分支 / `diagnoseSidebarCmd` / `ensureDshPlugins` / `activate`：`debugLog` 留痕 | 修改 | 否 | AC-2 |
| `extension.js` 配置变更监听 + 命令注册 + `__internals` 导出 | 修改 | 否 | AC-1、AC-5 |
| `package.json`：配置项 `dshPanel.debugLogToFile`、命令 `dshPanel.openDebugLog` | 新增 | 否 | AC-1、AC-5 |
| `test/dsh-sidebar.test.js`：`[20]` 段 + 桩（HOME / showTextDocument / Uri.file） | 扩展 | — | 全部 |
| `docs/*`：README 配置表、ARCHITECTURE 诊断段、TESTING 地图、018 验证记录 | 更新 | — | — |

## 3. 契约变更与兼容

| 契约 | 新形态 | 旧形态 / 回退 | 探测方式 |
| --- | --- | --- | --- |
| 配置项 `dshPanel.debugLogToFile` | boolean，默认 false | 不设置 = 关闭，行为与 017 完全一致 | 读取失败按 false |
| 文件位置 | `<homedir>/.dsh-debug/dsh-vscode-debug.log` | 无旧路径；模型诊断同目录，互不覆盖 | 不存在则创建 |
| 命令 `dshPanel.openDebugLog` | 打开日志/给指引 | 未注册时命令面板不可见 | 贡献点 |
| 面板/诊断消息 | 不变（仅多一条内部落盘） | — | — |

## 4. 状态与并发

| 状态 | 位置 | 谁置位 | 谁清理 | 失效策略 |
| --- | --- | --- | --- | --- |
| `debugLogState`（ready/path/size） | 扩展宿主内存 | `ensureDebugLog` | `resetDebugLogState`（设置变更/失败后） | 失败即 ready=false，下次重试 |
| `debugLogNotified` / `debugLogWarned` | 扩展宿主内存 | 首次写成功 / 首次写失败 | 关闭设置 / 重启 | 每窗口一次，防刷屏 |

并发：Node 单线程 + 同步 append，无竞态；轮转失败继续追加（宁可文件大也不丢日志）。

## 5. 安全审查

- [x] 落盘前 `scrubDebugText`：`[?&]token=…` 与 `token=…` 一律替换为 `***`；换行归一，防伪造行。
- [x] 只写布局数值/短枚举（复用 016 净化后的条目）；不写对话、文件内容、路径、Cookie。
- [x] 路径固定在工作区外的用户主目录，不接收外部输入；不做路径拼接（仅 `path.join` 常量 + homedir）。
- [x] IO 失败只 `console.warn` + 状态栏一次，不抛出、不影响主功能。

## 6. 测试策略（先红后绿）

| 层 | 断言（映射 AC） |
| --- | --- |
| 宿主（离线，HOME=临时目录） | AC-1（默认不建文件、配置项默认 false）、AC-2（落盘 + 首次提示路径）、AC-3（token 脱敏）、AC-4（2MB 轮转 + `.1`）、AC-5（命令打开/指引）、AC-6（不可写 → 提示一次且面板照写） |
| 有效红验证 | 临时让 `debugLogEnabled()` 恒 false → 「开启后生成日志文件」失败 → 恢复后通过 |

## 7. 实施步骤

1. `[impl]` 落盘件 + 配置项 + 命令（与测试交替）。
2. `[test]` `[20]` 段断言（默认关/落盘/脱敏/轮转/命令/失败）。
3. `[test]` 变异红验证 + 全量绿。
4. `[docs]` README 配置表、ARCHITECTURE、TESTING 地图、018 验证记录。

## 8. 回退方案

| 层级 | 手段 | 触发条件 |
| --- | --- | --- |
| 功能 | 关闭 `dshPanel.debugLogToFile`（默认即关） | 任何磁盘/权限问题 |
| 代码 | 删除 `debugLog` 调用即回到无落盘 | 极端性能问题 |
| 发布 | 补丁版本 | 线上故障 |

## 9. 被否方案与原因

| 方案 | 否决原因 |
| --- | --- |
| 写到工作区内（`.dsh-debug/`） | 会被用户提交/打包误带；`diagnoseModels` 已确立「用户主目录」约定 |
| 用 `vscode.window.createOutputChannel` 的 `LogOutputChannel` | 仍不跨会话留档，且无法被用户直接拷贝路径 |
| 引入日志库（winston 等） | 违反零依赖红线 |
| 异步队列写盘 | 无必要复杂度；单行同步 append 足够 |

## 10. 开放问题

- 若用户主目录位于网络盘，同步写可能变慢：可改为「每 N 行 flush」——当前先观察实机表现。
- 是否需要按天分文件（`dsh-vscode-debug-YYYYMMDD.log`）？当前 2MB 轮转已满足回传场景。
