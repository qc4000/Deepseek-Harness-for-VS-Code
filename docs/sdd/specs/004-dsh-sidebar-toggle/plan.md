# 技术方案 004：面板内隐藏/显示 DSH 左侧栏

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：approved） |
| 负责人 | @Vithrive |
| 更新 | 2026-10-24 |

## 1. 方案概述

**父容器视口裁剪**：iframe 不动内容、不动事件，只在外层 stage 里把「侧栏那一段像素」移到可视区外，
同时把 iframe 加宽同样的像素，使对话区正好铺满面板。侧栏宽度由新增的**只读测量插件**（在 DSH 页面内）
实时上报，因此拖动/折叠/改窗口后都能精确对齐。切换按钮在 iframe 上方的 28px 工具条里，只改 CSS 变量，
不重载 iframe。

```
toolbar(28px) ── button(切换) ──┐
stage(overflow:hidden)          │  --dsh-crop: 0 | S(+4)
  └ clip(left:-crop; width:100%+crop)   ← 未缩放，裁剪量 1:1 像素
      └ iframe(width:100%; height:100%; zoom:z)   ← 缩放仍在 iframe 上，与 crop 解耦
插件 dsh-vscode-layout ──{sidebarWidth, collapsed, animating}──▶ 中继脚本 ──▶ --dsh-crop
```

## 2. 关键设计决策

1. **多包一层 `clip`**：现有 `zoom` 作用在 iframe 上，若把负偏移和加宽也写在 iframe 上，
   裁剪量会与缩放倍率耦合（CSS `zoom` 与百分比宽度叠加语义需要实测定标）。把裁剪放在**未缩放**的
   `clip` 上、iframe 保持 `width:100%`，crop 恒等于视觉像素，彻底消除该耦合（AC-8）。
2. **裁剪量 = 侧栏 track 宽（+4px 手柄余量）**：DSH 的 `_handle` 是 8px 宽、居中在 track 边界
   （`margin-left:-4px`），只裁 `S` 会让 4px 热区留在可见区左缘（AC-7）。折叠态没有手柄，故不加。
3. **策略在页面内计算，宿主只存偏好**：`auto` 依赖 webview 实际宽度，只有 webview 自己知道；
   宿主负责配置、持久化与命令。逻辑只有一行表达式，由 `vm` 测试直接驱动真实脚本（不做双份实现）。
4. **读不到就不裁**：测量未就绪时不猜宽度（固定常量在拖动场景必然错），保持原样并提示（AC-6）。

## 3. 依据（dsh 0.2.1-rc.2 实测源码）

| 事实 | 位置 |
| --- | --- |
| 三栏 grid，左栏宽度内联在 frame 的 `grid-template-columns`；左栏元素 `div._sidebarCol` | `@deepseek-ai/dsh-client-ui-layout/lib/client.js` L320–337 |
| 展开宽 264–420（拖动 clamp）、折叠 56（Web）、0（桌面壳） | 同上 L25–44、L238–242 |
| 窄于 1024 自动折叠为导轨；`data-sidebar-collapsed` 标记在 frame 上 | 同上 L10–13、L237–239、L323 |
| 折叠/展开 300ms 过渡，期间 `data-animating`；拖动 `data-dragging`（无过渡） | 同上 L73、L285–291 |
| 折叠后仍渲染 56px 导轨（内容不卸载） | `@deepseek-ai/dsh-client-ui-sidebar/lib/client.js` L143–160 |
| 侧栏宽度不持久化，刷新回 280 | layout L390–400 |
| `data-platform`/`data-windows-titlebar` 仅桌面壳设置 → webview 内折叠恒为 56 | 前端 bundle 无写入处 |

## 4. 影响面

| 文件 | 改动 | 触碰安全数据流 | 对应 AC |
| --- | --- | --- | --- |
| `extension.js` | 新增布局插件常量/安装、`buildIframeHtml` 增加 stage/clip/toolbar/中继、消息处理、命令、配置分支、状态读写 | webview（postMessage） | 全部 |
| `package.json` | 配置项 `dshPanel.dshSidebar`、命令 `dshPanel.toggleDshSidebar` | 否 | AC-1/2/5 |
| `dsh-plugins/dsh-vscode-layout/`（新增） | 只读测量插件：`package.json` / `cordis.patch.yml` / `lib/index.js` / `lib/client.js` | 读取 DOM 几何（只读） | AC-3 |
| `test/dsh-sidebar.test.js`（新增） | 中继脚本 vm 测试 + 插件仿真 + 安装幂等 | — | 全部 |
| `scripts/run-tests.js` | 语法检查已自动覆盖新插件目录 | — | — |
| `docs/`、`README.md`、`CHANGELOG.md` | 配置表、行为说明、架构/已知限制、测试地图、宪法第一条边界说明 | — | — |

## 5. 契约

| 契约 | 内容 | 校验/回退 |
| --- | --- | --- |
| 配置项 | `dshPanel.dshSidebar`: `auto`（默认）/ `show` / `hide` | 非法值按 `auto` |
| 命令 | `DeepSeek Harness: 切换 DSH 侧栏显示`（`dshPanel.toggleDshSidebar`） | 无活动面板时提示先打开 |
| globalState | `dsh.ui.dshSidebarHidden`: `null|true|false`（手动覆盖）；`dsh.ui.dshSidebarWidth`: `number`（上次测量） | 类型不符即忽略 |
| webview → 宿主 | `{type:'dsh-sidebar-state', hidden, reason:'user'|'auto'}` | `hidden` 必须为 boolean |
| 宿主 → webview | `{type:'dsh-sidebar-toggle'}` / `{type:'dsh-sidebar-config', policy}` | 未知类型忽略 |
| 插件 → webview | `{source:'dsh-vscode-layout', type:'layout', sidebarWidth, collapsed, animating}` | 宽度需有限数且 0–1024，否则丢弃 |
| webview → 插件 | `{source:'dsh-vscode-host', type:'ack', layout:true}` / `{type:'request-layout'}` | 未 ack 时插件保持静默 |
| 插件安装 | 版本以 `dsh-plugins/dsh-vscode-layout/package.json` 为单一源头；`policy==='show'` 时不安装/不更新 | 安装失败只告警，不影响面板 |

## 6. 状态与并发

| 状态 | 位置 | 谁置位 | 谁清理 | 失效策略 |
| --- | --- | --- | --- | --- |
| `hidden`（有效值） | webview 内存 | 初始（策略+宽度）、按钮、宿主消息 | 面板销毁 | 每次渲染重算 |
| 手动覆盖 | `globalState` | 用户点击按钮 | 配置变更时清除 | `null` 表示无覆盖 |
| 测量值 | webview 内存 + `globalState` 缓存 | 插件上报 | 面板销毁 | 超范围丢弃；无值时用缓存值仅作"显示中的初始值"，不用于隐藏 |
| 插件安装去重 | 既有 `ensureProfileDeclaration` 幂等 | — | — | 版本一致不写盘 |

## 7. 安全审查

- [x] 不新增子进程调用；插件安装沿用既有 profile 落盘路径（常量包名）
- [x] webview CSP 不变（仍为 `default-src 'none'` + 精确 `frame-src` + nonce 脚本）；
      工具条按钮为内联 SVG + 内联样式（`style-src 'unsafe-inline'` 已允许）
- [x] 消息字段校验：`sidebarWidth` 有限数且 0–1024；`hidden` 严格 boolean
- [x] 不写文件系统新位置；`globalState` 只存布尔/数值偏好，无凭据
- [x] 页面内插件只读几何（`getBoundingClientRect` / `grid-template-columns`），不改 DOM、不拦事件

## 8. 测试策略（先红后绿）

| 层 | 套件 | 断言点（映射 AC） |
| --- | --- | --- |
| L2 协议（vm 真跑中继脚本） | `test/dsh-sidebar.test.js` | 初始策略 auto/show/hide × 宽度 800/1200 → `--dsh-crop` 值（AC-1）；按钮点击 → 翻转 + 上报 `dsh-sidebar-state`（AC-2）；`layout` 消息 → 56/280/420/0 与 `+4` 手柄（AC-3/7）；超范围/非数值丢弃；未测量时不裁并上报 unavailable（AC-6）；宿主 `toggle`/`config` 消息（AC-2/4） |
| L3 插件仿真 | 同套件（vm 载入真实 `client.js`） | 未 ack 不上报；ack 后上报测量；宽度变化重报；`data-animating` 时延迟到 300ms 后报稳定值；元素缺失时重试并最终不上报（AC-3/6） |
| 安装/分发 | 同套件 | 四个文件齐全、`lib/*.js` 语法真实通过、`cordis.patch.yml` 名称一致、不写 `dependencies`、版本幂等（AC-5） |
| 实机 | 手验 | 侧边栏/面板/标签页 × 折叠/展开 × 拖动 264/420 × fontSize 12/16/20（AC-8） |

不做 e2e：本能力不涉及 dsh 认证/RPC 契约，且真实浏览器度量需要额外依赖。

## 9. 实施步骤

1. 基础设施：常量、`__internals` 导出、`package.json` 配置/命令。
2. L1/L2：`buildIframeHtml` 的 stage/clip/toolbar 与中继脚本（测试先行）。
3. 页面侧：`dsh-vscode-layout` 插件（测试先行）。
4. 宿主：安装、消息、命令、配置分支、策略传入。
5. 文档与版本：README/CHANGELOG/ARCHITECTURE/TESTING/宪法补注、`1.0.1`。

## 10. 回退方案

| 层级 | 手段 | 触发条件 |
| --- | --- | --- |
| 功能 | `dshPanel.dshSidebar=show`（并清除手动覆盖） | 用户不需要/遇到兼容问题 |
| 代码 | 插件未握手 → 不裁剪；裁剪只改 CSS 变量 | DSH 内部结构变更 |
| 发布 | 补丁版本修复（Marketplace 不可降级） | 线上错位 |

## 11. 被否方案与原因

| 方案 | 否决原因 |
| --- | --- |
| 固定裁剪常量（280/56） | 用户拖动侧栏后必然错位：会露出侧栏残条或切掉对话内容（AC-3 无法满足） |
| 插件注入 CSS 隐藏侧栏 | 改 DSH DOM，违反宪法第一条；类名/布局变更即失效 |
| 调用 `ctx.layout.toggleSidebar()` | DSH 只能折叠到 56px 导轨，仍需裁剪；且会改 DSH 内部状态、丢失拖动宽度 |
| 认证代理改写 HTML 注入样式 | 绕过插件握手、难排障，等于偷偷改页面 |
| 新增底部面板容器 | 需把"标签页 vs 侧边栏"二态重构为多 surface，超出本次范围 |

## 12. 开放问题

- 实机确认 968–1024 区间跨断点时的跳变是否可感知；若明显，按"上次测量值 + 断点预测"先给目标值。
- 若 DSH 后续提供"隐藏左栏"的官方 API（宽度 0），可退化为纯状态切换，删除裁剪逻辑。
