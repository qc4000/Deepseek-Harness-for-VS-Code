# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。完整提交历史见 [GitHub](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code/commits/main)。

## 1.0.5

**忠实窗口（面板）**

- **打开面板就把 DSH 工作区切到当前 VS Code 文件夹**：DSH 的「当前工作区」由页面自己恢复（上次的选择 → 最近活跃工作区），进程 cwd 与 `workspace/create` 都改不了它，所以在 A 项目用完后换到 B 项目，面板仍停在 A。现在由新增内置插件 `dsh-vscode-workspace`（可关闭）在页面侧调 DSH 公开客户端服务完成切换：已在该工作区时不动（不新建多余会话），否则先幂等注册再打开。
- 新配置 `dshPanel.pinWorkspaceToVSCode`（默认 `true`）：关闭后不安装插件、不下发路径、不切换，行为与 1.0.4 一致；空窗口（未打开文件夹）不会把主目录钉成工作区。
- **失败都可见**：插件装了但没重启 dsh web（8 秒无回执）、旧版 dsh 缺客户端服务、切换抛错，各有中文状态栏提示与出路（手动在 DSH 侧栏选择）。
- `dshPanel.autoRegisterWorkspace` 的说明修正为「只登记，不改变 DSH 当前选中的工作区」。

**测试**

- 新增 `test/workspace-pin.test.js`（73 项）：插件声明与零干预约束、路径形状、中继协议（来源校验/超时/白名单/截断）、客户端仿真（惰性、切换、已就位、服务缺失、失败、轮询、幂等）、安装幂等。全量 15 套 / 577 项断言。
- 规格：[006-dsh-workspace-pin](docs/sdd/specs/006-dsh-workspace-pin/spec.md)。

## 1.0.4

**忠实窗口（面板）**

- **新增 `dshPanel.workspaceFileLinkAction = diffAndOpen`：点击对话里的文件链接直接看变更**，不再只是打开原文件。数据按三级降级：① 轮级——点击那条消息所属轮次的开始/结束原文（标题如 `a.ts · 第 7 轮`）；② 工作树 vs `HEAD`（标题写明 `与 HEAD 的差异`）；③ 普通打开（1.0.x 行为）。默认值仍为 `revealAndOpen`，需主动切换。
- **轮级数据来源**：新增内置插件 `dsh-vscode-changes`（仅宿主半边，随扩展分发、不经 npm），从 DSH 进程内的会话记录取出两侧全文，经一条鉴权路由交给扩展；只按「会话 + 轮 + 已记录的文件清单」匹配，不接受任意路径读盘；单侧 1 MiB 上限。
- **历史轮也能看**：会话存活期间，任意历史轮的 diff 都能在 VS Code 里并排展示；重启 dsh web / 会话释放后自动退回 `与 HEAD 的差异` 并提示。
- **不双开**：取数慢于 2.5 s 时宿主先回「已接单」（`reveal-ack`），客户端把等待放宽到 6 s 再回放点击，避免 diff 与 DSH 侧栏同时打开。
- **降级都可见**：二进制、单侧 > 1 MiB、本轮没改过、插件未安装（需重启 dsh web）、非 Git 仓库，各自有中文状态栏提示与下一步动作。

**测试**

- 新增 `test/dsh-changes-plugin.test.js`（45 项）与 `test/file-link-diff.test.js`（74 项）；扩充 `file-link-bridge`（37）、`file-link-client-sim`（46）、`workspace-file-link`（84）。全量 14 套 / 504 项断言。
- 规格：[005-file-link-turn-diff](docs/sdd/specs/005-file-link-turn-diff/spec.md)。

## 1.0.3

**修复（回退）**

- **回退 1.0.2 的侧栏裁剪改动**：该版本在拖动 VS Code 侧边栏时会令 DSH 侧栏闪烁、无法正常隐藏，缩窄时也不能在原有宽度自动隐藏。现已恢复 1.0.1 的裁剪行为（`crop = 侧栏宽度 + 4`，与字号无关），面板布局、配置项、按钮与命令均不变。
- 仅保留测量插件 0.1.1 的接口改进（宿主可强制请求上报，当前版本不调用），避免额外重启 dsh web。
- **已知遗留**：非默认字号（如 20）下侧栏会露出几十像素——需先用实测量自校准（插件上报 `innerWidth`，父容器量 iframe 实际宽度求真实倍率）验证 CSS zoom 语义，再重做换算，不在本版盲改。

## 1.0.2（已回退，见 1.0.3）

- 曾尝试：裁剪量按 zoom 换算 + 跨断点预测 + `request-layout` 校正。
- 回退原因：缩放换算依赖未实测的 CSS zoom 语义，预测值与实际测量形成反馈回路，表现为拖动时闪烁、不隐藏。

## 1.0.1

**忠实窗口（面板）**

- **面板顶部新增 28px 工具条 + 「隐藏/显示 DSH 左侧栏」按钮**：隐藏时对话区占满面板宽度；`dshPanel.dshSidebar=auto`（默认）在窄于 1024px 的面板（侧边栏、底部面板）自动隐藏，编辑器标签页保持显示；手动切换在窗口重载后保持，修改配置会清除手动选择。
- **零注入**：隐藏由父容器视口裁剪实现（iframe 加宽 + 左移 + `overflow:hidden` 裁切），不改 DSH 页面的 DOM、事件与状态。
- **宽度实时跟随**：新增内置只读测量插件 `dsh-vscode-layout`（随扩展分发，不经 npm）——在 DSH 里拖动分隔条（264–420px）、折叠成导轨（56px）、改变面板宽度之后，隐藏依然精确；展开态额外裁 4px，避开 DSH 拖动手柄热区。
- **失败不静默**：测量不可用时不裁剪并在状态栏提示一次；`dshPanel.dshSidebar=show` 时完全不介入（不安装测量插件、不裁剪、不显示工具条）。
- 新增命令「DeepSeek Harness: 切换 DSH 侧栏显示」(`dshPanel.toggleDshSidebar`)，可用命令面板 / 快捷键切换。

**测试**

- 新增 `test/dsh-sidebar.test.js`（61 项断言）：中继脚本 `vm` 真跑（策略 / 测量 / 按钮 / 消息 / 未测量兜底）、测量插件仿真（握手 / 上报 / 折叠 / 卸载）、插件分发与安装幂等；全量 12 套 / 343 项断言。

## 1.0.0 —— 第一个正式版本

**Copilot 桥接**

- **修复：在 Copilot 里能转接到 DSH、却收不到回答**——dsh 0.2.x 起助手正文改为「每个 step 一条 `assistant/message`」事件（正文在 `data.message.content` 的 `text` 块里），旧的 `assistant/chunk` 增量通道不再发送。扩展现在两代协议都认，实时轮询与历史回放共用同一套事件消费逻辑；某一轮结束却没有正文时会在回答里明确提示，不再静默空白。
- **模型条目对齐 DeepSeek 现役模型**：选择器里只保留现役条目——`DSH (DeepSeek Harness)`（跟随 DSH 设置）、`DeepSeek-V4.1-Flash (DSH)`（DSH 模型 id `deepseek-flash`）、`DeepSeek-V4-Pro (DSH)`（`deepseek-v4-pro`）；退役的 `DeepSeek-V4-Flash (DSH)` / `deepseek-v4-flash-vision-exp (DSH)` 条目移除，旧条目 id 仍解析到 `deepseek-flash`。
- **映射漂移自检**：每次会话首次提问时读一次 DSH 的 `session/modelCatalog`，条目与 DSH 在册模型失配时直接告警（DSH 的 `session.selectModel` 校验失败原本会静默回落默认模型）。
- 成本信息按 DeepSeek 调价后的价格更新；上下文/输出上限对齐 DSH 模型配置（1M / 384K）。

**忠实窗口（面板）**

- **点击对话里的工作区文件/文件夹链接 → 在 VS Code 资源管理器中定位并打开**：新增内置 DSH 插件 `dsh-vscode-file-links`（随扩展分发，不经 npm）。只有目标位于当前工作区且真实存在时才接管，否则自动回落到 DSH 侧边栏行为；`Ctrl/Cmd/Shift/Alt` + 点击可强制走 DSH 行为。行为由 `dshPanel.workspaceFileLinkAction` 控制（`revealAndOpen` / `revealOnly` / `off`）。

**测试**

- 11 套单测（280+ 项断言）覆盖面板桥接、路径解析、模型映射、事件消费、认证代理、配置净化等；另有真实 dsh 实例的端到端回归（含模型在册校验）。

## 0.8.45

- 从 VS Code 资源管理器拖拽文件到对话框时，引用源文件本身（`dsh-drop-caret` 0.2.3）。

## 0.8.44

- WSL Remote 场景启用受管认证代理；Remote 无代理时引导可达。

## 0.8.42 / 0.8.40

- 安全加固：配置输入净化、POSIX 场景去掉 shell 执行（采纳 PR #12 报告的第二层防御）。

## 0.8.41

- macOS 面板内 ⌘C/⌘V/⌘X 修复收敛范围为剪贴板三键（PR #14，内置插件 `dsh-webview-clipboard` 0.2.1）。

## 0.7.13

- Copilot 桥接首次发布：把 DSH 注册为 Copilot 聊天模型（`DSH (DeepSeek Harness)`）。
