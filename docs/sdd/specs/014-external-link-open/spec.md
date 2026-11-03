# 规格 014：面板内新窗口/新标签外链改用系统浏览器或 VS Code 内置浏览器

| 项 | 内容 |
| --- | --- |
| 编号 | 014 |
| 状态 | implemented（离线 22 套 / 1123 项断言通过；实机 F5 待用户验证） |
| 负责人 | @Vithrive |
| 关联 | 扩展 `dsh-vscode-open-external` 0.1.0 → 0.2.0 · 目标版本待维护者确认 |
| 创建 / 更新 | 2026-11-03 / 2026-11-03 |

## 1. 背景与问题

**现象（真机）**：在 DSH 面板里点击一部分外链没有任何反应；另一部分（聊天里普通左键）
仍能打开。用户要求：这些链接改用**系统浏览器**或 **VS Code 内置浏览器**打开，并提供一个设置项。

**根因（代码链路已确认）**：

1. VS Code webview 宿主 iframe 的 sandbox 只有 `allow-same-origin / allow-pointer-lock /
   allow-scripts / allow-downloads / allow-forms`，**没有 `allow-popups` 与
   `allow-top-navigation`**。DSH 以跨源 iframe 嵌在该 webview 里，sandbox 标志向下继承。
2. 现有内置插件 `dsh-vscode-open-external`（0.1.0）只接管 `window.open`：
   `about:blank` 登录桩 + 直接 `window.open(http(s))` 转交宿主。
3. DSH 的链接大多不经过 `window.open`：
   - 聊天 markdown 对 http(s) 链接渲染成 `<a target="_blank">`，普通左键由 DSH 自己
     `preventDefault()` 后走侧栏浏览器/`window.open`；按住 Ctrl/Cmd/Shift/Alt 时 DSH
     直接 `return`，交给浏览器默认动作 → 被 sandbox 拦掉。
   - 设置页、插件市场、账号页、Web 搜索指南、工具结果摘要等处的 `<a target="_blank">`
     没有 `onClick`，普通左键也直接死。
   - 中键走 `auxclick`，同样被拦掉。
4. 因此「一些链接没反应」，而 DSH 自己接管的点击（侧栏浏览器）仍然正常。

## 2. 目标

- 面板内 `<a>` 的**新窗口/新标签意图**（`target=_blank`、`_parent`、`_top`、具名 target、
  Ctrl/⌘/Shift + 左键、中键）改为在宿主打开：
  - `systemBrowser`：系统默认浏览器（Remote-SSH / WSL 下由客户端浏览器打开）；
  - `vscodeBrowser`：VS Code 内置浏览器（`simpleBrowser.show` / 浏览器视图）。
- 新增设置 `dshPanel.externalLinkAction`（`off | systemBrowser | vscodeBrowser`，默认
  `systemBrowser`，可热更新，不重载 iframe）。
- **不改变 DSH 已经接管的点击**：DSH `preventDefault()` 的普通左键仍走 DSH 侧栏浏览器；
  `window.open` 登录链路 (`about:blank` 桩) 保持原有行为。
- 失败必须用户可见：内置浏览器不可用 / 系统浏览器打不开时给中文状态栏提示。

## 3. 非目标

- **不接管 `target=_self` / 无 target 的跨源外链**（用户拍板：保持现状），包括带修饰键或中键的点击。
  这类链接仍会把 iframe 导航走，不在本规格修复范围。
- **不改登录授权页的打开方式**（用户拍板：保持原行为）。`about:blank` 登录桩导航仍固定
  交 `vscode.env.openExternal`（系统浏览器），不跟随 `vscodeBrowser`。
- 不接管 `mailto:` / `tel:` / `file:` / `blob:` / 自定义 scheme。
- 不接管 DSH 右侧浏览器里再嵌的第三方跨源页面（页面插件够不到）。
- 不改 DSH 的 `linkOpening` 设置，不做每次点击的 QuickPick。

## 4. 用户故事

- 作为 **VS Code 用户**，我在面板里点聊天里的 Ctrl/Cmd+链接、设置页/插件市场里的外链时，
  希望它按我的设置打开，而不是「点了没反应」。
- 作为 **Remote-SSH / WSL 用户**，我希望外链由我本机的浏览器打开，而不是服务器的默认浏览器。
- 作为 **维护者**，我希望原有 `window.open` 登录链路和 DSH 侧栏行为一条都不回退。

## 5. 验收标准（必须可执行）

- **AC-1**：Given 面板已握手、`externalLinkAction=systemBrowser`、插件 0.2.0，
  When 点击一个 DSH 未接管的 `<a target="_blank" href="https://...">`，
  Then 页面插件发 `open`（`kind:'link'`），中继转 `dsh-open-link`，宿主调用
  `vscode.env.openExternal`；DSH 页面不导航。
  （断言：`open-external-plugin` 客户端仿真 + 中继 + `external-link-open` 宿主路由）
- **AC-2**：Given `externalLinkAction=vscodeBrowser`，When 点击同样的链接，
  Then 宿主调用 `vscode.commands.executeCommand('simpleBrowser.show', url)`，不调
  `openExternal`。（断言：`external-link-open`）
- **AC-3**：Given DSH 自己已 `preventDefault()` 的普通左键（聊天「在侧栏打开」），
  When 点击，Then 插件不发消息，DSH 侧栏行为完全不变。（断言：`open-external-plugin`）
- **AC-4**：Given `target="_blank"` 的普通左键，但 DSH 的 handler 只
  `stopPropagation()` 不 `preventDefault()`，When 点击，Then 微任务仍能看到未取消，
  转交宿主。（断言：`open-external-plugin`）
- **AC-5**：Given 目标为新窗口（`_blank` / `_parent` / `_top` / 具名 target）的链接，When Ctrl/⌘/Shift + 左键或中键点击，Then 立即 `preventDefault` 并转交宿主；Alt + 左键不接管（保留浏览器下载语义）。（断言：`open-external-plugin`）
- **AC-6**：Given `externalLinkAction=off`，When 点击 `<a>` 新窗口链接，
  Then 不转发、不打开（保持现状）；但 `window.open`（`kind:'popup'`/`'login'`）仍按原行为
  走系统浏览器。（断言：`open-external-plugin` + `external-link-open`）
- **AC-7**：Given 同源/相对链接、`#hash`、`download` 属性、非 http(s)、超过 8192 字符，
  或 `target=_self` / 无 target（即使带修饰键或中键），When 点击，Then 一律不接管。
  （断言：`open-external-plugin`）
- **AC-8**：Given `simpleBrowser.show` 不存在或抛错，When 点击且设置为 `vscodeBrowser`，
  Then 状态栏提示一次并回退 `vscode.env.openExternal`；`openExternal` 返回 `false` 时
  同样有可见提示。（断言：`external-link-open`）
- **AC-9**：Given 配置从 `off` 改为 `systemBrowser`（或反向），When 修改设置，
  Then webview 收到 `dsh-external-links-config` 并重发 ack，插件即时启用/停用点击桥，
  **不重载 iframe**。（断言：`open-external-plugin` 中继热更新）
- **AC-10**：Given 旧插件 0.1.0 + 新宿主，Then ack 缺 `externalLinks` 时点击桥不启用；
  旧插件的 `open` 无 `kind` 按 `popup` 处理，仍走系统浏览器。
  Given 新插件 + 旧宿主，Then 旧宿主忽略 `externalLinks`/`kind`，不报错、行为退回系统浏览器。
  （断言：`open-external-plugin` + `external-link-open`）
- **AC-11**：Given 独立浏览器打开 DSH（非 iframe），Then 插件完全不介入。
  （断言：`open-external-plugin` 既有断言）
- **AC-12**：Given `externalLinkAction` 非法值，Then 按 `systemBrowser` 处理；
  `parseHttpUrl` 拒绝 `javascript:` / `file:` / `data:` / 空串 / 超长。
  （断言：`external-link-open`）

## 6. 兼容矩阵

| 场景 | 新版 dsh | 旧版 dsh | 说明 |
| --- | --- | --- | --- |
| Windows 本地 | 系统 / VS Code 内置浏览器 | 同左 | 插件客户端逻辑与 dsh 版本无关 |
| macOS 本地 | 同上；Ctrl+click 不当作新标签 | 同上 | 避免抢右键菜单 |
| Linux 本地 | 同上 | 同上 | 无平台分支 |
| WSL Remote | 系统浏览器由 Windows 打开；内置浏览器按现有 `toClientUrl` | 同上 | 回环转发沿用 `needsPortForwarding` |
| Remote-SSH / Dev Containers | `openExternal` 自动解析；`vscodeBrowser` 先 `asExternalUri` | 同上 | 转发失败回退系统浏览器 |
| 系统浏览器打开 DSH（非面板） | 不接管 | 不接管 | 插件 `inIframe()` 为假 |
| 旧插件 0.1.0 + 新宿主 | 点击桥不启用；window.open 仍走系统 | — | ack 缺 `externalLinks` |
| 新插件 0.2.0 + 旧宿主 | 旧宿主忽略新字段，行为退回系统 | — | `kind` 被忽略 |

## 7. 约束（引用宪法）

- **第一条（忠实窗口）**：只通过可关闭的内置插件在页面侧监听 click，不改 DOM、不拦
  DSH 已处理的点击、不重载 iframe 热更新。
- **第二条（零依赖零构建）**：只用 `vscode` API 与标准 DOM API，不新增依赖。
- **第三条（禁止静默降级）**：内置浏览器不可用、`openExternal` 失败都有中文状态栏提示。
- **第四条（安全默认）**：只放行 http(s)，长度 ≤ 8192；中继 origin/source 双校验；
  宿主二次净化；页面不能指定命令 id。
- **第五条（兼容不倒退）**：`window.open` 登录链路、DSH 侧栏点击、旧插件/旧宿主均保留回退。
- **第六条（可测性）**：`externalLinkAction` / `parseHttpUrl` / `routeOpenLink` 抽纯函数并挂
  `module.exports.__internals`。

## 8. 失败与提示

| 失败场景 | 用户可见提示（中文文案要点） | 出口动作 |
| --- | --- | --- |
| `simpleBrowser.show` 不存在/抛错 | 「VS Code 内置浏览器不可用，已改用系统浏览器打开该链接。」（只提示一次） | 回退 `vscode.env.openExternal` |
| `openExternal` 返回 false/抛错 | 「系统浏览器未能打开该链接。可在设置 dshPanel.externalLinkAction 中改用 VS Code 内置浏览器。」（只提示一次） | 链接不打开；用户可手动复制 |
| 真远程 + 回环 + 内置浏览器转发失败 | 同上「内置浏览器不可用…」 | 回退系统浏览器（自动端口转发） |
| 非法 URL / 超长 | 无额外提示（页面侧静默丢弃，保持原行为） | 不打开 |

## 9. 风险与开放问题

| 风险 / 未知 | 影响 | 应对 / 待验证 |
| --- | --- | --- |
| 某些第三方 DSH UI 对 `_blank` 点击有自定义 `preventDefault` 且不打开 | 插件会跳过，链接仍无反应 | 这是「DSH 已接管」的边界，按 AC-3 保留；真机反馈再单独处理 |
| `simpleBrowser.show` 在不同 VS Code 发行版行为不一致 | 可能打开错误的面板/失败 | catch + 状态栏 + 回退系统浏览器；1.133 已确认命令存在 |
| 微任务检查 `defaultPrevented` 依赖 React 在 document 之前处理事件 | 若框架改为异步处理，可能误判 | 现有 DSH 为同步 React handler；后续升级需真机复验 |
| `externalLinkAction=off` 时 `window.open` 仍走系统 | 用户以为「全关」 | 设置描述与 README 明确：off 只关 `<a>` 点击桥，登录/新标签桥不变 |
| `_self` 外链仍会把面板导航走 | 面板被替换 | 用户已拍板不处理；保留为后续规格候选 |

## 10. 验证记录

| 日期 | 方式 | 结论 |
| --- | --- | --- |
| 2026-11-03 | 先红：新增/修改 `open-external-plugin`、`external-link-open` 断言 | 先红成立（分别断在 `kind`/`externalLinks` 与路由函数不存在） |
| 2026-11-03 | `TMPDIR=/tmp npm test` | 22 套 / 1123 项断言全绿（`open-external-plugin` 107、`external-link-open` 51） |
| 2026-11-03 | 实机 F5（面板内点插件市场/设置页外链、Ctrl+点击、中键） | 未执行（需真机面板；待用户验证） |

## 11. 变更历史

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-11-03 | 初稿 | 用户确认默认 `systemBrowser`、不处理 `_self`、登录保持系统浏览器 |
