# 技术方案 021：日志位置（globalStorage + 迁移）

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：implemented） |
| 负责人 | @Vithrive |
| 更新 | 2026-11-12 |

## 1. 方案概述

`debugLogDirFrom(ctx)` 优先 `ctx.globalStorageUri.fsPath + /logs`；`debugLogDir()` 用当前 `gContext`
（`activate` 第一行赋值）。`ensureDebugLog()` 在 mkdir 之后调 `migrateLegacyDebugLog(target)`：
旧位置 `~/.dsh-debug/<file>` 存在且新位置不存在时 `copyFileSync` 一次（含 `.1` 备份）。

## 2. 影响面

| 文件 / 函数 | 改动 | 对应 AC |
| --- | --- | --- |
| `extension.js`：`debugLogDirFrom/debugLogDir/debugLogPathFor/debugLogFileName/migrateLegacyDebugLog` | 新增 | AC-1、AC-2 |
| `extension.js` `ensureDebugLog`：先迁移再 stat | 修改 | AC-2、AC-3 |
| `package.json` 设置描述、README、ARCHITECTURE | 更新路径 | AC-3 |
| `test/dsh-sidebar.test.js` `[22]` | 新增 7 条断言 | AC-1、AC-2 |

## 3. 契约与回退

| 契约 | 新形态 | 回退 |
| --- | --- | --- |
| 日志目录 | `<globalStorage>/logs/` | 无上下文 → `~/.dsh-debug/`（018 行为） |
| 旧日志 | 首次复制一次 | 失败则只 warn，继续写新位置 |

## 4. 安全

- [x] 路径来自 VS Code API（非外部输入）；文件名固定；仍 `scrubDebugText` + 2MB 轮转。
- [x] 迁移只复制、不删除、不覆盖已有目标。

## 5. 测试策略

| 层 | 断言 |
| --- | --- |
| 纯函数 | `debugLogDirFrom` 三分支、`debugLogPathFor` 拼接 |
| 迁移 | 首次复制成功且内容一致、二次调用返回 false |
| 回归 | 018/019/020 全绿 |

## 6. 回退方案

- 功能：关闭 `dshPanel.debugLogToFile`。
- 代码：`debugLogDirFrom` 直接返回 `~/.dsh-debug` 即回到 018 位置。

## 7. 被否方案

| 方案 | 否决原因 |
| --- | --- |
| `context.logUri` / `logs/<会话>/exthost` | 按会话轮换，重启后旧文件散落且会被清理，不利于回传 |
| 扩展安装目录内 | 只读/更新即被覆盖，且违反 VS Code 约定 |
| 工作区 `.dsh-debug/` | 会被提交、随工作区散落，多工作区各一份 |
