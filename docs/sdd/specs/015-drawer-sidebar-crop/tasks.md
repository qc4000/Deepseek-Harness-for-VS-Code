# 任务清单 015：窄容器抽屉态下侧栏裁剪不切对话区、不振荡

> 用法：任务按「先红后绿」排序；每完成一项把 `[ ]` 改成 `[x]` 并在 PR 里贴 `npm test` 结果。
> 粒度：单项 ≤ 半个工作日。`[P]` 表示与相邻任务无依赖、可并行。

## 阶段 0 · 准备（基础设施）

- [x] `[impl]` `dsh-plugins/dsh-vscode-layout/package.json` 版本 `0.1.1 → 0.2.0`，`lib/client.js` 的
      `PLUGIN_VERSION` 同步 —— 判据：`ensureLayoutPlugin` 检测到版本差 → 覆盖安装 + 触发既有「重启 dsh web」提示
- [x] `[impl]` 消息类型落位（中继与插件两侧常量/字面量对齐）：宿主→页面 `layout-toggle`、
      页面→宿主 `layout-toggle-result`（`reason` 白名单 `unsupported|not-drawer|failed`）、
      webview→扩展 `dsh-sidebar-toggle-failed` —— 判据：三方名称拼写一致，测试可直接引用
- [x] `[impl]` `extension.js` 模块级 `sidebarToggleFailedNotified` 标志落位（与 `sidebarUnavailableNotified` 同款）
      —— 判据：`handleWebviewMessage` 分支可测「每窗口一次」

## 阶段 1 · 中继与插件（先红）

- [x] `[test]` AC-2：抽屉态上报 `sidebarWidth:0, drawer:true` → `--dsh-crop` 为 `0px`（展开态同样 0）
      —— 判据：当前失败（旧代码只看宽度，0 也会给 0？→ 断言必须同时钉住「矩形 280 + 抽屉」场景由 AC-1 驱动）
- [x] `[test]` AC-1：插件仿真里 frame 带 `data-sidebar-drawer`、grid 首段 `0px`、矩形 280 →
      上报 `{sidebarWidth:0, drawer:true}` —— 判据：当前失败（旧实现报 280 且无 `drawer` 字段）
- [x] `[test]` AC-3（页面侧）：抽屉态点按钮 / 收到 `dsh-sidebar-toggle` → 发出 `layout-toggle`、
      不发 `dsh-sidebar-state`、`--dsh-crop` 不变、`aria-label` 随上报 `collapsed` 翻转
      —— 判据：当前失败（旧代码直接 `setHidden`）
- [x] `[test]` AC-4：`layout-toggle-result` → webview 发 `dsh-sidebar-toggle-failed`（reason 白名单）+
      补发 `request-layout`；`I.handleWebviewMessage` → 状态栏一次、重复不刷屏、非法 reason 丢弃
      —— 判据：当前失败（分支不存在）
- [x] `[test]` AC-5：上报缺 `drawer` 字段 → 按钮仍按 `hidden` 切换、裁剪仍按宽度（004 老语义）；
      插件 grid 计算值不可解析 → 回退矩形上报 —— 判据：前者当前绿（保持），后者当前红
- [x] `[impl]` 中继：`displayedState()` / `toggleSidebarNow()` 分流 + `updateToggle` 改按显示态 +
      `layout-toggle-result` 处理 + `dsh-sidebar-toggle-failed` 上报 —— 判据：阶段 1 前四组断言变绿
- [x] `[impl]` 插件：`measure()` 轨道优先、矩形回退；上报 `drawer`；`serviceOf` + `layout-toggle` 转调与
      回执（未握手不响应回执、无抽屉回 `not-drawer`、服务缺失回 `unsupported`、调用抛错回 `failed`）
      —— 判据：AC-1/AC-3/AC-4/AC-5 页面侧断言变绿，`node --check` 通过（ES5 风格不破）
- [x] `[impl]` 扩展：`handleWebviewMessage` 的 `dsh-sidebar-toggle-failed` 分支与白名单校验
      —— 判据：AC-4 宿主侧断言变绿

## 阶段 2 · 收敛证明（先红后绿的关键证据）

- [x] `[test]` AC-6：固定点扫描（240–1400 逐档，真实中继 + 真实插件源码，dsh 0.2.2 布局模型回喂几何）
      —— 判据：**当前红**（488–711 检出 2-周期振荡），红输出记录到 PR 与 plan §9
- [x] `[impl]` 使 AC-6 变绿（阶段 1 的口径修正即为其解） —— 判据：全档 ≤40 次收敛、分段期望值
      `0 / 56 / 284`、`crop ≤ 轨道 + 折叠?0:4`；并复跑确认 `<488` 不再裁 280

## 阶段 3 · 回归与文档

- [x] `[test]` `npm run test:one -- dsh-sidebar` 全绿（含 004 既有 61 项）→ `npm test` 全量绿
      —— 判据：输出「全部通过：N 项断言 ✓」
- [x] `[docs]` `docs/TESTING.md` 测试地图 `dsh-sidebar.test.js` 行更新（断言数 + 覆盖：抽屉态不裁剪 /
      转调 / 收敛扫描） —— 判据：地图行与实际输出一致
- [x] `[docs]` `docs/ARCHITECTURE.md` §3 裁剪公式补抽屉态分支、§9-7 已知限制补 dsh 0.2.2 抽屉契约 —— 判据：读者能从文档推出 `crop=0` 的条件
- [x] `[docs]` `docs/sdd/specs/004-dsh-sidebar-toggle/spec.md` 非目标修订（抽屉态允许经宿主按钮转调
      `ctx.layout.toggleSidebar()`）+ 变更历史一行指向 015 —— 判据：004 不再与 015 打架
- [x] `[docs]` 015 `spec.md` 状态 → `implemented`，§10 验证记录回填（套件 + 断言数 + 实机结论）
      —— 判据：每条 AC 都能指到断言

## 阶段 4 · 发布（**需维护者确认，不自动执行**）

- [ ] `[docs]` `CHANGELOG.md` 顶部新版本小节（抽屉态左切/闪烁修复 + 需重启 dsh web）
- [ ] `[impl]` `package.json` 版本号提升（与 CHANGELOG 一致）
- [ ] `[impl]` 打 tag `v<版本>` 并确认 Release 工作流绿

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 | 阶段 1 `[test]` 插件轨道上报 → `[impl]` 插件 measure | `dsh-sidebar.test.js`（插件仿真） |
| AC-2 | 阶段 1 `[test]` 中继 crop → `[impl]` 中继 | `dsh-sidebar.test.js`（vm 中继） |
| AC-3 | 阶段 1 `[test]` 转调分流 → `[impl]` 中继 + 插件 | `dsh-sidebar.test.js`（vm 中继 + 插件仿真） |
| AC-4 | 阶段 1 `[test]` 回执与提示 → `[impl]` 中继 + `handleWebviewMessage` | `dsh-sidebar.test.js` |
| AC-5 | 阶段 1 `[test]` 回退双路径 → `[impl]` 插件 measure 回退 | `dsh-sidebar.test.js` |
| AC-6 | 阶段 2 扫描（先红后绿） | `dsh-sidebar.test.js`（收敛扫描） |
| AC-7 | 阶段 3 回归 | `npm test` 全量 |

## 例外与决策记录

- 用户 2026-11-09 拍板方案 A（抽屉态转调 DSH 原生收放），范围不含 004 §12 其余已知问题 → 004 非目标由 015 修订。
- 阶段 4 版本/CHANGELOG/tag 属发版动作，按仓库规则**先征得维护者确认**再执行。
- 收敛扫描的 dsh 布局模型（`<768` 抽屉、`<1024` 导轨、`narrowExpanded=false`）是对上游 0.2.2-rc.1 的
  契约建模，行号写在测试注释里；上游变更时模型先红（见 plan §10）。
