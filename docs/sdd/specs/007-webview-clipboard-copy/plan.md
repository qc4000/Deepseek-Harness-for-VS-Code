# 方案 007：面板内 DSH「复制」按钮写入剪贴板失败

## 1. 根因链路

```
DSH 页面（跨源 iframe，http://127.0.0.1:3080）
  └─ 复制按钮 → zo(text)
       ├─ navigator.clipboard.writeText(text)  → 被 VS Code 权限策略拒绝
       └─ catch → return false                 → 按钮显示失败，不再回退
```

`allow="clipboard-read; clipboard-write"` 已经写在 iframe 上，但 VS Code 的
`setPermissionRequestHandler` / `setPermissionCheckHandler` 只对 webview 自身
origin 授权，内层跨源文档拿不到（microsoft/vscode#182642，仍 open）。因此扩展侧
唯一可靠通路是宿主 `vscode.env.clipboard.writeText`。

## 2. 影响面

| 文件 | 改动 |
| --- | --- |
| `extension.js` `clipboardPluginFiles()` | 生成 client.js 增加 `writeText` 包装与三级回退；版本 0.2.1 → 0.3.0 |
| `extension.js` `buildIframeHtml()` | 中继脚本新增 `clipboard-write` 转发、超长拒绝、结果回传 |
| `extension.js` `handleWebviewMessage()` | 新增 `dsh-clipboard-write`：调 `vscode.env.clipboard.writeText` + 回执 + 失败提示 |
| `extension.js` 常量 | `CLIPBOARD_PLUGIN_SOURCE`、`CLIPBOARD_MAX_TEXT`、`CLIPBOARD_TIMEOUT_MS` |
| `test/clipboard-plugin.test.js` | 生成文件断言 + 客户端 vm 仿真（原生/宿主/超时兜底/iframe 门控） |
| `test/clipboard-bridge.test.js` | 新建：中继脚本与宿主消息协议 |
| `scripts/run-tests.js` / `package.json` | 新套件登记（若脚本是白名单） |

## 3. 方案

### 3.1 插件侧（client.js）

`apply()` 中在 `inIframe()` 成立时安装一次 shim（`window.__dshClipboardShim` 幂等）：

```js
writeText(text)
  → 原生 writeText（存在时）
  → 宿主通道：postMessage({ source:'dsh-webview-clipboard', type:'clipboard-write', token, text })
       ↳ 1.5s 内收到 { source:'dsh-vscode-host', type:'clipboard-result', token, ok }
  → execCommand('copy')（textarea + select，旧宿主兜底）
  → 失败：reject（DSH 的 zo 捕获后显示失败）
```

- 只在 iframe 内生效，系统浏览器直接打开 DSH 不接管（AC-3）。
- 保留现有 macOS ⌘C/⌘V/⌘X 逻辑，不改动其门控。
- `apply()` 可能被 HMR 重复调用：用 window 标记只装一次。

### 3.2 中继（buildIframeHtml 内联脚本）

新增独立 source `dsh-webview-clipboard`（不复用文件链接的 `ack`/`reveal` 类型）：

```js
if (data.source === CLIPBOARD_ID) {
  if (!fromOurFrame(event)) return;                 // origin + source 双校验
  if (data.type === 'clipboard-write') {
    if (typeof data.token !== 'string' || typeof data.text !== 'string') return;
    if (data.text.length > CLIPBOARD_MAX_TEXT) { postToFrame(result ok:false); return; }
    vscode.postMessage({ type:'dsh-clipboard-write', token: data.token.slice(0,64), text: data.text });
  }
  return;
}
```

宿主回执 `dsh-clipboard-result` → `postToFrame({ source: HOST_ID, type:'clipboard-result', token, ok })`。

### 3.3 宿主（handleWebviewMessage）

```js
else if (msg.type === 'dsh-clipboard-write') {
  const token = typeof msg.token === 'string' ? msg.token.slice(0, 64) : '';
  const text = typeof msg.text === 'string' ? msg.text : '';
  const reply = (ok) => webview.postMessage({ type:'dsh-clipboard-result', token, ok });
  if (text.length > CLIPBOARD_MAX_TEXT) { reply(false); warnOnce(...); }
  else vscode.env.clipboard.writeText(text).then(() => reply(true), (e) => { reply(false); warnOnce(e); });
}
```

失败提示：`setStatusBarMessage` 8 s，模块级 `clipboardFailureNotified` 保证一个窗口
只提示一次（与侧栏不可用提示同模式）。

## 4. 契约回退

| 契约 | 回退 |
| --- | --- |
| 旧版扩展不认识 `dsh-clipboard-write` | 插件 1.5 s 超时 → `execCommand` 兜底 |
| 原生 clipboard 可用 | 优先原生，完全不发消息（AC-2） |
| 非面板（浏览器直开） | 不安装 shim（AC-3） |
| 插件未加载（旧 dsh） | 复制按钮维持现状，无新增副作用 |
| 配置关闭 | 不写插件文件（AC-4） |

## 5. 安全

- 中继 `fromOurFrame()`：`event.origin` 必须等于 DSH origin，`event.source` 必须是
  本面板 iframe。
- `token` 只做字符串键（插件侧用 `Object.create(null)`，防原型污染）。
- `text` 类型与长度校验；超限不截断（避免复制半截），直接 `ok:false`。
- 文本只在内存中路过宿主，不写日志、不落盘。

## 6. 测试策略

| 层 | 套件 | 覆盖 |
| --- | --- | --- |
| L1 生成物 | `clipboard-plugin.test.js` | 版本、语法、`writeText` 包装、iframe 门控、三级回退顺序 |
| L2 中继 | `clipboard-bridge.test.js` | 转发、双校验、超长拒绝、回执回传 |
| L2 宿主 | `clipboard-bridge.test.js` | `vscode.env.clipboard.writeText` 调用、ok:true/false、失败提示一次 |
| L3 仿真 | `clipboard-plugin.test.js` | vm 跑 client.js：原生成功不发消息、原生失败走宿主、超时走 execCommand |

## 7. 风险

| 风险 | 应对 |
| --- | --- |
| 包装被其它脚本覆盖 | 每次调用仍先走原生；最坏退化为当前行为 |
| 宿主通道被恶意页面利用写剪贴板 | 只接受本面板 iframe + DSH origin 的消息 |
| 1 MiB 上限误伤 | 失败可见 + 手动复制出路 |
