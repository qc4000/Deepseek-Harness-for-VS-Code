# 规格 015：窄容器抽屉态下侧栏裁剪不切对话区、不振荡

| 项 | 内容 |
| --- | --- |
| 编号 | 015 |
| 状态 | implemented |
| 负责人 | @Vithrive |
| 关联 | [spec 004（本规格修订其非目标）](../004-dsh-sidebar-toggle/spec.md) · 上游 dsh `0.2.2-rc.1`（`@deepseek-ai/dsh-client-ui-layout`） |
| 创建 / 更新 | 2026-11-09 / 2026-11-09 |

## 1. 背景与问题

dsh `0.2.2-rc.1` 给左栏布局新增了 **`<768px` 抽屉（drawer）态**（上一版 `0.2.1-rc.5` 无此分支，实测
`npm pack` 对比确认）：侧栏列从「grid 第一轨道」变成 `position:absolute` 浮层，grid 第一轨道为 `0px`，
收起时只做 `transform:translate(-100%)`——**元素矩形宽度仍是浮层宽（≤280px），并不回 0**，frame 上新增
`data-sidebar-drawer`，且 `setViewportWidth` 跨 768 断点会清掉 `narrowExpanded`。

spec 004 的父容器视口裁剪契约是按旧实现写的：`crop = 插件上报的 _sidebarCol 矩形宽 + (折叠 ? 0 : 4)`，
且「侧栏 = grid 轨道」。两者叠加在窄面板里产生两类用户可见故障（2026-11-09 用户实测，`editor.fontSize`
无缩放即 zoom=1，策略 `auto`，手动隐藏/显示并改回 `auto` 后仍复现）：

- **面板宽 488–711px：持续闪烁**。裁剪量改变 iframe 宽度（`#dsh-clip` 负偏移加宽 → iframe = 面板宽 + crop），
  从而改变 DSH 视口，跨过 768 断点在「抽屉 ⇄ 导轨」之间来回翻转：抽屉态上报浮层宽 280 → 裁 280 →
  视口变宽回 grid → 上报导轨 56 → 裁 56 → 视口变窄回抽屉 → …；每跳含 rAF + 跨源 `postMessage` 延迟，
  形成**不收敛的 2-周期回路**。
- **面板宽 < 488px：左边被视口挡住**。抽屉态下对话区从 `x=0` 开始（grid 第一轨道 0），宿主仍按浮层宽裁
  ~280px，切掉的是**对话区左侧 280px**，且收起时侧栏本已在视口外，属于重复隐藏。

spec 004 §12 已记录同类「旧值回写形成振荡」问题并决定暂缓；本次是上游把 768 抽屉接进了同一条回路，
故障从「拖动跨断点瞬间」变成「常态持续」，故立项。根因复盘与固定点数值仿真见 `plan.md` §9。

## 2. 目标

- 抽屉态（frame 带 `data-sidebar-drawer`）下**裁剪量恒为 0**：对话区左缘不被移动，反馈回路天然收敛。
- 抽屉态下顶部工具条按钮与命令 `dshPanel.toggleDshSidebar` 转为**请求 DSH 原生展开/收起**
  （`ctx.layout.toggleSidebar()`，用户选型方案 A），按钮在任何面板宽度都产生可见效果。
- 转调失败必须用户可见（中文状态栏提示 + 出口动作），竞态失败由下一次布局上报自愈。
- 旧插件（dsh web 未重启）/旧 dsh（无抽屉态）保持 004 既有行为，不出现回退。
- 用离线固定点仿真**证明**全宽度扫描下裁剪回路收敛、无 2-周期（004 §12「若后续重做」第 3 条）。

## 3. 非目标

- **不修** spec 004 §12 的另外两个已知问题：拖动跨 1024 断点的瞬闪、非 1 倍字号的 zoom 换算
  （维持暂缓；本环境 zoom=1，用户确认范围只含本次回归）。
- 不在抽屉态做视口裁剪——浮层压在对话区之上，任何按浮层宽的裁剪都必然切对话区，做不到「隐藏且不切」。
- 不改 `auto` 的 1024 断点判定与 `computeHidden` 优先级（手动覆盖 > 配置 > 宽度自适应）。
- 不向 DSH 页面注入脚本、不改 DOM、不拦交互（宪法第一条）；转调只走 `postMessage` + DSH 公开服务。
- 不为 `dshPanel.dshSidebar=show` 场景增加任何介入（该策略下不安装测量插件 = 能力整体关闭）。
- 不主动强制收起用户手动打开的抽屉（除用户显式点本扩展的按钮/命令外，不改 DSH 内部状态）。

## 4. 用户故事

- 作为 **VS Code 用户**，我希望把 DSH 面板拖窄后对话区不缺角、界面不再闪，且顶部按钮始终能显示/隐藏侧栏。
- 作为 **DSH 二次开发者**，我希望本扩展的裁剪只在侧栏真正占 grid 轨道时介入，抽屉态完全交还给 DSH 自己的
  抽屉实现，不再与我的响应式布局打架。
- 作为 **维护者**，我希望这条裁剪↔视口回路有一套离线收敛测试兜底，上游再改布局时能先在测试里暴露。

## 5. 验收标准（必须可执行）

- **AC-1（抽屉态测量取轨道 0）**：Given 插件已握手，frame 带 `data-sidebar-drawer`、
  `grid-template-columns` 第一段为 `0px` 而侧栏矩形为 280，When 触发上报，Then `layout` 消息为
  `{sidebarWidth: 0, collapsed: <原值>, drawer: true}`（不是 280）。
- **AC-2（抽屉态不裁剪）**：Given `dshPanel.dshSidebar=auto|hide` 且收到 `sidebarWidth:0, drawer:true`，
  Then `--dsh-crop` 为 `0px`（对话区左缘不动）；再给 `collapsed:false` 同样为 `0px`（展开的抽屉也不裁）。
- **AC-3（抽屉态按钮转调）**：Given 抽屉态且已握手，When 点工具条按钮（或宿主发 `dsh-sidebar-toggle`），
  Then 向 iframe 发送 `{type:'layout-toggle'}`、**同时**发 `dsh-sidebar-state{hidden: 点击后的可见性取反, reason:'user'}`
  （017 修订：不写覆盖会导致拉宽后又被 auto 藏回去）、裁剪量不变；按钮 `aria-label` 随上报的 `collapsed`
  翻转（关 → 「显示 DSH 侧栏」、开 → 「隐藏 DSH 侧栏」）。
- **AC-4（失败可见 / 竞态自愈）**：Given 插件回 `{type:'layout-toggle-result', ok:false, reason:'unsupported'}`，
  Then webview 向扩展发 `dsh-sidebar-toggle-failed`（reason 白名单），扩展状态栏出现一次中文提示
  （含「重启 dsh web / 升级 dsh」出口）且不重复刷屏；Given `reason:'not-drawer'`，Then 不提示，
  但 webview 必须补发 `request-layout` 由下一次上报纠正按钮状态（收到任何 `layout-toggle-result` 都补发）。
- **AC-5（新旧契约回退）**：Given 上报缺 `drawer` 字段（旧插件）或 frame 无 `data-sidebar-drawer`（旧 dsh），
  Then 行为与 004 完全一致（按钮仍按 `hidden` 切换、裁剪仍按上报宽度）；Given `grid-template-columns`
  不可解析（空/非法），Then 插件回退用侧栏矩形宽上报（004 老路径不丢）。
- **AC-6（回路收敛）**：Given `policy=auto`、zoom=1、面板宽 240–1400px 逐档扫描（覆盖 488–711 故障窗），
  When 用真实中继脚本 + 真实插件源码迭代 `视口 = 面板宽 + crop`、按 dsh 0.2.2 布局模型回喂几何，
  Then 每档 ≤40 次内收敛（连续两次 crop 相同）且全程无重复值（无 2-周期）；收敛值分段为
  `<768 → 0`、`[768,968) → 56`、`≥968 → 284`，并满足 `crop ≤ 轨道 + (折叠 ? 0 : 4)`（永不切对话区）。
- **AC-7（既有行为不回退）**：When 跑 `npm run test:one -- dsh-sidebar`，Then 004 的既有断言
  （show 零介入、未握手不动作、非法测量丢弃、unavailable 提示、拖动重报、安装幂等）全部保持绿色。

## 6. 兼容矩阵

| 场景 | 新版 dsh（0.2.2+ 抽屉） | 旧版 dsh（0.2.1− 无抽屉） | 说明 |
| --- | --- | --- | --- |
| Windows 本地 | 抽屉态不裁剪、按钮转调；grid 态同 004 | 同 004（矩形=轨道，回退路径一致） | webview 无 `data-windows-titlebar` |
| macOS 本地 | 同上 | 同上 | 浏览器/webview 下 `collapsedWidth` 仍为 56 |
| Linux 本地 | 同上（本机验证环境） | 同上 | — |
| WSL Remote | 同上（裁剪发生在本地 webview） | 同上 | — |
| Remote-SSH / Dev Containers | 同上 | 同上 | — |
| 编辑器标签页（≥1024 宽容器） | 不受抽屉态影响（视口 ≥768），行为同 004 | 同 004 | — |
| 旧插件未重启 dsh web（缺 `drawer` 字段） | 暂时回退 004 行为（可能仍左切） | 不适用 | 靠升级安装提示「重启 dsh web」出口 |
| 系统浏览器打开 DSH | 不适用 | 不适用 | 无外层容器、插件未握手不介入 |
| `dshPanel.dshSidebar=show` | 不安装插件、零介入 | 同左 | 能力总开关（回退路径） |

## 7. 约束（引用宪法）

- **第一条（忠实窗口）**：视口裁剪仍只改外层 `#dsh-clip` 的尺寸/偏移；新增的 `layout-toggle` 是
  「宿主自己的按钮 → `postMessage` 协议 → DSH 公开服务 `ctx.layout.toggleSidebar()`」，**不写 DOM、
  不拦交互、未握手惰性**，与 `dsh-vscode-workspace` 调 `ctx.uiWorkspace.openWorkspace` 同类先例；
  能力随 `dshPanel.dshSidebar=show` 整体关闭（不安装本插件）。**本 spec 修订 004 非目标**
  「不调用 `ctx.layout.toggleSidebar()`」，修订记录写入 004 变更历史。
- **第三条（不静默降级）**：转调失败必须状态栏提示并给出口（重启 dsh web / 升级 dsh）；竞态失败必须由
  `request-layout` 立即纠正按钮状态（不允许「点了没反应」）。
- **第四条（兼容不倒退）**：旧插件缺 `drawer` 字段、grid 不可解析、旧 dsh 无 `data-sidebar-drawer`
  三条回退路径都必须保留且有断言。
- **第五条（安全）**：`drawer` 只认 `=== true`；`layout-toggle-result.reason` 只认白名单三值
  （`unsupported`/`not-drawer`/`failed`）并截断；`layout-toggle` 不携带任何用户输入与路径。
- **第六条（可测）**：裁剪数学与收敛判定全部离线可测（AC-6），不依赖真实 VS Code。
- **第七条（发布同步）**：README/CHANGELOG/版本号随发布更新（发版动作需维护者确认）。

## 8. 失败与提示

| 失败场景 | 用户可见提示（中文文案要点） | 出口动作 |
| --- | --- | --- |
| 抽屉态转调，DSH 布局服务缺失/不可调（`unsupported`） | 状态栏「无法切换 DSH 侧栏：DSH 页面布局服务不可用（请点面板顶部「重启 dsh web」，仍无效则升级 dsh 后重试）」，每窗口一次 | 重启 dsh web / 升级 dsh |
| 转调时服务抛错（`failed`） | 状态栏「切换 DSH 侧栏失败：DSH 页面返回错误（请点面板顶部「重启 dsh web」后重试）」，每窗口一次 | 重启 dsh web |
| 转调时已离开抽屉态（`not-drawer`，竞态） | 不提示（宽度已跨断点，按钮语义自动切回裁剪） | webview 补发 `request-layout`，下一次上报立即纠正 |
| 插件已升级但 dsh web 未重启（缺 `drawer` 字段，抽屉态仍可能左切） | 既有安装提示「已自动安装/更新 DSH 插件（…），请点击面板顶部「重启 dsh web」使其生效」 | 用户重启 dsh web |
| 测量插件缺失/未握手 | 既有「DSH 侧栏宽度不可用：本次未隐藏…」状态栏提示 | 重启 dsh web（既有出口） |

## 9. 风险与开放问题

| 风险 / 未知 | 影响 | 应对 / 待验证 |
| --- | --- | --- |
| 上游再改抽屉实现（如轨道不再为 0、换类名） | AC-1/AC-6 的仿真模型与真实不符 | 模型按 dsh `0.2.2-rc.1` 源码行号固化在测试注释里；DSH 升级必须回归本套件（写入 ARCHITECTURE 已知限制） |
| `policy=hide` 且用户在页面内打开抽屉 | 裁剪无法隐藏浮层（非目标不做强制收起） | 抽屉只有用户手动打开才可见；按钮可收起；记为已知限制 |
| 非 1 倍字号（zoom≠1）时轨道/裁剪单位不一致 | 裁剪错位/残留（004 §12 既有问题） | 维持暂缓；本规格不引入新的 zoom 假设，AC 全部在 zoom=1 下定义 |
| `ctx.layout` 反射服务在某些 dsh 版本形状不同 | 转调不可用 | `serviceOf` 属性 → `ctx.get` 双退路 + `unsupported` 提示（与 workspace 插件同构） |

## 10. 验证记录

| 日期 | 方式 | 结论 |
| --- | --- | --- |
| 2026-11-09 | 上游对比：`npm pack @deepseek-ai/dsh-client-ui-layout@0.2.1-rc.5 / 0.2.2-rc.1` diff | 确认 768 抽屉为 0.2.2 新增，旧版无 `data-sidebar-drawer` |
| 2026-11-09 | 用户实测反馈：闪烁面板宽落在 488–711、<488 左侧被视口遮住；auto + 手动覆盖改回 auto 仍复现；zoom=1 | 与仿真故障窗一致，钉死根因口径（`视口 = 面板宽 + crop`） |
| 2026-11-09 | 先红：`TMPDIR=/tmp npm run test:one -- dsh-sidebar`（新增 29 项断言首跑） | 失败于 AC-6：`stage=488 2-周期振荡 crop=280→56→280`（复现通过，与 488–711 实测窗一致） |
| 2026-11-09 | 后绿：`TMPDIR=/tmp npm run test:one -- dsh-sidebar` | 通过：90 项断言（004 既有 61 项不回退） |
| 2026-11-09 | `TMPDIR=/tmp npm test` 全量（22 套离线套件） | 通过：1152 项断言 |
| 2026-11-09 | `npm run test:all`（e2e 真实 dsh 0.2.2-rc.1） | 前 4 步通过（启动/令牌/401 控制组/代理 200/RPC）；第 5 步 `session/page` 游标文案解析失败——**基线对照**（`git worktree` 干净 HEAD 1.1.0 同步同错）确认为既有问题，与本规格无关，留待实机阶段与上游契约核对 |
| 待补 | 实机 F5（窄面板 <488 / 488–711 / ≥768 三段 × 拖动 × 按钮与命令切换 × 重启 dsh web 前后） | 需人工在真实 VS Code webview 中确认 |

## 11. 变更历史

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-11-09 | 初稿（用户拍板方案 A：抽屉态转调 DSH 原生收放；范围不含 004 §12 其余已知问题） | dsh 0.2.2-rc.1 抽屉态与 004 裁剪契约冲突，实测闪烁 + 左切 |
| 2026-11-09 | 实现完成（插件 0.1.1 → 0.2.0、中继抽屉分流、宿主提示、收敛扫描），状态 → implemented；实机 F5 待补 | 先红后绿：`dsh-sidebar` 61 → 90 项，全量 1152 项通过 |
| 2026-11-12 | AC-3 修订：抽屉态点击**同时写覆盖**（原「不写覆盖」） | 拉宽离开抽屉态后被 auto 重新隐藏，由 [spec 017](../017-drawer-manual-override/spec.md) 承接 |
