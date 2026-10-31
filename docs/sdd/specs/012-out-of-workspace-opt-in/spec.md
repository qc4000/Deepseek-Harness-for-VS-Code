# 规格 012：工作区外文件的显式兜底（可选开关）

| 项 | 内容 |
| --- | --- |
| 编号 | 012 |
| 状态 | implemented |
| 负责人 | @Vithrive |
| 关联 | 承接 [010](../010-out-of-workspace-file-link/spec.md) / [011](../011-dsh-cwd-and-latest-turn/spec.md) · 目标版本 `1.0.7` |
| 创建 / 更新 | 2026-10-30 / 2026-10-30 |

## 1. 背景与问题

010/011 让工作区外文件尽量用 DSH 的**轮级记录**出 diff。实机日志（`__dshVscodeFileLinks.log()`）
显示这类点击仍然大量失败，原因码统一是 **`released`**：

- `dsh-vscode-changes` 的会话状态与 DSH 自己的 `workspaceChanges` 一样**只在进程内存**里，
  `session/disposed`（`dsh web` 重启、会话被卸载）即删；
- 于是「重启 dsh web 后点旧会话的链接」必然拿不到轮级数据；
- 工作区内文件还有 P0（git `HEAD` 对比）与 L0（普通打开）兜底，工作区外文件**没有任何兜底**，
  只能回落到 DSH 侧栏。

直白地说：这不是匹配算法的漏洞，而是**没有数据源**。要让它可用，只能引入新的数据来源
（git 对比 / 直接打开），而这会扩大读盘面（宪法第五条），必须由用户显式选择。

## 2. 目标

- 保留默认行为不变：`outOfWorkspaceFileAccess=false` 时，工作区外文件仍只尝试轮级记录，
  失败即交回 DSH 侧栏，并**说明原因**（记录已随重启丢失）与**出路**（可开启该开关）。
- 开启后按与工作区内一致的顺序降级：轮级 → git `HEAD` ↔ 当前内容 → 普通打开
  （`revealOnly` 只定位）。
- 开关只影响「点击工作区外文件链接」，不改变工作区内三级降级、不改变 reveal 边界默认值。

## 3. 非目标

- 不默认开启；不在未开启时 `stat` / 读盘 / 跑 git 工作区外路径。
- 不做工作区外目录的 diff（目录只定位）。
- 不缓存文件内容、不把路径写盘。

## 4. 验收标准（必须可执行）

- **AC-1**：Given `outOfWorkspaceFileAccess=false`、`diffAndOpen`、轮级返回 `released`，
  When 点击工作区外链接，Then 不执行任何编辑器命令、回执 `ok:false`，
  状态栏提示含「变更记录已随 dsh web 重启丢失」与「把 dshPanel.outOfWorkspaceFileAccess 设为 true」。
- **AC-2**：Given 开关开启、轮级失败、该文件在 git 仓库里有未提交改动，
  When 点击，Then 打开 `a.py · 与 HEAD 的差异`（虚拟文档 + 工作区外文件 URI），不定位资源管理器，
  回执 `ok:true`。
- **AC-3**：Given 开关开启、轮级失败、无 git 基线（非仓库/无改动），When 点击，
  Then `vscode.open` 打开该文件并回执 `ok:true`。
- **AC-4**：Given 开关开启、`revealAndOpen`，When 点击，Then 直接打开；`revealOnly` 只定位。
- **AC-5**：Given 路径不存在（模型看错/已删除），When 点击，Then 不接管、回执 `ok:false`。
- **AC-6**：Given 开关关闭（默认），Then `readGitHeadBaseline` 与 `stat` 都不会对工作区外路径执行
  （测试注入会抛错的桩来断言）。
- **AC-7**：Given 工作区内链接，When 点击，Then 行为与 011 完全一致（不受本开关影响）。

## 5. 兼容矩阵

| 场景 | 开关关（默认） | 开关开 |
| --- | --- | --- |
| 工作区内文件 | 三级降级（不变） | 三级降级（不变） |
| 工作区外文件、有轮级记录 | 轮级 diff | 轮级 diff（优先） |
| 工作区外文件、无轮级记录 | DSH 侧栏 + 原因与出路 | git 对比 → 打开 |
| Remote（WSL/SSH） | 同上 | 同上（git 在远端执行） |

## 6. 约束（宪法）

- 第五条：**默认不开**，开启由用户显式承担；文档写明扩大读盘面的含义。
- 第三条：关闭时失败仍可见（原因 + 出路），不静默。
- 第六条：`allowOutOfWorkspaceAccess` / `openOutOfWorkspaceFallback` 挂 `__internals` 可测。

## 7. 验证记录

| 日期 | 方式 | 结论 |
| --- | --- | --- |
| 2026-10-30 | `npm test`（21 套 / 1005 项断言；`file-link-diff` 138） | 通过（AC-1~7 各有断言） |
| 待验证 | 实机：开启开关后点工作区外链接 | 待用户确认 |

## 8. 变更历史

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-10-30 | 初稿 + 实现 | 实机日志显示失败原因统一为 `released`：轮级数据重启即失，工作区外无兜底 |
