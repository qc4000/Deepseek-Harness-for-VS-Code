# 规格 008：面板内 VS Code 快捷键转发（跨源 iframe 键位桥）

| 项 | 内容 |
| --- | --- |
| 编号 | 008 |
| 状态 | implemented |
| 负责人 | @vithrive |
| 关联 | 与 `007-webview-clipboard-copy` 同根因（跨源 iframe 吞事件） |
| 创建 / 更新 | 2026-10-29 / 2026-10-29 |

## 1. 背景与问题

面板结构是 `workbench → webview（vscode-webview://）→ iframe（http://127.0.0.1:3080，跨源 DSH）`。
VS Code 只在 **webview 自身文档**上收集 `keydown` 并回传 workbench；焦点落在内层跨源 iframe 里时，
按键只派发给 DSH 自己的 document，不会冒泡到外层，workbench 根本收不到这次按键。
因此 `contributes.keybindings`、`when: focusWebview` 一类手段在面板内全部失效——上游结论见
microsoft/vscode#65452：「If the user is focused on the iframe in the webview, now all keypresses go to the
iframe. The webview containing the iframe does not get any.」

用户影响：在面板里对话/写代码时，`Ctrl/Cmd+Shift+P`、`Ctrl/Cmd+P`、`Ctrl/Cmd+B` 等一律无效，
必须先点编辑器把焦点移出去——这直接破坏了「面板就是工作区的一部分」的使用方式。

同根因的既有先例：`dsh-webview-clipboard`（spec 007）已经在页面侧接管 ⌘C/⌘V/⌘X 与复制按钮，
证明「页面内插件 + webview 中继 + 宿主动作」这条链路可行，本规格沿用同一套架构。

DSH 侧已有快捷键注册表 `@deepseek-ai/dsh-client-shortcuts`（cordis 服务名 `shortcuts`，0.2.1-rc.2 实测），
对外暴露 `catalog`（每个命令的生效绑定，含用户改绑）、`fixedCatalog`（固定动作，如输入框 `Enter`）、
`describeBinding(binding)`（返回 `conflicts`）——本规格以它作为冲突判定的唯一依据。

## 2. 目标

- 面板内按下第一批 / 第二批工作台级快捷键，直接在 VS Code 侧执行，无需先点编辑器。
- 与 DSH 已占用的键位**零冲突**：命中 DSH 目录即让位，且用户改绑 DSH 键位后立即跟随。
- 用户能看到「生效中 / 我新增的 / 已禁用 / 因 DSH 占用而让位」四类清单，并能在同一入口新增或禁用。
- 提供 ⌘/Ctrl 之外的一条兜底：`F6` 把焦点交还 VS Code，此后任意键位（含 chord）原生可用。
- 关闭开关后，行为与本能力不存在时**完全一致**（不写插件文件、不握手、不监听、F6 原生）。

## 3. 非目标

- **不支持两段式（chord）**：`ctrl+k ctrl+s` 这类序列需要页面侧前缀状态机，会与 DSH 自己的
  `secondCode` 序列、`stopSequenceMs`、blur 重置互相干扰；收益低（chord 命令多为编辑器级）。
  配置里写了会明确提示而不是静默。
- **不做 `"ctrl+h": true` 自动解析**：VS Code 无公开 API 把键位反查成命令 id；读用户
  `keybindings.json` 在 Remote 下不可行（文件在客户端、扩展在服务端），行为随环境变化比不支持更糟。
  用户改命令通过「命令面板 → 复制命令 ID」或 `keyStatus` 的命令搜索完成。
- **不转发**无修饰键、单字母、`Enter`/`Escape`/`Tab`/`Space` 与所有编辑键（会破坏 DSH 输入框）。
- 不在本规格做 DSH 侧键位改绑 UI（用 DSH 自带快捷键面板，`Ctrl/Cmd+/`）。
- 不做按键宏、序列回放、跨窗口广播。

## 4. 用户故事

- 作为 **VS Code 用户**，我希望在 DSH 面板里直接按命令面板/快速打开/侧栏快捷键，以便不用把焦点移出去。
- 作为 **键盘党**，我希望有一键把焦点交还 VS Code，以便使用我自定义的、以及 chord 形式的键位。
- 作为 **DSH 二次开发者**，我希望面板不抢 DSH 自己的快捷键，且我不需要在两边维护对照表。
- 作为 **维护者**，我希望冲突判定依赖 DSH 的注册表而不是硬编码，以便 DSH 升级后不自作聪明。

## 5. 验收标准（必须可执行）

- **AC-1**：Given `dshPanel.forwardVSCodeKeys` 未设置（默认开）且面板已握手，When 页面发来
  `mod+shift+p` 对应的 gesture，Then 宿主执行 `workbench.action.showCommands`，且中继把这条消息
  送进宿主（`toHost` 里恰好一条 `dsh-forwarded-key`）。
- **AC-2**：Given DSH 的 `catalog` 里 `session.fork` 绑定了 `primary+shift+F`（页面把 `meta+shift+KeyF` 记入
  让位索引），When 用户按下该组合，Then 页面不 `preventDefault`、不发 `key` 消息、并把该组合记入让位清单。
- **AC-3**：Given `dshPanel.forwardVSCodeKeys=false`，When 渲染面板 HTML，Then 中继脚本中
  `keysEnabled` 为 false（不下发表、不回 `keys-ack`），且宿主不安装/不更新 `dsh-vscode-keys` 插件。
- **AC-4**：Given 用户配置 `{"ctrl+shift+y":"workbench.action.togglePanel"}`，When 按下
  `Ctrl+Shift+Y`，Then 执行该命令；Given 配置 `{"ctrl+shift+f": false}`，Then `Ctrl+Shift+F` 不转发
  （即使默认表里有）。
- **AC-5**：Given 配置非对象 / 值不是字符串或 `false`（含 `true`）/ 命令 id 不合
  `^[a-z][a-zA-Z0-9_.\-]*$` / 键名无法解析 / 超过 64 条，When 加载，Then 忽略这些条目、其余照常生效，
  并一次性提示「已忽略 N 条快捷键配置」。
- **AC-6**：Given 页面发来的 gesture 字段非法（`code` 非 `^[A-Za-z0-9]{1,16}$`、修饰键非布尔、
  或带 `command` 等额外字段），When 宿主处理，Then 不执行任何命令（宿主只按自己的表查，绝不采信页面给的命令 id）。
- **AC-7**：Given 用户按下 `F6`（`focusReleaseKey` 默认值），When 面板有焦点，Then 中继执行
  `frame.blur()` 与 `#dsh-stage.focus()`，宿主状态栏提示一次「焦点已交给 VS Code…」。
- **AC-8**：Given 用户执行 `dshPanel.keyStatus`，Then 列出四分组（生效中 / 新增或覆盖 / 已禁用 /
  让位给 DSH）；面板未打开时只列静态部分并说明「打开面板后可查看让位清单」；选择「添加转发键…」
  可写入用户设置（Global）并立即生效。
- **AC-9**：Given 修改 `forwardKeybindings` / `forwardVSCodeKeys` / `focusReleaseKey`，When 配置变更，
  Then 宿主向面板推送 `dsh-keys-config`，中继据此更新表并转发 `keys-ack`，**不重载 iframe**。
- **AC-10**：Given 插件未安装或未握手（旧版 dsh / 装了没重启），When 用户打开 `keyStatus`，
  Then 明确显示「快捷键转发未生效：请点面板「重启 dsh web」」。
- **AC-11**：Given 插件在**独立浏览器**里打开 DSH（`window.parent === window`），Then 不打招呼、
  不挂 keydown、不改变任何行为。
- **AC-12**：Given DSH 页面上有打开的弹窗（`[aria-modal="true"]`，典型：快捷键设置的「按键录制」），
  When 用户按键，Then 插件不拦截、不转发（把键盘完整还给页面），避免抢掉 DSH 自己的按键录制。
- **AC-13**：Given 焦点在编辑器且面板已加载，When 执行 `dshPanel.focusInput`，Then 视图先按 `show(false)` /
  `reveal(col, false)` 获得焦点，再向 webview 发 `dsh-focus-input`；页面回执 `ok:true` 时不打扰用户。
  Given 面板从未打开，Then 按 `<viewId>.focus` → `workbench.view.extension.<容器 id>` → `getCommands()` 探测
  这个顺序尝试，以「视图真的解析出来」为成功信号；**不得**用 `workbench.action.openView` 兜底（它弹出视图选择器）；
  仍失败时提示里带上实际尝试过的命令 id（便于定位环境差异）。
- **AC-14**：Given `dshPanel.focusInputEnabled=false`，Then 默认键位 `Ctrl+Shift+J` / `⇧⌘J` 彻底不生效
  （`when: dshPanelFocusInput` 为 false，`setContext` 同步），命令本身仍可从命令面板调用。
  默认值不得含 `Alt`（终端把它当 AltGr 字符输入）且不得碰 Linux 桌面的「显示桌面」组合。
- **AC-15**：Given 页面 1.2s 内没回执（插件未生效），When 执行该命令，Then 状态栏提示一次并指出
  「点重启 dsh web 后重试」，**不静默**。

## 6. 兼容矩阵

| 场景 | 新版 dsh | 旧版 dsh | 说明 |
| --- | --- | --- | --- |
| Windows 本地 | 转发 + 让位（web 默认键位） | 转发（无目录，降级静态表 + 提示） | `mod` 展开为 `ctrl` |
| macOS 本地 | 同上，`mod` 展开为 `meta` | 同上 | |
| Linux 本地 | 转发；DSH web 多数命令未声明 `web:linux`，让位清单通常为空 | 同上 | 以运行时目录为准 |
| WSL Remote | 与本地一致（扩展跑在 WSL） | 同上 | |
| Remote-SSH / Dev Containers | 与本地一致（扩展跑在服务器，插件写在服务器 `~/.dsh`） | 同上 | 不读客户端 keybindings.json |
| 系统浏览器打开 DSH（非面板内） | 不介入（AC-11） | 不适用 | `parent === self` |

## 7. 约束（引用宪法）

- **宪法第一条（忠实窗口）**：本能力是「随包分发、默认开启但可关闭的内置插件」，遵守
  `只读监听 + 握手后生效 + 失败即不拦截`：未收到 `keys-ack` 前不挂 keydown；命中 DSH 目录即放行；
  新增 DOM 写入仅限外层 webview 自己的 `#dsh-stage`（`tabindex="-1"`），不触碰 DSH 页面。
- **宪法第二条（零依赖）**：只用 `vscode` + Node 内置模块；插件为纯 ES5 客户端脚本。
- **宪法第三条（禁止静默降级）**：配置非法、命令不存在、插件未生效、`shortcuts` 服务缺失，
  全部产出可见信号（状态栏 / QuickPick 说明 / 一次性 warning）。
- **配置开关**：
  | 配置 | 默认 | 关闭后 |
  | --- | --- | --- |
  | `dshPanel.forwardVSCodeKeys` | `true` | 不安装/不更新插件、不握手、页面不监听、F6 原生 |
  | `dshPanel.forwardKeybindings` | `{}` | 仅默认表生效；条目为 `false` 时该组合永不拦截 |
  | `dshPanel.focusReleaseKey` | `"F6"` | 空串 = 关闭焦点交还，转发不受影响 |
- **安全**：页面 → 中继 → 宿主三跳都做 `origin` + `source` 校验；gesture 字段白名单 + 类型 + 长度；
  宿主**只按自己的表**把 gesture 映射成命令，页面无法指定任意命令 id；命令 id 仅格式校验、不传参。

## 8. 失败与提示

| 失败场景 | 用户可见提示（中文文案要点） | 出口动作 |
| --- | --- | --- |
| `forwardKeybindings` 有条目非法 | 状态栏一次性「已忽略 N 条快捷键配置（格式不正确或命令 id 非法）」 | 打开设置改；`keyStatus` 里可复制 Markdown 对照 |
| 命令 id 不存在（扩展已卸载等） | 状态栏「未找到命令 xxx，请检查 `dshPanel.forwardKeybindings`」每个 id 只提示一次 | 用 `keyStatus` 的命令搜索重选 |
| 插件未生效（旧版 dsh / 未重启） | `keyStatus` 首行「快捷键转发未生效：请点面板「重启 dsh web」」 | 重启 dsh web；或确认开关 |
| DSH 无 `shortcuts` 服务 | `keyStatus` 标注「降级模式：无法读取 DSH 键位表，可能与 DSH 冲突」 | 升级 dsh |
| 中继收到非法 gesture | 丢弃，不提示（页面被篡改属于异常路径），计数进诊断 | — |

## 9. 风险与开放问题

| 风险 / 未知 | 影响 | 应对 / 待验证 |
| --- | --- | --- |
| DSH 内部契约（`shortcuts.catalog` / `describeBinding`）变更 | 让位失效 → 抢 DSH 的键 | 页面侧对服务与字段做能力探测，不符即降级并把状态回报宿主；`keyStatus` 显示降级 |
| `F6` 与 VS Code `focusNextPart` 语义重叠 | 交还焦点后再按 F6 会按 VS Code 规则继续移动焦点 | 文档写明；`focusReleaseKey` 可改 |
| 首次升级需重启 dsh web | 用户以为没生效 | 沿用现有「已安装/更新插件，请重启」提示；`keyStatus` 二次兜底 |
| Linux web 端 DSH 默认绑定缺失（`defaults[runtime:platform]` 无回退） | 让位清单可能为空 | 以运行时目录为准，不做静态假设；Linux 上 DSH 只允许 `Ctrl+/`、`Ctrl+Shift+,`、`Ctrl+Shift+.` 三种绑定，其中只有 `Ctrl+/` 有默认值 |

## 10. 验证记录

| 日期 | 方式 | 结论 |
| --- | --- | --- |
| 2026-10-29 | `npm test`（`key-bridge` 103 项 + `key-bridge-client` 55 项，共 21 套 / 904 项） | 通过 |
| 2026-10-29 | `npm run test:all`（e2e） | 不适用（不涉及 DSH RPC 契约；DSH `shortcuts` 目录由 L3 仿真覆盖） |
| 2026-10-30 | 实机 F5（Linux 本地，VS Code 当前稳定版，1.0.6-dev.10） | 通过：面板关着时按 `Ctrl+Shift+J` 能打开并聚焦输入框；生效命令为 `dsh.webview.focus`（`workbench.view.extension.dsh-panel` 能 resolve 但不切换） |
| 2026-10-29 | 实机 F5（Linux 本地，dsh 0.2.1-rc.2，1.0.6-dev.5） | 通过：命中 DSH 目录即让位（`Ctrl+/` 仍打开 DSH 快捷键面板，`__dshVscodeKeys.owner('Slash|1|0|0|0')` 返回命令 id）；`Ctrl+Shift+,` 因 DSH 无 `web:linux` 默认绑定而被转发（预期行为）；转发表与 F6 主链路可用 |

## 11. 变更历史

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-10-29 | 初稿 | 面板内快捷键失效（跨源 iframe 吞 keydown） |
| 2026-10-29 | 去掉 `true` 自动解析与键位镜像表 | 用户决策：只接受命令 id 或 `false` |
| 2026-10-29 | 插件 0.2.0：弹窗内不抢键 + 排障 API | 真机反馈「在 DSH 里绑键时我们的转发抢走了按键」与「改绑后看不出是否让位」 |
| 2026-10-29 | 插件 0.2.1：排障 API 扩到 `rows()` / `prefs()` | 真机排查「改绑后仍无让位」时需看到 DSH 实际持久化的绑定与 profile |
| 2026-10-29 | 新增 `dshPanel.focusInput` + `dshPanel.focusInputEnabled`（插件 0.3.0） | 反向环路：F6 交还焦点后一键跳回输入框；焦点入面板自动激活列为候选规格 009 |
| 2026-10-29 | 默认键位 `Ctrl+Alt+D` 改为 `Ctrl+Shift+J` | 真机反馈：`Ctrl+Alt+D` 被 Linux 桌面「显示桌面」抢走；`Ctrl+Shift+Alt+D` 在终端里被当 AltGr 字符输入而失效 |
| 2026-10-29 | 面板未打开时的打开逻辑加验证与兜底 | 真机反馈：按快捷键只展开侧栏、停在别的视图（容器命令不报错但不生效） |
| 2026-10-29 | 容器命令改为 `getCommands()` 探测；移除 openView 兜底 | 真机反馈：兜底会弹出视图选择器（截图确认），且硬编码容器 id 可能猜不中 |
| 2026-10-30 | 首选 `<viewId>.focus`，容器命令降为第二候选；失败提示列出已试命令 | 真机反馈：容器已固定但容器命令仍不切换（环境差异），需更精确的视图级命令与可诊断输出 |
| 2026-10-30 | 记录「实际生效的打开命令」并在 `keyStatus` 展示 | 真机确认：`dsh.webview.focus` 生效、`workbench.view.extension.dsh-panel` 能 resolve 但不切换 |
