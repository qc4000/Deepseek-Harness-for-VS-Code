# 规格 007：面板内 DSH「复制」按钮写入剪贴板失败

| 项 | 内容 |
| --- | --- |
| 编号 | 007 |
| 状态 | implemented |
| 负责人 | @Vithrive |
| 关联 | 分支 `dev-1.0` · 目标版本 `1.0.6` · 相关：VS Code issue #182642 |
| 创建 / 更新 | 2026-10-29 / 2026-10-29 |

## 1. 背景与问题

面板（侧边栏 / 编辑器标签页）把 DSH Web GUI 内嵌在跨源 iframe 中。DSH 前端的
「复制」按钮（代码块右上角、消息操作条、JSON 复制）统一走：

```js
async function zo(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true }
    catch { return false }            // ← 直接放弃，不回退 execCommand
  }
  /* 只有 clipboard API 完全不存在时才用 textarea + execCommand */
}
```

VS Code 的 webview 通过 `setPermissionRequestHandler` / `setPermissionCheckHandler`
统一管理权限，webview 内**再嵌一层跨源 iframe** 时 `navigator.clipboard.writeText()`
被拒（`Write permission denied` / `NotAllowedError`）。这是 VS Code 的已知未修复
问题（microsoft/vscode#182642）：即使 iframe 写了
`allow="clipboard-read; clipboard-write"`（本扩展已写），内层跨源文档仍拿不到写权限。

于是 DSH 的 `zo` 走进 `catch` 返回 `false`，按钮停在「失败」状态且**不会**落到
`execCommand` 回退，用户看到的现象就是「点了复制没反应 / 复制失败」。该问题与
平台无关；现有内置插件 `dsh-webview-clipboard` 只在 macOS 激活，且只修 ⌘C/⌘V/⌘X
快捷键，覆盖不到按钮。

## 2. 目标

- 面板内 DSH 的复制按钮（代码块 / 消息 / JSON 等所有调用
  `navigator.clipboard.writeText` 的位置）能把文本真正写入系统剪贴板。
- 不改变普通浏览器直接打开 DSH 的行为：插件只在「被宿主 iframe 内嵌」时接管。
- 原生 API 可用时优先原生，失败再回退；任何回退都不破坏 DSH 页面其余交互。
- 写入失败必须用户可见（状态栏一次性提示 + 出路），不静默。

## 3. 非目标

- 不修复 VS Code 自身的权限策略（上游 issue 仍 open），只在扩展侧绕过。
- 不改 DSH 源码、不注入 DOM 样式/脚本去替换它的复制按钮；只包一层
  `navigator.clipboard.writeText`。
- 不处理 `navigator.clipboard.readText`（粘贴按钮）与右键菜单的读写；本次只覆盖
  复制（写入）路径。若后续发现粘贴按钮同样失败，另立规格。
- 不为 Copilot 桥接（ACP）链路做任何改动。

## 4. 用户故事

- 作为 **VS Code 用户**，我希望在面板里点代码块/消息上的「复制」能直接拿到内容，
  以便贴到编辑器或终端里，而不是先手动选中再按 Ctrl+C。
- 作为 **维护者**，我希望这条能力走 VS Code 官方剪贴板 API 且可关闭，以便上游
  权限策略变化时不至于再次被动失效。

## 5. 验收标准（必须可执行）

- **AC-1（按钮复制成功）**：Given 面板已加载 DSH、插件已生效，When 在 DSH 页面点
  「复制」按钮且原生 `navigator.clipboard.writeText` 被拒，Then 文本经宿主
  `vscode.env.clipboard.writeText` 写入，插件返回成功（DSH 按钮显示「已复制」）。
- **AC-2（原生可用时不改变行为）**：Given 原生 `writeText` 成功，When 调用复制，
  Then 不向宿主发送任何消息，直接返回成功。
- **AC-3（非面板环境不接管）**：Given DSH 在系统浏览器中直接打开（不在 iframe 内），
  When 加载插件，Then 不包装 `navigator.clipboard`，行为与未安装插件一致。
- **AC-4（开关关闭完全退出）**：Given `dshPanel.installClipboardPlugin=false`，
  When 打开面板，Then 不安装/不更新插件文件，复制按钮行为维持本规格之前。
- **AC-5（协议安全）**：中继只接受 `origin` 为 DSH 地址、`source` 为
  `dsh-webview-clipboard` 的 `clipboard-write` 消息；`token` ≤64 字符、`text` 必须是
  字符串且 ≤1 MiB，越界整条丢弃并回 `ok:false`，不转发给宿主。
- **AC-6（失败可见）**：Given 宿主 `vscode.env.clipboard.writeText` 抛错（或插件未
  生效导致超时），Then 插件最终返回失败，宿主在首次连续失败时用状态栏提示一次
  「复制失败…可在编辑器里选中文本后按 Ctrl+C」，不刷屏。
- **AC-7（旧宿主回退）**：Given 面板由旧版扩展提供（不认识 `dsh-clipboard-write`），
  When 原生 API 失败且宿主 1.5 s 内无回执，Then 插件改用 textarea +
  `document.execCommand('copy')` 兜底；仍失败才返回失败。
- **AC-8（不改忠实窗口）**：插件不修改 DSH DOM 结构、不拦截复制按钮点击、不覆盖
  `readText`；只包装 `writeText` 并在 `apply()` 中注册一次（HMR 重复 apply 幂等）。

## 6. 兼容矩阵

| 场景 | 新版 dsh（0.2.x 插件可加载） | 旧版 dsh / 插件不可加载 | 说明 |
| --- | --- | --- | --- |
| Windows 本地 | AC-1 生效 | 复制按钮维持失败（与之前一致） | 本次主要修复面 |
| macOS 本地 | AC-1 生效；⌘C/⌘V/⌘X 修复保留 | 同上 | 两套能力共存 |
| Linux 本地 | AC-1 生效 | 同上 | 本次主要修复面 |
| WSL Remote | AC-1 生效（宿主在远端窗口内） | 同上 | webview 仍由本机 Electron 渲染 |
| Remote-SSH / Dev Containers | AC-1 生效 | 同上 | 同上 |
| 编辑器标签页打开面板 | AC-1 生效 | 同上 | 与侧边栏同一套中继 |
| 系统浏览器直接打开 DSH | 不适用（AC-3 不接管） | 不适用 | 浏览器原生 clipboard 正常 |

## 7. 约束（引用宪法）

- 宪法第一条（忠实窗口）：只包 `navigator.clipboard.writeText`，不碰 DOM、不拦
  click；内置插件可经配置关闭（AC-4）。
- 宪法第二条（零依赖零构建）：改动只落在扩展字符串生成器与插件 `client.js`，
  不引入依赖/打包器。
- 宪法第三条（禁止静默降级）：AC-6 的失败必须有一次可见提示，不能只 `console.warn`。
- 宪法第四条（安全默认）：`postMessage` 双校验（`origin` + `source`）、字段长度上限；
  宿主只接受本面板 iframe 的消息，文本不落盘、不写日志。
- 宪法第五条（兼容不倒退）：原生优先、旧宿主 `execCommand` 回退（AC-7）；插件版本
  升级后由既有「重启 dsh web」提示生效。
- 配置开关：复用 `dshPanel.installClipboardPlugin`（默认 `true`）。
- 安全：剪贴板文本经 `postMessage` 传入宿主，长度 ≤1 MiB；不记录、不持久化。

## 8. 失败与提示

| 失败场景 | 用户可见提示（中文文案要点） | 出口动作 |
| --- | --- | --- |
| 宿主写剪贴板抛错 | 状态栏一次性：「复制失败：<原因>。可在编辑器里选中文本后按 Ctrl+C（⌘C）复制」 | 面板顶部「重载」/手动选中复制 |
| 插件未生效（未重启 dsh web） | 沿用现有「已自动安装/更新 DSH 插件」提示；复制按钮仍失败（原生行为） | 重启 dsh web |
| 文本超过 1 MiB | 同「复制失败」提示（不静默截断） | 手动选中复制 |
| 非面板环境 | 无提示（不接管） | — |
| 开关关闭 | 无提示（用户显式关闭） | — |

提示走 `setStatusBarMessage`（8 s），同类失败一个窗口只提示一次。

## 9. 风险与开放问题

| 风险 / 未知 | 影响 | 应对 / 待验证 |
| --- | --- | --- |
| 覆写 `navigator.clipboard.writeText` 被 DSH 或其他插件再次覆盖 | 回退链失效 | `apply()` 幂等安装；调用时仍先走原生，最坏退化为当前行为 |
| 宿主回执超时（旧版扩展） | 每次复制多等 1.5 s | 超时后立即走 `execCommand` 兜底（AC-7）；插件与扩展同包分发，正常不会出现 |
| DSH 未来改用 `document.execCommand` 或不走 clipboard | 本修复变成无操作 | 原生优先，行为不变；无需跟随 |
| 1 MiB 上限对超长代码块误伤 | 极少数大文件复制失败 | 提示可见 + 手动选中复制；如确有需求再调大 |
| 上游 VS Code 修复 #182642 后权限放开 | 无副作用 | 原生优先，自动少走宿主通道 |

## 10. 验证记录

| 日期 | 方式 | 结论 |
| --- | --- | --- |
| 2026-10-29 | `npm test`（`clipboard-plugin.test.js` 42 项、`clipboard-bridge.test.js` 16 项；全量 16 套 / 617 项断言） | 通过 |
| 2026-10-29 | `npm run test:all`（e2e） | 不适用：本次未改动 DSH 进程内契约，仅页面侧剪贴板回退 |
| 2026-10-29 | 实机 F5（待验证） | 待验证：需在面板内点代码块复制按钮确认到位 |

## 11. 变更历史

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-10-29 | 初稿 | 复制按钮在 webview 跨源 iframe 中写入被拒 |
