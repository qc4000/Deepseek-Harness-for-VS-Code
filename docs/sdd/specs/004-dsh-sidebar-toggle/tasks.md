# 任务清单 004：面板内隐藏/显示 DSH 左侧栏

> 顺序：`[test]` 先于对应 `[impl]`；每完成一项勾选并把 `npm test` 结果贴到 PR。

## 阶段 0 · 准备

- [ ] `[impl]` `package.json` 新增配置 `dshPanel.dshSidebar`（`auto|show|hide`，默认 `auto`）与命令 `dshPanel.toggleDshSidebar`（标题「DeepSeek Harness: 切换 DSH 侧栏显示」）—— 判据：JSON 合法、`vsce` 打包通过
- [ ] `[impl]` `extension.js` 新增常量（插件名/断点 1024/手柄余量 4/回退宽度）与 `SIDEBAR_*` 状态键 —— 判据：命名与既有 `FILE_LINK_*` 风格一致

## 阶段 1 · 中继脚本（L2，vm 真跑）

- [ ] `[test]` 新建 `test/dsh-sidebar.test.js`：`buildIframeHtml` 产出含工具条按钮（`aria-label`/`title`/非 `off` 时可见）与 `#dsh-stage`/`#dsh-clip` —— 判据：红
- [ ] `[impl]` `buildIframeHtml(url, scale, fileLinkMode, sidebar)` 增加 stage/clip/toolbar 结构 —— 判据：绿，且 `file-link-bridge` 既有断言不回归
- [ ] `[test]` 初始策略：`auto` + 宽 800 → 隐藏；`auto` + 宽 1200 → 显示；`show`/`hide` 直通；手动覆盖优先 —— 判据：红
- [ ] `[impl]` 中继脚本内计算有效 `hidden` 并写入 `--dsh-crop` —— 判据：绿
- [ ] `[test]` `layout` 消息：280 → 284、420 → 424、56（collapsed）→ 56、0 → 0、超范围/非数值丢弃、未测量时不裁并上报 `dsh-sidebar-unavailable` —— 判据：红
- [ ] `[impl]` 测量消费 + 裁剪函数（纯表达式，含 `+4` 手柄余量与 `collapsed` 判定） —— 判据：绿
- [ ] `[test]` 按钮点击 → 翻转 `--dsh-crop` 并 postMessage `dsh-sidebar-state`（`reason:'user'`）；宿主 `toggle`/`config` 消息生效；显示态忽略测量 —— 判据：红
- [ ] `[impl]` 按钮事件、`setState` 持久化、宿主消息处理 —— 判据：绿
- [ ] `[test]` 缩放解耦：`clip` 未缩放、iframe 保持 `width:100%`，`--dsh-crop` 只写在 clip 的 `left/width` 上 —— 判据：绿（文本断言）

## 阶段 2 · 测量插件（L3，仿真）

- [ ] `[test]` 插件四文件齐全、`lib/*.js` 语法真实通过、`cordis.patch.yml` 名称一致、`package.json` 无 `dependencies` —— 判据：红
- [ ] `[impl]` 新增 `dsh-plugins/dsh-vscode-layout/`（ESM 宿主半区 + ES5 客户端半区） —— 判据：绿
- [ ] `[test]` 仿真：未 ack 不上报；ack 后上报 `{sidebarWidth, collapsed, animating}`；宽度变化重报；`data-animating` 期间延后 300ms 报稳定值；元素缺失时不报错 —— 判据：红
- [ ] `[impl]` 发现元素（`[class*="_sidebarCol"]` → grid track 回退）、`ResizeObserver` + `MutationObserver`、节流与 settle 定时器、`dispose` 清理 —— 判据：绿

## 阶段 3 · 宿主接入

- [ ] `[test]` 安装幂等：`ensureLayoutPlugin` 首次写盘返回 true、版本一致返回 false、不写 `dependencies`、`policy='show'` 时不安装 —— 判据：红
- [ ] `[impl]` `ensureLayoutPlugin` + `ensureDshPlugins` 接入（安装/升级后提示重启 dsh web） —— 判据：绿
- [ ] `[impl]` `buildIframeHtml` 调用点传入 `{policy, hidden, sidebarWidth}`（侧边栏 view 与标签页共用） —— 判据：两处渲染均带工具条
- [ ] `[impl]` `handleWebviewMessage`：`dsh-sidebar-state` 持久化手动覆盖；`dsh-sidebar-unavailable` 状态栏提示一次 —— 判据：无重复提示
- [ ] `[impl]` 命令 `dshPanel.toggleDshSidebar`（无面板时提示）；配置变更只发消息不重载 —— 判据：改配置时 DSH 会话状态不丢

## 阶段 4 · 文档与发布

- [ ] `[docs]` `docs/CONSTITUTION.md` 第一条补「父容器视口裁剪」边界说明
- [ ] `[docs]` `docs/ARCHITECTURE.md`：新增链路与"依赖 DSH 内部布局（56/264–420/1024/`_sidebarCol`）"已知限制
- [ ] `[docs]` `docs/TESTING.md` 测试地图补 `dsh-sidebar.test.js`
- [ ] `[docs]` `README.md` 配置表 + 行为说明；`CHANGELOG.md` 1.0.1 小节
- [ ] `[impl]` `package.json` 版本 `1.0.1`（与 CHANGELOG 一致）
- [ ] `[docs]` `spec.md` 状态改 `implemented` 并补验证记录（套件 + 断言数 + 实机结论）

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 | 阶段 1 初始策略 | `dsh-sidebar.test.js` |
| AC-2 | 阶段 1 按钮/消息 + 阶段 3 命令 | `dsh-sidebar.test.js` |
| AC-3 | 阶段 1 测量消费 + 阶段 2 插件 | `dsh-sidebar.test.js` |
| AC-4 | 阶段 1 持久化 + 阶段 3 配置分支 | `dsh-sidebar.test.js` |
| AC-5 | 阶段 3 安装策略 | `dsh-sidebar.test.js` |
| AC-6 | 阶段 1 unavailable + 阶段 3 提示 | `dsh-sidebar.test.js` |
| AC-7 | 阶段 1 `+4` 手柄余量 | `dsh-sidebar.test.js` |
| AC-8 | 阶段 1 缩放解耦 | `dsh-sidebar.test.js` + 实机 |
