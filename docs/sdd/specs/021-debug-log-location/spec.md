# 规格 021：调试日志放到扩展的 globalStorage（并迁移旧日志）

| 项 | 内容 |
| --- | --- |
| 编号 | 021 |
| 状态 | implemented |
| 负责人 | @Vithrive |
| 关联 | [spec 018（日志落盘）](../018-debug-log-file/spec.md) · [spec 019（事件流）](../019-trace-auto-file/spec.md) |
| 创建 / 更新 | 2026-11-12 / 2026-11-12 |

## 1. 背景与问题

018 把日志放在 `<用户主目录>/.dsh-debug/`。这与 VS Code 的约定不一致：扩展自己的数据应放在
`context.globalStorageUri`（本机实测 portable 版为
`data/user-data/User/globalStorage/vithrive.deepseek-harness-vscode/`），那里随扩展安装/卸载管理、
跨会话保留、也便于用户从「扩展目录」找到。而 `logs/<会话>/window1/exthost/…` 是**按会话轮换**的，
不适合留档回传。

## 2. 目标

- 日志默认写到 `<globalStorageUri>/logs/dsh-vscode-debug.log`；取不到上下文（非 VS Code 宿主/测试）时
  回退 `~/.dsh-debug/`（保留 018 行为，测试与旧环境不受影响）。
- 首次运行若新位置没有日志、旧位置有，则**复制一次**（不移动、不覆盖），历史现场不丢。
- 命令/提示里显示的路径随之为新位置（用户可见）。
- 轮转（`.log.1`）、脱敏、开关默认关闭等 018 既有行为不变。

## 3. 非目标

- 不迁移 `provider-info.json`（模型诊断，仍留在 `~/.dsh-debug/`）。
- 不改 `logs/<会话>` 目录（VS Code 自己的、按会话清理）。
- 不新增配置项。

## 4. 用户故事

- 作为 **VS Code 用户**，我希望调试日志和其它扩展数据放在一起（扩展目录下），而不是散落在主目录。
- 作为 **维护者**，我希望用户报问题时能直接从「扩展的全局存储目录」里拿到日志。

## 5. 验收标准（必须可执行）

- **AC-1**：Given 有 `globalStorageUri.fsPath`，When 计算日志目录，Then 为 `<fsPath>/logs`；
  Given 上下文缺失或 `fsPath` 为空，Then 回退 `~/.dsh-debug`。
- **AC-2**：Given 旧位置有日志、新位置没有，When 首次准备日志，Then 复制到新位置且内容一致；
  再次调用不重复迁移、不覆盖已有文件。
- **AC-3**：Given 迁移完成，Then 后续写入、轮转、脱敏、命令显示路径都在新位置（018 行为不变）。
- **AC-4（回归）**：既有 018/019/020 断言（默认关闭、脱敏、轮转、失败降级、事件流、比例配对）全绿。

## 6. 兼容矩阵

| 场景 | 日志位置 | 说明 |
| --- | --- | --- |
| 正常 VS Code（本地/Remote/容器） | `<globalStorage>/logs/` | 随扩展管理 |
| 非 VS Code 宿主 / 单测 | `~/.dsh-debug/` | 回退 |
| 从 018 版本升级 | 旧日志复制到新位置一次 | 旧文件保留 |
| 便携版 VS Code | `data/user-data/User/globalStorage/<id>/logs/` | 本机实测 |

## 7. 约束（引用宪法）

- 第二条：只用 `fs`/`os`/`path`。
- 第三条：命令与首次写入都显示实际路径（不静默）。
- 第五条：路径来自 VS Code API 的 `globalStorageUri`（不接收外部输入）；仍脱敏、仍 2MB 轮转。

## 8. 失败与提示

| 失败场景 | 行为 | 出口 |
| --- | --- | --- |
| 迁移失败 | `console.warn`，继续用新位置写（旧文件保持原样） | 手动复制旧文件 |
| globalStorage 不可写 | 沿用 018 的「调试日志写入失败」状态栏提示 | 关闭开关或修权限 |

## 9. 风险与开放问题

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 卸载扩展时 globalStorage 被清理 | 历史日志丢失 | 属 VS Code 预期行为；需要留档时先复制 |
| 旧日志与新日志各占一份 | 最多多 2MB | 迁移只复制一次、不移动 |

## 10. 验证记录

| 日期 | 方式 | 结论 |
| --- | --- | --- |
| 2026-11-12 | 本机实测 VS Code 目录布局 | `globalStorage` 持久；`logs/<会话>/exthost` 按会话轮换 |
| 2026-11-12 | `TMPDIR=/tmp npm run test:one -- dsh-sidebar` | 通过：196 项断言（`[22]` 路径/迁移） |
| 2026-11-12 | `TMPDIR=/tmp npm test` 全量 | 通过：1258 项断言 |
| 待补 | 实机：开启日志 → 命令「打开调试日志」 | 应打开 `<globalStorage>/logs/dsh-vscode-debug.log` |

## 11. 变更历史

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-11-12 | 初稿 + 实现：日志移到 `globalStorageUri/logs/`，旧位置一次性复制迁移 | 用户要求放到 VS Code 扩展相关目录 |
