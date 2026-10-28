# AGENTS.md — dsh-vscode-file-links

本目录是**随扩展内置分发**的 DeepSeek Harness 插件：它运行在 DSH Web 页面（浏览器/iframe）里，
不是 VS Code 扩展宿主进程。上级规则见仓库根 [AGENTS.md](../../AGENTS.md)。

## 职责

DSH 把对话里的工作区路径渲染成 `<button class="_fileLink_xxx">`，点击默认在 DSH 右侧边栏打开。
当 DSH 页面被本扩展以跨源 iframe 内嵌时，本插件把这次点击改为「在 VS Code 资源管理器中定位/打开」：

```
点击 → 本插件(postMessage) → webview 中继脚本 → 扩展宿主(revealInExplorer / vscode.open)
     ← reveal-result ← 中继脚本 ← 宿主
```

## 文件

| 文件 | 说明 |
| --- | --- |
| `package.json` | **版本单一源头**（`extension.js` 的 `fileLinkPluginVersion()` 读取它）；`dsh.client` / `dsh.bundle` 声明 |
| `cordis.patch.yml` | DSH bundle patch：`insert` 一行，`name` 必须等于包名与宿主半区导出的 `name` |
| `lib/index.js` | 宿主半区（ESM，`type: module`）：空实现，只导出 `name` / `inject` / `apply` |
| `lib/client.js` | 客户端半区：`window.__ModuleLoader__.load({...})` 包裹，导出 `apply` / `inject` |

## 硬约束

1. **三条底线不可破**：① 只在宿主导握手 `ack` 后接管；② 宿主回执成功才吞点击，否则
   `replayClick()` 回放（绝不「点了没反应」）；③ 带 `Ctrl/Cmd/Shift/Alt` 的点击一律不接管。
2. **只碰文件链接按钮**：`closest('button')` + class 含 `fileLink`；不改写 DOM、不接管其它点击、
   不影响 React 委托 handler 之外的监听器。
3. **浏览器兼容**：`lib/client.js` 保持 ES5 风格（`var`、`function`、无箭头函数/可选链），
   因为它在 DSH 页面上下文执行，运行环境由 DSH 前端决定。
4. **无依赖**：不 import 任何包，只用 `window` / `document` / `navigator`。
5. **协议字段固定**：`source` 用 `dsh-vscode-file-links` / `dsh-vscode-host`；`type` 用
   `hello` / `ack` / `reveal` / `reveal-ack` / `reveal-result`；`mode` 用 `revealAndOpen` /
   `diffAndOpen` / `revealOnly`；`change`（仅 diff 模式）用 `{ sessionId, turn }`。
   改协议必须同时改 `extension.js`（`buildIframeHtml` 中继脚本 + `handleWebviewMessage`）与宿主测试。
   ⚠️ **`ack` 有两种**：文件链接的（带 `fileLinks`/`mode`/`diff`）与侧栏布局测量的
   （只有 `layout: true`）。宿主在 iframe 加载时先发前者、紧接着发后者；客户端**必须**
   按字段区分（只带 `layout` 的那条直接 return），否则布局 ack 会把 `diffMode` 覆盖成
   `false`，之后所有点击都不带轮坐标——2026-10-28 真机事故，轮级 diff 端到端从未生效。
6. **超时即回退**：`REVEAL_TIMEOUT_MS`（2500ms）内没有回执就回放原始点击；
   收到 `reveal-ack`（宿主已接单）后放宽到 `DIFF_WAIT_MS`（6000ms，与扩展 `DIFF_TIMEOUT_MS` 一致）。

## 修改流程

- 改客户端逻辑：先写/改测试（`test/file-link-client-sim.test.js` 用仿真的
  `document`/`window`/`ModuleLoader` 环境跑真实插件源码），再改 `lib/client.js`。
- 改版本：只改本目录 `package.json` 的 `version` —— 扩展会自动比对 `installedPluginVersion()`
  并覆盖安装，随后提示用户「重启 dsh web」生效。版本不一致是升级不生效的最常见原因。
- 校验：

```bash
node --check dsh-plugins/dsh-vscode-file-links/lib/index.js
node --check dsh-plugins/dsh-vscode-file-links/lib/client.js
npm run test:one -- file-link
```

## 分发注意

- 插件以**真实文件**随 `.vsix` 分发（`fileLinkPluginFiles()` 读盘再写入 DSH profile），
  因此 `dsh-plugins/` 不能加入 `.vscodeignore`。
- 不要写入 `dependencies`：npm 上没有该包，写进去会让用户后续 `dsh plugin add` / pnpm 解析失败；
  只登记 `dsh.profile.bundles`。
- `dshPanel.workspaceFileLinkAction = "off"` 时不安装、不更新本插件，页面里也不发 `ack`。
