# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。完整提交历史见 [GitHub](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code/commits/main)。

## 1.0.6

**面板内快捷键（新增）**

- **面板里终于能用 VS Code 快捷键了**：焦点在 DSH 页面里时，`keydown` 只落在跨源 iframe 内、不会冒泡给 VS Code（[microsoft/vscode#65452](https://github.com/microsoft/vscode/issues/65452)），`Ctrl/Cmd+Shift+P`、`Ctrl/Cmd+P` 等一律失效。新增内置插件 `dsh-vscode-keys`：页面侧识别 13 个**工作台级**组合（命令面板、快速打开、资源管理器、侧栏/面板开关、源代码管理、扩展、调试、设置、全局搜索、终端、打开文件、F1），经 webview 中继交给宿主 `executeCommand` 执行。
- **与 DSH 零冲突**：每次按键前读 DSH 自己的键位目录（`ctx.shortcuts.catalog` / `fixedCatalog`，含用户改绑后的结果），命中即让位——`Ctrl/Cmd+Shift+F` 仍是 DSH 的 fork 会话、`Ctrl/Cmd+\`` 仍是 DSH 的终端；在 DSH 快捷键面板（`Ctrl/Cmd+/`）改绑后让位判定立即跟随，不需重启。
- **F6 交还焦点（默认开启）**：交还后可用任意自定义键位与两段式快捷键；办完事点一下面板即回到 DSH。
- **可见、可改**：命令 `DeepSeek Harness: 查看快捷键转发` 列出「生效中 / 已禁用 / 因 DSH 占用而让位」三类清单，并可直接添加/禁用（写入用户设置，立即生效）或复制为 Markdown。新增 `dshPanel.forwardVSCodeKeys`（默认 `true`）、`dshPanel.forwardKeybindings`、`dshPanel.focusReleaseKey`。
- **从编辑器跳回输入框**：新增命令 `dshPanel.focusInput`（默认 `Ctrl+Shift+J`，macOS `⇧⌘J`）：面板未打开时先打开，再把光标直接放进 DSH 输入框（光标停在草稿末尾）；与 `F6` 一出一进。默认键位避开会与 Linux 桌面「显示桌面」冲突的 `Ctrl+Alt+D`，也不带 `Alt`（带 Alt 的组合在终端里会被当 AltGr 字符输入、进不到 workbench）。`dshPanel.focusInputEnabled=false` 可让该键位彻底失效（不占用你的组合，命令仍可调用）；换组合请在「键盘快捷方式」里搜 `dshPanel.focusInput`（VS Code 不支持扩展动态注册键位）。页面侧优先 `conversation.input.for(ctx).focus()`，不可用时按 composer 区域的输入控件回退，都失败则状态栏提示（不静默）。
- **面板没打开时也能一键到位**：面板未打开时按 `<视图 id>.focus` → `workbench.view.extension.<容器 id>` → `getCommands()` 探测 这个顺序尝试，并以「视图真的解析出来」作为成功信号；**不使用 `workbench.action.openView`**（它弹的是视图选择器）。仍失败时提示里列出实际尝试过的命令 id，便于定位环境差异。刚创建的 webview 会等一拍（250ms）并无回执时重试一次。
- **不抢 DSH 弹窗里的按键**：DSH 的快捷键设置（按键录制）、审批等弹窗打开时插件完全不接管键盘（`dsh-vscode-keys` 0.2.0），否则录制 `Ctrl+Shift+,` 这类键会被转发走。
- **排障接口**：面板 DevTools 里 `__dshVscodeKeys.status()` / `.bindings()` / `.owner('Comma|1|0|0|1')` / `.rows()` / `.prefs()` / `.refresh()` 可查看「我们认定的 DSH 键位」、DSH 实际绑定与持久化原文（`dsh.keybindings.v1`），便于确认「到底有没有让位」。
- 不支持两段式（`ctrl+k ctrl+s`），也不读用户 `keybindings.json`（Remote 下文件在客户端、扩展在服务端）；配置里的非法条目逐条忽略并一次性提示；命令不存在时状态栏提示一次并指出检查位置。

**忠实窗口（面板）**

- **修复面板内 DSH「复制」按钮无法复制**：代码块、消息操作条、JSON 复制都走 `navigator.clipboard.writeText`，而 VS Code 的权限策略会拒绝 webview 内层跨源 iframe（[microsoft/vscode#182642](https://github.com/microsoft/vscode/issues/182642)）；DSH 捕获失败后直接返回、不再回退，表现为「点了复制没反应」。内置插件 `dsh-webview-clipboard` 升级到 0.3.0（全平台生效）：包装 `writeText`，按「原生 → 宿主 `vscode.env.clipboard` → `execCommand`」三级回退，只在面板内嵌时接管，系统浏览器直开 DSH 行为不变。
- 复制失败不再静默：宿主写剪贴板抛错或文本超过 1 MiB 时，状态栏提示一次并给出「选中文本后按 Ctrl+C（⌘C）」的出路。
- 旧的 macOS ⌘C/⌘V/⌘X 快捷键修复保留，两套能力共存。
- **同步上游能力：官网 Windows 桌面版启动**：自动从注册表/常见默认目录定位桌面版内置 CLI，按 `dshPanel.dshCommand` → 桌面版 CLI → `npx` 的顺序启动，不需要 PATH / npm / Node；桌面版起的实例仍是 web profile，会话与凭据共享。
- **同步上游能力：Remote-SSH / Dev Containers 受管认证代理**：真远程下按「`dshPanel.url` 是否回环」判定代理可用，面板经 `asExternalUri` 转发加载；远程模式只放行已转发 authority 的请求，扩展自身请求带一次性密钥头。新增 `dshPanel.remoteAuthProxy`（默认 `true`），多用户共享服务器建议关闭。
- **同步上游能力：远端面板用本机浏览器登录 DeepSeek 账号**：新增内置插件 `dsh-vscode-open-external`，接管 DSH 页面的 `window.open`，把授权链接交给 `vscode.env.openExternal` 在客户端（WSL/Remote 下即本机）浏览器打开；只转交 http(s) 链接，仅握手后接管，新增 `dshPanel.installOpenExternalPlugin`（默认 `true`）。

**测试**

- 新增 `test/key-bridge.test.js`（96 项）：`normalizeCombo` 三平台展开与 chord/无修饰键拒绝、配置逐条校验与 64 条上限、默认表合并与禁用、`vm` 真跑中继（`keys-ack`、gesture 白名单、F6 交还焦点、配置热更新、`focus-input` 链路）、宿主只按自己的表执行命令与失败提示只一次、`requestInputFocus` 回执/超时/抢占、面板未打开时的打开兜底与可操作提示、贡献点与 `setContext` 同步。
- 新增 `test/key-bridge-client.test.js`（55 项）：插件客户端仿真（未握手不介入、只上报物理键事实、DSH 目录让位与订阅跟随、降级仍转发、DSH 弹窗内不抢键、排障 API、`focus-input` 服务→DOM→失败三级、IME/长按/页面已处理不拦、独立浏览器不介入）。
- 同步上游测试：新增 `desktop-app-support`、`remote-auth-proxy`、`open-external-plugin` 三套，重写 `remote-mode` 断言。
- 新增 `test/clipboard-bridge.test.js`（16 项）：中继转发与 origin/source 双校验、超长拒绝与回执、宿主写入成功/失败、失败提示只一次。
- `test/clipboard-plugin.test.js` 扩到 42 项：新增客户端仿真（原生成功不发消息、原生被拒走宿主、无回执/`ok:false` 走 `execCommand`、非 iframe 不接管、未知 token 忽略）。合并上游后全量 19 套 / 746 项断言。
- 规格：[007-webview-clipboard-copy](docs/sdd/specs/007-webview-clipboard-copy/spec.md)。
- 规格：[008-webview-keybridge](docs/sdd/specs/008-webview-keybridge/spec.md)。
- 候选规格：[009-auto-focus-on-enter](docs/sdd/specs/009-auto-focus-on-enter/spec.md)（草稿，暂缓：焦点进入面板时自动激活输入框）。

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
