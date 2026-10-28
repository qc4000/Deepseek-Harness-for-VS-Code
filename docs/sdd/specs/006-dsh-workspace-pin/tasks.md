# 任务清单 006：面板打开时把 DSH 工作区指向当前 VS Code 文件夹

> 用法：任务按「先红后绿」排序；每完成一项把 `[ ]` 改成 `[x]` 并在 PR 里贴 `npm test` 结果。
> 粒度：单项 ≤ 半个工作日。`[P]` 表示与相邻任务无依赖、可并行。`[test]` 必须先于对应 `[impl]` 合入。

## 阶段 0 · 准备

- [x] `[docs]` spec / plan / tasks 三件套落位 —— 判据：AC 均可指到断言
- [x] `[test]` 创建 `test/workspace-pin.test.js` 骨架（vscode 桩 + `ok()` 计数） —— 判据：`node test/workspace-pin.test.js` 能跑到第一条断言并失败
- [x] `[impl]` `extension.js` 落位常量 `WORKSPACE_PLUGIN_NAME` / `WORKSPACE_PIN_KEY`、`workspacePinEnabled()` / `workspacePinPath()` 并挂 `__internals` —— 判据：测试可直接取到

## 阶段 1 · 宿主纯逻辑（L1）

- [x] `[test]` AC-5 空窗口 → `workspacePinPath()` 返回 `''`；AC-4 开关关 → `''`；有文件夹 → 返回该路径 —— 判据：红
- [x] `[impl]` `workspacePinPath()` / `workspacePinEnabled()` 最小实现 —— 判据：上条变绿
- [x] `[test]` AC-9 路径形状校验（URL / 控制字符 / 超长 / 空白） —— 判据：红→绿

## 阶段 2 · 插件包（L1 静态契约 + L3 客户端）

- [x] `[test]` 插件 `package.json`（`dsh.client.platform=web`、`bundle.patch`、无 `dependencies`）、`cordis.patch.yml` 注册行、客户端 `ModuleLoader` id —— 判据：红（文件不存在）
- [x] `[impl]` 新建 `dsh-plugins/dsh-vscode-workspace/`（`package.json`、`cordis.patch.yml`、`lib/index.js`、`lib/client.js`） —— 判据：静态断言绿
- [x] `[test]` 客户端仿真：未握手不调 `create`；握手后 `create({path})` + `openWorkspace(id)` 各一次（AC-1/3） —— 判据：红
- [x] `[impl]` 客户端握手与切换主流程 —— 判据：绿
- [x] `[test]` 客户端仿真：主视图 `cwd` 已是目标 → 不调 `openWorkspace`（AC-2） —— 判据：红→绿
- [x] `[test]` 客户端仿真：缺 `uiWorkspace`/`workspaces` → 上报 `unsupported` 且不抛（AC-7） —— 判据：红→绿
- [x] `[test]` 客户端仿真：`create` 抛错 → 上报 `failed` 且不抛（AC-8） —— 判据：红→绿

## 阶段 3 · 宿主接入（L2）

- [x] `[test]` `ensureWorkspacePlugin()` 落盘到 web profile、登记 `dsh.profile.bundles`、版本一致幂等 —— 判据：红
- [x] `[impl]` `ensureWorkspacePlugin()` + `ensureDshPlugins()` 门控（开关关时不安装） —— 判据：绿
- [x] `[test]` 中继脚本：生成的 HTML 含 `workspace-pin` 与 JSON 化路径；路径含反斜杠/引号时脚本仍可解析 —— 判据：红
- [x] `[impl]` 中继脚本 `WS_PIN_ID` 分支 + `workspace-pin` 下发 + 8s 超时上报 —— 判据：绿
- [x] `[test]` `handleWebviewMessage`：`dsh-workspace-pin-result` 的 `status` 白名单与 `reason` 截断 —— 判据：红
- [x] `[impl]` 宿主提示（`unsupported` / `failed` / 超时各一次，中文含出路） —— 判据：绿
- [x] `[impl]` `package.json` 新增 `dshPanel.pinWorkspaceToVSCode`（默认 `true`） —— 判据：配置出现在设置界面

## 阶段 4 · 文档与验证

- [x] `[docs]` `docs/TESTING.md` 测试地图补行（套件 / 断言数 / 覆盖）
- [x] `[docs]` `README.md` 配置表 + 行为说明；`docs/ARCHITECTURE.md` 四条链路补插件
- [x] `[docs]` `CHANGELOG.md` 顶部小节（版本号提升须维护者确认后执行——本次未改版本号）
- [x] `[verify]` `npm test` 全绿；F5 实机验证 AC-1 / AC-2 / AC-6 并写回 spec 第 10 节（2026-10-28 维护者确认；AC-6 走「自动补装 + 提示重启」这一层）
- [x] `[docs]` spec 状态改 `implemented`

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 / AC-3 | 阶段 2 | `workspace-pin.test.js` |
| AC-2 | 阶段 2 | `workspace-pin.test.js` |
| AC-4 | 阶段 1 / 3 | `workspace-pin.test.js` |
| AC-5 | 阶段 1 | `workspace-pin.test.js` |
| AC-6 | 阶段 3 + 实机 | `workspace-pin.test.js` + F5 |
| AC-7 / AC-8 | 阶段 2 / 3 | `workspace-pin.test.js` |
| AC-9 | 阶段 1 / 3 | `workspace-pin.test.js` |

## 例外与决策记录

- 消息类型独立（`workspace-pin`）而非复用 `ack`：`dsh-vscode-file-links` 的 `layoutOnly` 判别会因新字段误判，
  直接复用会破坏 diff 模式（历史坑已记录在 005）。
- 插件只做客户端半区工作，宿主半区 no-op：与 `dsh-vscode-file-links` / `dsh-vscode-layout` 保持一致，
  避免在 dsh 进程内再开一条通道。
