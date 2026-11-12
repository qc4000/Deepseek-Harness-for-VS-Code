# 技术方案 015：窄容器抽屉态下侧栏裁剪不切对话区、不振荡

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：approved） |
| 负责人 | @Vithrive |
| 更新 | 2026-11-09 |

## 1. 方案概述

把「该裁多少」的口径从**侧栏元素矩形宽**换成 **frame 的 grid 第一轨道宽**：抽屉态轨道为 `0` → 裁剪量
自然为 0（对话区从 `x=0` 起，一个像素都不动），裁剪↔视口回路因此只有一个固定点、不再有 2-周期；
导轨 `56` / 展开 `264–420` 两条老路径上「矩形 = 轨道」，数值与 004 完全一致。抽屉态下裁剪无法隐藏浮层，
于是顶部按钮/命令改为经宿主消息转调 DSH 原生 `ctx.layout.toggleSidebar()`（方案 A），按钮在任何宽度都
真实有效；转调失败走状态栏提示，竞态用 `request-layout` 自愈。

```
dsh 布局（0.2.2 抽屉态） → dsh-vscode-layout（轨道优先测量 + drawer 标志）
    → postMessage layout → webview 中继（cropPixels / 按钮语义分流） → #dsh-crop 或 layout-toggle
    → ctx.layout.toggleSidebar() → dsh 再布局 → 下一帧上报闭环
```

## 2. 影响面

| 文件 / 函数 | 改动性质 | 触碰安全数据流 | 对应 AC |
| --- | --- | --- | --- |
| `extension.js` `buildIframeHtml` 中继脚本：`measured` 增 `drawer`、`displayedState()`/`toggleSidebarNow()` 分流、`updateToggle` 改按显示态、新增 `layout-toggle-result` 处理、`dsh-sidebar-toggle-failed` 上报 | 修改 | webview（消息） | AC-2、AC-3、AC-4 |
| `extension.js` `handleWebviewMessage`：新增 `dsh-sidebar-toggle-failed` 分支 + 每窗口一次的提示标志 | 新增 | 否 | AC-4 |
| `dsh-plugins/dsh-vscode-layout/lib/client.js`：`measure()` 轨道优先 + 矩形回退、上报 `drawer`、`serviceOf` + `layout-toggle` 转调与 `layout-toggle-result` 回执 | 修改 | 否（页面内公开服务） | AC-1、AC-3、AC-4、AC-5 |
| `dsh-plugins/dsh-vscode-layout/package.json`：`0.1.1 → 0.2.0`（协议小版本：新增字段与消息类型） | 修改 | 否 | 升级触达 |
| `test/dsh-sidebar.test.js`：中继抽屉态断言、插件轨道/抽屉/转调仿真、`handleWebviewMessage` 提示、全宽度收敛扫描 | 扩展 | — | 全部 |
| `docs/ARCHITECTURE.md` §3/§9、`docs/TESTING.md` 测试地图、`docs/sdd/specs/004-*/spec.md`（非目标修订 + 变更历史） | 更新 | — | — |
| `README.md` / `CHANGELOG.md` / `package.json` 版本 | **发布阶段**（需维护者确认，不在本次自动执行） | — | — |

## 3. 契约变更与兼容

| 契约 | 新形态 | 旧形态 / 回退 | 探测方式 |
| --- | --- | --- | --- |
| 插件 → 宿主 `layout` 消息 | 增 `drawer: boolean`；`sidebarWidth` 语义改为 **grid 第一轨道宽**（抽屉态 0） | 旧插件无 `drawer` 字段 → 宿主按 004 老语义（矩形=轨道）继续 | `data.drawer === true` 才走新分支，缺字段即旧行为 |
| 宿主 → 插件 `layout-toggle` | 抽屉态请求原生收/放 | 旧插件 `onMessage` 只认 `ack`/`request-layout`，未知 type 直接忽略（无副作用） | 宿主只在 `drawer===true` 时发送（双重保险） |
| 插件 → 宿主 `layout-toggle-result` | `ok` + `reason ∈ {unsupported, not-drawer, failed}` | 旧宿主读不到 `sidebarWidth` 会整条丢弃（既有校验天然兼容） | 字段类型 + reason 白名单 |
| 插件测量口径 | `getComputedStyle(frame).gridTemplateColumns` 第一段优先 | 解析失败（空/非法）→ 回退 `getBoundingClientRect().width`（004 老路径） | `parseFloat` 合法且 ≥0 才采纳 |
| 宿主 → 扩展 `dsh-sidebar-toggle-failed` | `reason` 白名单，状态栏一次 | 旧扩展会忽略未知 type（不可能组合：插件随扩展同版本分发） | `handleWebviewMessage` 白名单校验 |
| 配置项 | 无新增（复用 `dshPanel.dshSidebar`，`show` = 能力总关） | — | — |

## 4. 状态与并发

| 状态 | 位置 | 谁置位 | 谁清理 | 失效策略 |
| --- | --- | --- | --- | --- |
| `measured.drawer` | webview 内存 | 收到带 `drawer` 的 `layout` 上报时整体替换 `measured` | 新上报覆盖；面板重载即失 | 抽屉态点按钮也会写覆盖（017 修订） |
| 手动覆盖 `dsh.ui.dshSidebarHidden` | `globalState` | **仅 grid 态**按钮/命令（既有路径） | 配置变更 `applySidebarPolicyChange`（既有） | 抽屉态不写 → 不产生跨态残留 |
| `sidebarToggleFailedNotified` | webview 宿主内存（`extension.js` 模块级） | 首次 `dsh-sidebar-toggle-failed` | 面板/窗口重建 | 每窗口一次，防刷屏 |

并发去重：无新增异步；转调是「点一次发一条」，DSH 侧 `toggleSidebar` 为同步状态翻转，重复上报由
`MIN_DELTA`（0.5px / collapsed 相同才跳过）与 `report(force)` 自然合并。

## 5. 安全审查

- [x] `layout-toggle` 由宿主主动发送，**不携带任何用户输入/路径/命令 id**，页面侧只能调用一个既定公开服务。
- [x] `layout-toggle-result` 进 `handleWebviewMessage` 前做 `reason` 白名单 + 类型校验（未知值整条丢弃）。
- [x] 中继仍走 `fromOurFrame(event)`（origin + source 双校验）；插件侧仍要求 `event.source === window.parent`
      且 `data.source === 'dsh-vscode-host'`，未握手（`!acked`）不响应该消息。
- [x] CSP 未放宽、无新增插值（新增字段都是布尔/枚举，经既有 `jsonForScript` 序列化路径之外的字面量拼接处
      只用白名单常量）；不涉子进程、路径、token。
- [x] 页面侧不写 DOM、不拦事件、不写 localStorage（与 `dsh-vscode-workspace` 同构），`show` 策略下不安装插件。

## 6. 测试策略（先红后绿）

| 层 | 套件 | 要加的断言（映射 AC） |
| --- | --- | --- |
| L2 协议（vm 真跑中继） | `test/dsh-sidebar.test.js` | AC-2（drawer 上报 → crop 0px，含展开态）、AC-3（点按钮/宿主命令 → `layout-toggle`、不发 `dsh-sidebar-state`、label 随 collapsed）、AC-4（result → `dsh-sidebar-toggle-failed`、补发 `request-layout`）、AC-5（缺 drawer 字段走老语义） |
| L2 协议（扩展宿主） | `test/dsh-sidebar.test.js` | AC-4（`handleWebviewMessage` → 状态栏一次、reason 白名单、重复不刷屏） |
| L3 仿真（真实插件源码） | `test/dsh-sidebar.test.js` | AC-1（轨道 0 + 矩形 280 → 报 0 且 `drawer:true`）、AC-3（ctx.layout 可用 → 恰调一次并回 `ok:true`；未握手/无抽屉/服务缺失 → 分别不调、回 `not-drawer`、回 `unsupported`）、AC-5（grid 不可解析 → 矩形回退） |
| L1/L2 收敛扫描（真实中继 + 真实插件） | `test/dsh-sidebar.test.js` | AC-6（240–1400 逐档：≤40 次收敛、无 2-周期、分段期望值、`crop ≤ 轨道+余量`）；**先红**：修复前该扫描在 488–711 报振荡 |
| 回归 | `npm test` 全量 | AC-7（004 既有断言不回退） |

- 必跑：`npm run test:one -- dsh-sidebar` → `npm test`。
- 实机（人工，回填 §10）：窄面板三段（<488 / 488–711 / ≥768）× 拖动 × 按钮/命令切换 × 重启 dsh web 前后。

## 7. 实施步骤

1. 基础设施：插件版本 `0.2.0`、消息类型常量（`layout-toggle` / `layout-toggle-result` / `dsh-sidebar-toggle-failed`）、`sidebarToggleFailedNotified` 标志落位。
2. 纯逻辑（先红）：中继 `displayedState`/`toggleSidebarNow` 分流断言、插件 `measure()` 轨道优先断言。
3. 页面侧：插件 `serviceOf` + 转调 + 回执、`drawer` 上报（先红后绿）。
4. 宿主接入：中继消息处理、`handleWebviewMessage` 提示分支（先红后绿）。
5. 收敛扫描：固定点迭代测试（先红 → 后绿），确认 488–711 修复前后差异。
6. 文档：`docs/TESTING.md` 测试地图、`docs/ARCHITECTURE.md` §3/§9、004 非目标修订与变更历史、015 验证记录。

## 8. 回退方案

| 层级 | 手段 | 触发条件 |
| --- | --- | --- |
| 代码 | `measure()` 内置回退链：grid 轨道解析失败 → 侧栏矩形（004 老口径），无需开关即自动降级 | 上游 grid 计算值形状变化 / 无 `getComputedStyle` |
| 契约 | 缺 `drawer` 字段即按 004 老语义；旧插件收到 `layout-toggle` 忽略 | 插件未随扩展升级 / dsh web 未重启 |
| 功能 | `dshPanel.dshSidebar=show`：不安装插件、不裁剪、不转调，与本能力不存在时一致 | 用户遇到任何兼容问题 |
| 发布 | 补丁版本回退（Marketplace 不可降级，只能发修复版） | 线上故障 |

## 9. 被否方案与原因

| 方案 | 否决原因 |
| --- | --- |
| 保持矩形口径，仅在抽屉态把上报值改 0（不区分网格） | 抽屉展开态需要知道「是抽屉」才能区分「轨道 0」与「测量失败」，且按钮语义仍无解；不如直接改口径 |
| B：抽屉态按钮只切裁剪 + 无效时提示 | 按钮在 <768 长期是摆设，违反「按钮始终有效」的目标（用户已否） |
| C：抽屉态完全不介入（隐藏工具条） | 宿主侧失去唯一入口，`policy=hide` 在 <768 形同虚设（用户已否） |
| 按钮继续按 004 裁剪隐藏抽屉 | 浮层压在对话区上，裁 280 必然切 280px 对话区——就是本次故障本身 |
| 复用 1.0.2 的「预测 + 立即 request-layout」修瞬闪 | 004 §12 已实测「闪烁更严重、缩窄不隐藏（旧值回写振荡）」并回退，不重复踩坑 |
| 抽屉态由宿主自动强制收起 `policy=hide` 的抽屉 | 主动改 DSH 内部状态超出本规格非目标，且抽屉只有用户手动打开才可见 |

## 10. 开放问题

- 若上游把抽屉态的 grid 第一轨道改成非 0（或类名 token 变化），AC-1/AC-6 的模型与断言会先红 → 按
  `ARCHITECTURE.md` §9-7 的流程回归并更新模型行号注释，再改实现。
- 若 `ctx.layout` 在某个旧 dsh 版本反射不到（`unsupported` 高发），则退回方案 B 的提示语义（按钮提示
  「请重启 dsh web」），不改裁剪口径。
- 非 1 倍字号的单位换算维持 004 §12 暂缓；后续若做「插件上报 `innerWidth` + 宿主量 iframe 实宽」的
  自校准（004 §10 计划项），需另起规格，不得混入本次。
