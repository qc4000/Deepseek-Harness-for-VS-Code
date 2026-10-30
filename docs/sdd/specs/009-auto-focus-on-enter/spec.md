# 规格 009（草稿 / 暂缓）：焦点进入面板时自动激活 DSH 输入框

| 项 | 内容 |
| --- | --- |
| 编号 | 009 |
| 状态 | draft（**暂缓，未实现**） |
| 负责人 | @vithrive |
| 关联 | 依赖 008（`dsh-vscode-keys` 插件 + `focus-input` 消息） |
| 创建 / 更新 | 2026-10-29 / 2026-10-29 |

## 1. 背景

008 提供了**显式**的「聚焦 DSH 输入框」命令（`dshPanel.focusInput`）：按一次键，焦点从 VS Code 进入
webview → iframe → composer。但键盘用户的实际路径是：

```
composer 里按 F6（交还焦点）→ F6 → F6 → F6 落到侧栏视图 → Tab → DSH 侧栏按钮 → … → 输入框
```

真机观察（2026-10-29，Linux）：`F6`（`focusNextPart`）顺序为 `编辑器 → 底部面板 → 我们的侧栏视图`，
落到视图后再按 `Tab` 焦点能进入 iframe 内的 DSH 元素——说明「VS Code 焦点 → webview → iframe」这段是通的，
差的只是最后一跳。

## 2. 目标

焦点**进入**面板（F6 / Tab / 鼠标点空白）的那一瞬间，自动把光标放进 DSH 输入框，省掉手动 Tab 与命令。

## 3. 非目标

- 不改 VS Code 的 `focusNextPart` 顺序（改不了）。
- 不做「按 Tab 在 DSH 内部按顺序跳转」的接管。
- 不替代 008 的显式命令（两者共存，共用 `focus-input` 消息）。

## 4. 方案要点（实现时按此展开）

触发点：外层 webview 文档的 `window 'focus'` 与 `document 'focusin'`（`target` 为
`body` / `documentElement` / `#dsh-stage` 时才算"进入面板"）。

```
focus → 60ms 防抖 → frame.focus() + postToFrame{type:'focus-input', reason:'focus'}
      → 页面插件 focusComposer()：conversation.input.for(ctx).focus()（try）→ DOM 回退
      → ok:false 时**安静放弃**（自动路径不打扰；显式命令才提示）
```

### 必须有的三道保险（真机上少一道就出事故）

1. **F6 自锁**：`releaseFocus()` 置 `autoFocusSkipUntil = now + 1500`；否则「交还焦点 → 外层 focus →
   自动塞回 composer」会让 `F6` 永远离不开面板。
2. **只抢文档/空白**：`focusin` 目标是工具条按钮时不接管，否则键盘用户 `Tab` 不到侧栏开关按钮。
3. **只试一次**：60ms 防抖合并连按产生的多次 focus；失败不重试（避免抖动）。

其它约束：DSH 弹窗（`[aria-modal="true"]`）打开期间不抢；`dshPanel.focusInputOnEnter`（默认 `true`）
可关闭本行为；无会话（只有 hero 输入框）时靠同一组选择器兜底，命中不到就放弃。

## 5. 验收标准（草稿）

- **AC-1**：Given `focusInputOnEnter=true` 且 composer 存在，When 外层 webview 文档收到 `focus`，Then
  恰好一次 `focus-input` 且 `frame.focus()` 被调用。
- **AC-2**：Given 刚执行过 `focus-release`，When 1.5s 内的 `focus`，Then 不产生 `focus-input`（F6 自锁）。
- **AC-3**：Given `focusin` 的 target 是 `#dsh-sidebar-toggle`，Then 不接管。
- **AC-4**：Given composer 不存在（无会话），Then 安静放弃（不弹提示、不重试）。
- **AC-5**：Given `focusInputOnEnter=false`，Then 与不存在本能力时完全一致。

## 6. 暂缓原因

- 008 刚落地，先把显式命令的键位/开关打磨顺（用户当前诉求）；
- 自动抢焦点会改变「点面板只是想看回答」的键盘行为，需要在真机上先确认用户手势与滚动习惯；
- 与 F6 自锁的交互必须在真机上验证，否则容易出现「F6 出不去」这类死循环问题。

## 7. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| F6 自锁失效 | 焦点无法离开面板 | AC-2 断言 + 真机四步循环验证 |
| 自动聚焦打断阅读（PageDown 落到输入框） | 观感变差 | `focusInputOnEnter=false` 关闭 |
| 弹层（斜杠/@）期间抢焦点 | 打断操作 | 复用 `modalOpen()` 判定 |
