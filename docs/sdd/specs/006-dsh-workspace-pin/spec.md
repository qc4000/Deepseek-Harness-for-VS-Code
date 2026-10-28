# 规格 006：面板打开时把 DSH 工作区指向当前 VS Code 文件夹

| 项 | 内容 |
| --- | --- |
| 编号 | 006 |
| 状态 | implemented（1.0.5） |
| 负责人 | @Vithrive |
| 关联 | 分支 `dev-1.0` · 目标版本 `1.0.5` |
| 创建 / 更新 | 2026-10-28 / 2026-10-28 |

> 编号说明：005 第 9 节提到的 P2「dsh-git-rollback 检查点」尚未立项，立项时顺延为 007。

## 1. 背景与问题

扩展启动 dsh 时已经把进程 `cwd` 设为 VS Code 第一个文件夹（`getWorkspaceDir()`），并且
`registerWorkspace()` 会调用 `workspace/create` 把它**登记**到 DSH 工作区列表；但 DSH 的工作区
「当前选中项」并不由进程 `cwd` 或注册表决定：

- `dsh-client-ui-workspace` 启动恢复时先取客户端持久化的选择（`dsh.sessions.current`），命中就直接用；
- 未命中则退到 `recentWorkspace()`——**最近有活动的那个工作区**；
- 只有全新安装（无工作区且无会话）才 `initializeDefault()`，且建在 `~/Documents/deepseek-harness`。

结果是：在 A 项目用完后换到 B 项目，打开面板仍显示 A 的工作区与会话，`cwd` 与注册都是对的，
用户看到的工作区却是错的（本机 `~/.dsh/storages/workspace.json` 实测 17 个工作区，其中没有当前仓库路径，
只有旧位置的 `learning/github/deepseek-harness-vsc-extension`）。

选中态在 DSH 页面内部（跨源 iframe），扩展无法直接写；改 `~/.dsh/storages` 里的客户端存储既脏又会
被页面内存状态覆盖。因此需要一个随包分发的**可关闭客户端插件**在页面侧完成切换。

## 2. 目标

- 面板（侧边栏 / 编辑器标签页）每次加载后，若 DSH 当前主视图不在「当前 VS Code 第一个文件夹」，
  自动切到该工作区；已在该工作区则什么都不做（不新建多余会话、不打断已打开的对话）。
- 切换通过 DSH 公开的客户端服务完成：`ctx.workspaces.create({ path })` + `ctx.uiWorkspace.openWorkspace(id)`，
  不注入脚本改 DSH DOM、不拦事件、不写 DSH 存储文件。
- 能力可完全关闭（配置项），关闭时不安装/不更新插件，行为与本规格之前完全一致。
- 任何失败都**用户可见**：插件未生效（未重启 / 旧版 dsh / 服务缺失）与切换失败分别给出中文提示与出路。
- 换 `Local` / `WSL` / `SSH` / `Dev Containers` 时，钉住的是「dsh 所在机器上的路径」——即
  `workspaceFolders[0].uri.fsPath`，与现有 `cwd` 语义保持一致。

## 3. 非目标

- 不改变 DSH 侧的工作区列表内容与顺序，不删除/重命名任何工作区。
- 不在 VS Code 切换文件夹时实时驱动 DSH（只在本面板页面加载时判定一次）。
- 不接管 DSH 侧边栏里用户手动选择工作区的操作（用户选了别的就停在别的）。
- 不为 Copilot 桥接（ACP 会话）做任何改动——那条链路的 `cwd` 早已按工作区传入。
- 不支持多根工作区的第二个及以后文件夹（沿用 `getWorkspaceDir()` 取第一个的既有约定）。

## 4. 用户故事

- 作为 **VS Code 用户**，我希望打开面板就看到当前项目的 DSH 工作区与会话，以便不用每次都手动在
  DSH 侧栏里切换（旧项目还会被 `recentWorkspace()` 抢走焦点）。
- 作为 **维护者**，我希望这条能力用可关闭插件实现、失败有提示，以便 dsh 契约变化时不至于静默失效。

## 5. 验收标准

- **AC-1（首次打开即钉住）**：Given `dshPanel.pinWorkspaceToVSCode=true`（默认）、VS Code 打开文件夹 B、
  DSH 上次停在 A，When 打开面板，Then DSH 主视图出现 B 的空白会话（工作区标题为 B），且 DSH 侧栏列表里
  B 被选中。
- **AC-2（已就位不动作）**：Given DSH 当前主视图会话的 `cwd` 已是 B，When 重新加载面板，Then 不调用
  `openWorkspace`、不新建会话，主视图仍是原来那个会话。
- **AC-3（目录未注册时自动注册）**：Given B 从未在 DSH 注册过，When 打开面板，Then 先 `workspace/create`
  登记 B（幂等），再切过去；重复打开不产生重复工作区条目。
- **AC-4（关闭开关完全退出）**：Given `dshPanel.pinWorkspaceToVSCode=false`，When 打开面板，Then 不安装/
  不更新插件、不下发路径、不切换，行为与本规格之前一致。
- **AC-5（无文件夹窗口不钉）**：Given VS Code 没有打开任何文件夹（空窗口），Then 不下发路径、不切换
  （不得把 `~` 或任意目录钉成工作区）。
- **AC-6（插件未生效可见）**：Given 插件文件已在 profile 里但 dsh web 未重启（升级后最常见），When 面板加载 8 秒内未收到
  插件回执，Then 状态栏提示一次：「未能自动切换到当前工作区（dsh 插件未生效，请重启 dsh web 后重试）」。
  Given 插件文件缺失，Then 由 `ensureDshPlugins()` 当场补装并提示「已自动安装/更新 DSH 插件…」，不必等到 8 秒（实测走的就是这一层）。
- **AC-7（旧版 dsh / 服务缺失可见）**：Given dsh 客户端没有 `workspaces` 或 `uiWorkspace` 服务，
  When 插件握手成功，Then 插件上报 `pin-failed:unsupported`，面板提示一次「当前 dsh 版本不支持自动切换
  工作区，请在 DSH 侧栏手动选择」，且不重试。
- **AC-8（切换失败可见且不破坏现场）**：Given `workspace/create` 或 `openWorkspace` 抛错，Then 主视图保持
  原样（不出现空白/报错页），面板提示一次失败原因（≤200 字）与出路（在 DSH 侧栏手动选择）。
- **AC-9（协议安全）**：中继只接受来自本面板 iframe、`origin` 相符、`source==='dsh-vscode-workspace'` 的消息；
  路径长度 ≤4096、拒绝控制字符与带 scheme 的 URL；宿主只下发 `workspaceFolders[0].uri.fsPath`。

## 6. 兼容矩阵

| 场景 | 新版 dsh（0.2.x，插件可加载） | 旧版 dsh / 插件不可加载 | 说明 |
| --- | --- | --- | --- |
| Windows 本地 / macOS 本地 / Linux 本地 | AC-1 生效 | AC-6 提示，不切换 | 路径含盘符/反斜杠需原样传递 |
| WSL Remote | 生效（钉 WSL 内路径） | 同上 | `uri.fsPath` 即远端路径 |
| Remote-SSH / Dev Containers | 生效（钉远端路径） | 同上 | 同上 |
| 编辑器标签页打开面板 | 生效（与侧栏同一套判定） | 同上 | 两个 webview 互斥，只有活着的那个会握手 |
| 系统浏览器直接打开 DSH | 不适用 | 不适用 | 无宿主，插件 hello 无人应答，保持惰性 |
| `pinWorkspaceToVSCode=false` | 不安装插件、不动作 | 同左 | 等价于本规格之前 |

## 7. 约束

- 宪法第一条（忠实窗口）：插件只调 DSH 公开客户端服务，不改 DOM、不注入样式、不拦交互；可关闭。
- 宪法第二条（零依赖零构建）：新插件是普通文件 + `dsh/package.json` 声明，不引入依赖与打包器。
- 宪法第三条（禁止静默降级）：AC-6 / AC-7 / AC-8 三个失败分支都必须有中文提示与下一步动作。
- 宪法第四条（安全默认）：`postMessage` 双校验（`origin` + `source`）、字段长度截断、路径形状校验；
  路径只来自 `workspaceFolders[0].uri.fsPath`，不接受页面回传的路径。
- 宪法第五条（兼容不倒退）：服务缺失、握手超时、切换失败均保留旧行为（不切换、不破坏页面）。

## 8. 失败与提示

| 分支 | 用户可见文案（中文，含出路） | 出口动作 |
| --- | --- | --- |
| 握手超时（插件未生效） | 未能自动切换到当前工作区（dsh 插件未生效，请重启 dsh web 后重试）；也可在 DSH 侧栏手动选择工作区。 | 面板顶部「重启 dsh web」按钮 / 命令 |
| 服务缺失（旧版 dsh） | 当前 dsh 版本不支持自动切换工作区，请在 DSH 侧栏手动选择工作区。 | 无（一次性提示，不重试） |
| 切换失败 | 自动切换到工作区「B」失败：<原因>。请在 DSH 侧栏手动选择。 | 同上 |
| 空窗口 | 无提示（非错误） | — |
| 开关关闭 | 无提示（用户显式关闭） | — |

提示一律走 `showWarningMessage`（一次性），不写 `console.log` 了事。

## 9. 风险与开放问题

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| dsh 客户端服务名/签名变化 | 插件静默不生效 | 服务缺失即 `pin-failed:unsupported`（AC-7），并在 plan 记录 0.2.1-rc.2 实测签名 |
| 抢先于 DSH 自身启动恢复 | 可能多出一个空白会话 | 等 `workspaces/sessions` 两路快照 ready 后再判定；已就位则不动作（AC-2） |
| 侧栏与标签页两个 webview 同时活 | 双份切换互相覆盖 | 标签页接管时侧栏让位（既有约束），插件只在收到握手的面板内动作 |
| 空窗口误钉 `~` | 把主目录登记成工作区 | AC-5：无 `workspaceFolders` 时宿主不下发 |

## 10. 验证记录

### 已完成的验证（2026-10-28）

| 项 | 结论 |
| --- | --- |
| `npm test` | 15 套件 / 577 项断言全绿；新套件 `workspace-pin.test.js` 73 项 |
| 插件被 dsh 加载 | 装进真实 web profile 后 `dsh --profile web --dump-config` 出现 `# == dsh-vscode-workspace` / `- id: vscode-workspace`，与既有三个内置插件同构 |
| 安装幂等 | 首次 `ensureWorkspacePlugin()` 返回 true，第二次返回 false；`dsh.profile.bundles` 只有一条，不写 `dependencies` |
| 进程内契约（静态核对，dsh 0.2.1-rc.2） | `ctx.workspaces.create({path})→{workspace,created}`、`ctx.uiWorkspace.openWorkspace(id)`、`sessions.list` 的 `phase/byId[].cwd/retainedBy.mainView` 均与 plan 3.1 一致 |
| 旧行为不倒退 | `buildIframeHtml` 新增可选第 5 参；`dsh-sidebar` / `file-link-*` / `workspace-file-link` 全部原样通过（证明未污染 `ack` 协议） |

### 实机确认（2026-10-28，维护者 F5）

| AC | 结论 |
| --- | --- |
| AC-1 | 通过：换项目后打开面板直接停在当前文件夹对应的工作区 |
| AC-2 | 通过：同项目重开面板不乱切、不多出空白会话 |
| AC-6 | 通过，且表现为**更早的一层**：删掉 `~/.dsh/profiles/web/node_modules/dsh-vscode-workspace` 再打开面板，扩展的 `ensureDshPlugins()` 会把插件补装回去并提示「已自动安装/更新 DSH 插件…请重启 dsh web」，因此看不到 8s 状态栏提示。8s 提示的实际作用是覆盖「文件在盘上、dsh 进程未重启」这个分支（插件 hello 无人应答）。 |

> 本机已把插件装进 `~/.dsh/profiles/web/node_modules/dsh-vscode-workspace` 并登记到 `dsh.profile.bundles`；
> 正在运行的 dsh web 需重启后才会加载（面板顶部「重启 dsh web」）。
