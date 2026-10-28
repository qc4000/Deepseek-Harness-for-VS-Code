# 技术方案 006：面板打开时把 DSH 工作区指向当前 VS Code 文件夹

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：draft → approved） |
| 负责人 | @Vithrive |
| 更新 | 2026-10-28 |

## 1. 方案概述

新增一个随包分发的可关闭双半区插件 `dsh-vscode-workspace`（客户端半区干活，宿主半区 no-op），
沿用 `dsh-vscode-file-links` 的 `hello → ack` 跨源握手，但使用**独立消息类型**（`workspace-pin`
与 `workspace-pin-result`），避免污染既有 `ack` 的 `layoutOnly` 判别。

页面侧拿到宿主下发的目录后，调用 DSH 公开客户端服务完成切换：

```
面板加载 → iframe 内插件 hello（4/s，最多 25 次）
        → webview 中继回 { type:'workspace-pin', path }
        → 插件等 workspaces/sessions 快照 ready
        → ctx.workspaces.create({ path })            // 幂等注册，返回 workspaceId
        → 主视图会话 cwd === path ? 不动 : ctx.uiWorkspace.openWorkspace(id)
        → 回执 workspace-pin-result（done/already/unsupported/failed）→ 宿主按需提示
```

为什么不用别的路子：

| 备选 | 否掉原因 |
| --- | --- |
| 只调 `workspace/create`（现状） | 只登记不选中，AC-1 不满足 |
| 扩展改 `~/.dsh/storages/workspace.json` | 选中态在页面内存/客户端 store，重启即被覆盖；且会污染浏览器打开 DSH 的场景 |
| webview URL 带 query 让 DSH 自己读 | DSH 0.2.1-rc.2 前端不读 query，无此契约 |
| 扩展注入脚本点侧栏 | 违反宪法第一条，且 DOM 选择器随版本漂移 |

## 2. 影响面

| 文件 / 函数 | 改动性质 | 触碰安全数据流 | 对应 AC |
| --- | --- | --- | --- |
| `dsh-plugins/dsh-vscode-workspace/{package.json,cordis.patch.yml,lib/index.js,lib/client.js}` | 新增 | 否（客户端只调 DSH 服务） | AC-1/2/3/7/8 |
| `extension.js` `WORKSPACE_PLUGIN_NAME` / `ensureWorkspacePlugin()` | 新增 | 否 | AC-4 |
| `extension.js` `workspacePinPath()` / `workspacePinEnabled()` | 新增（纯函数，挂 `__internals`） | 路径 | AC-4/5/9 |
| `extension.js` webview 中继脚本（`WS_PIN_ID` 分支 + `workspace-pin` 下发 + 8s 超时提示） | 修改 | webview 消息 | AC-6/9 |
| `extension.js` `handleWebviewMessage`（`dsh-workspace-pin-result` 分支） | 修改 | webview 消息 | AC-7/8 |
| `extension.js` `ensureDshPlugins()` 与安装提示文案 | 修改 | 否 | AC-4 |
| `package.json` 新增 `dshPanel.pinWorkspaceToVSCode` | 新增 | 否 | AC-4 |
| `test/workspace-pin.test.js` | 新增 | — | 全部 |
| `README.md` / `docs/ARCHITECTURE.md` / `docs/TESTING.md` / `CHANGELOG.md` | 更新 | — | — |

## 3. 契约变更与兼容

### 3.1 实测的 DSH 客户端契约（dsh 0.2.1-rc.2）

| 服务 | 形态 | 依据 |
| --- | --- | --- |
| `ctx.workspaces` | 客户端服务（`ClientWorkspaceModel`），`create({ path })` 返回 `WorkspaceView`（含 `workspaceId`），失败抛 `WorkspaceCreateError`；`list.getSnapshot()` → `{ phase, items }` | `dsh-api-workspace-controller/lib/client.js`（`super(ctx, "workspaces")`、`create`） |
| `ctx.uiWorkspace` | 客户端服务，`openWorkspace(workspaceId)` → 复用/创建该工作区空白会话并 `replaceMain` | `dsh-client-ui-workspace/lib/client.js`（`super(ctx, "uiWorkspace")`、`openWorkspace`） |
| `ctx.sessions.list.getSnapshot()` | `{ phase, ids, byId }`，`byId[id]` 含 `cwd`、`retainedBy.mainView` | 同文件 `restoreSelection` / `createInWorkspace` |
| 启动恢复顺序 | 页面 ready 后由 `restoreSelection()` 选中；`mainReference` 已存在则跳过 | 同文件 `watchNavigation` |

### 3.2 自有契约（扩展 ↔ 插件）

| 消息 | 方向 | 字段 | 回退 |
| --- | --- | --- | --- |
| `hello` | 插件 → 中继 | `source:'dsh-vscode-workspace'` | 无宿主时无人应答，插件 10s 后静默退出（独立浏览器场景） |
| `workspace-pin` | 中继 → 插件 | `path`（≤4096，非空）或 `disabled:true` | 字段不合规 → 插件忽略，不动作 |
| `workspace-pin-result` | 插件 → 中继 → 宿主 | `status:'done'\|'already'\|'unsupported'\|'failed'`、`reason?`（≤200） | 旧宿主不认识该类型 → 丢弃 |

8 秒内中继未收到任何 `workspace-pin-result` → 宿主提示 AC-6（覆盖「插件装了但没重启」与「旧 dsh 不加载客户端插件」）。

### 3.3 配置项

| 配置 | 默认 | 语义 |
| --- | --- | --- |
| `dshPanel.pinWorkspaceToVSCode` | `true` | 面板加载后把 DSH 工作区切到当前文件夹；`false` 时不安装/不更新插件、不下发路径 |

## 4. 状态与并发

| 状态 | 位置 | 谁置位 | 谁清理 | 失效策略 |
| --- | --- | --- | --- | --- |
| 面板握手/超时计时器 | webview 内脚本（页面生命周期） | iframe `load` 事件 | 收到 `workspace-pin-result` 或面板销毁 | iframe 重载重新计时 |
| 插件执行标记 `applied` | 插件模块内（页面生命周期） | 首次成功/失败处理 | 页面重载 | 只执行一次，避免重复开窗 |
| 「已提示过」标记 | 扩展内存 `Set<panelId>` | 提示成功时 | 面板销毁 | 每次面板只提示一次 |

并发：插件侧单飞（`applied` 标记 + Promise 缓存）；`workspace/create` 与 `registerWorkspace()` 各自幂等，
两条路径同时发生也只会得到一个工作区条目。

## 5. 安全审查

- [x] 无新增 `spawn`/`exec`；路径不进入命令行
- [x] webview CSP 未放宽；新插值走 `jsonForScript`；脚本仍在既有 nonce 下
- [x] 中继校验 `origin`（`fromOurFrame`）+ `source` 白名单（`WS_PIN_ID`），字段类型与长度截断
- [x] 路径只来自 `workspaceFolders[0].uri.fsPath`，页面不可回传路径；插件侧再次做形状校验
- [x] 无 token / Cookie 参与链路；提示文案只含目录名（basename），不含完整路径
- [x] 新增输入（配置项布尔、消息字段）纳入 `test/workspace-pin.test.js`

## 6. 测试策略（先红后绿）

| 层 | 套件 | 断言（映射 AC） |
| --- | --- | --- |
| L1 纯函数 | `test/workspace-pin.test.js` | `workspacePinPath()`：有文件夹返回路径 / 空窗口返回 `''`（AC-5）；开关关闭返回 `''`（AC-4）；路径形状校验拒绝 URL/控制字符/超长（AC-9） |
| L1 插件静态契约 | 同上 | `package.json` 的 `dsh.client.platform=web`、`bundle.patch`、无 `dependencies`；`cordis.patch.yml` 注册行与包名一致；客户端 `ModuleLoader` id 与导出 `name` 一致 |
| L2 宿主安装 | 同上 | `ensureWorkspacePlugin()` 落盘到 profile、登记 `dsh.profile.bundles`、版本一致幂等（AC-4 反面：关闭时不调用） |
| L3 客户端仿真（vm + 假 ctx） | 同上 | 未握手不调 `create`；握手后 `create({path})` 一次 + `openWorkspace(id)` 一次（AC-1/3）；主视图 cwd 已是目标 → 不调 `openWorkspace`（AC-2）；缺 `uiWorkspace` → 上报 `unsupported` 且不抛（AC-7）；`create` 抛错 → 上报 `failed` 且不抛（AC-8） |
| L2 中继脚本 | 同上 | 生成的 HTML 含 `workspace-pin` 消息类型与 JSON 化路径；路径含反斜杠/引号时不破坏脚本语法（`node --check` 同款校验） |

实机（F5）验证项：AC-1、AC-2、AC-6 在真实 dsh 0.2.1-rc.2 上跑一次并写回 spec 第 10 节。

## 7. 回退方案

| 层 | 回退动作 |
| --- | --- |
| 用户 | 设 `dshPanel.pinWorkspaceToVSCode=false` → 下次启动不再安装/更新，面板保持 DSH 自身行为 |
| 代码 | 删除 `ensureWorkspacePlugin()` 调用与中继的 `WS_PIN_ID` 分支即回到 1.0.4 行为；插件文件留盘无害（不握手就完全惰性） |
| 数据 | 插件不写任何自有存储；`workspace/create` 只新增注册（用户可在 DSH 侧栏删除该工作区） |
