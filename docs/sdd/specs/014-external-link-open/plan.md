# 技术方案 014：面板内新窗口/新标签外链的浏览器选择

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：approved） |
| 负责人 | @Vithrive |
| 更新 | 2026-11-03 |

## 1. 方案概述

把现有内置插件 `dsh-vscode-open-external` 从「只补 `window.open`」扩展成「外链桥」：
页面侧在 capture 阶段监听 `click` / `auxclick`，只识别**新窗口/新标签意图**，经 webview
中继交给宿主；宿主按 `dshPanel.externalLinkAction` 选择系统浏览器或 VS Code 内置浏览器。
DSH 已经 `preventDefault()` 的点击（聊天侧栏）与登录 `about:blank` 链路保持原样。

```
<a target=_blank> / Ctrl(⌘/Shift)+Click / 中键
  → dsh-vscode-open-external（页面 capture）
      · http(s) / 非同源 / 非 download / ≤8192
      · _blank 普通左键：微任务检查 defaultPrevented（DSH 已接管则跳过）
      · 修饰键/中键/_parent/_top/具名 target：立即 preventDefault + 转交
      · _self / 无 target：不接管（spec 非目标）
  → postMessage({ source, type:'open', url, kind:'link' })
  → webview 中继（origin/source + 长度 + kind 白名单）
  → vscode.postMessage({ type:'dsh-open-link', url, kind })
  → routeOpenLink(url, kind)
      · login → vscode.env.openExternal（固定）
      · link + off → 忽略
      · link/popup + vscodeBrowser → simpleBrowser.show（失败回退 openExternal）
      · 其它 → vscode.env.openExternal
```

## 2. 影响面

| 文件 / 函数 | 改动性质 | 触碰安全数据流 | 对应 AC |
| --- | --- | --- | --- |
| `dsh-plugins/dsh-vscode-open-external/lib/client.js` | 新增 click/auxclick 桥、`kind`、去重、`externalLinks` ack；保留 window.open | 页面 postMessage | AC-1/3/4/5/6/7/9/11 |
| `dsh-plugins/dsh-vscode-open-external/package.json` | 0.1.0 → 0.2.0 | 否 | 触发 profile 更新 |
| `extension.js` `externalLinkAction` / `parseHttpUrl` / `routeOpenLink` / `openInVSCodeBrowser` | 新增 | webview + 外部 URL | AC-1/2/6/8/12 |
| `extension.js` `buildIframeHtml` / `handleWebviewMessage` | 修改（ack 增加 `externalLinks`、中继透传 `kind`、热更新） | webview | AC-1/9/10 |
| `package.json` 配置项 | 新增 `dshPanel.externalLinkAction` | 否 | AC-1/2/6 |
| `test/open-external-plugin.test.js` | 扩展 | — | AC-1/3/4/5/6/7/9/10/11 |
| `test/external-link-open.test.js` | 新增 | — | AC-1/2/6/8/10/12 |
| `docs/TESTING.md` / `docs/ARCHITECTURE.md` / `README.md` / `CHANGELOG.md` | 文档 | — | — |

## 3. 契约变更与兼容

| 契约 | 新形态 | 旧形态 / 回退 | 探测方式 |
| --- | --- | --- | --- |
| ack | `{ type:'ack', openExternal:true, externalLinks:boolean }` | 旧宿主无 `externalLinks` → 插件按 false，点击桥不启用 | 字段严格等于 true |
| `open` 消息 | `{ type:'open', url, kind:'login'|'popup'|'link' }` | 旧插件无 `kind` → 按 `popup`（系统浏览器） | `kind` 白名单，非法值回退 `popup` |
| 宿主消息 | `{ type:'dsh-external-links-config', enabled:boolean }` | 旧插件不认 → 忽略，不影响 | 仅更新已加载页面，不重载 iframe |
| 配置 | `dshPanel.externalLinkAction` 三值 | 非法值 → `systemBrowser` | `EXTERNAL_LINK_ACTIONS.includes` |
| VS Code API | `simpleBrowser.show` | 命令不存在/抛错 → 状态栏提示 + `openExternal` | try/catch |

## 4. 状态与并发

| 状态 | 位置 | 谁置位 | 谁清理 | 失效策略 |
| --- | --- | --- | --- | --- |
| `acked` / `externalLinks` | 页面插件内存 | ack | 插件卸载 / ack false | 页面刷新重握手 |
| `lastHandOff`（去重） | 页面插件内存 | `handOff` | 600ms 后自然失效 | URL + 时间窗 |
| 失败提示一次性标志 | 扩展宿主内存 | 失败分支 | 扩展停用 | 每窗口一次 |
| 插件版本 | profile `node_modules` | `ensureOpenExternalPlugin` | 扩展升级时覆盖 | 版本号比较 |

并发去重：插件侧 `URL + 600ms` 单值去重，避免 `window.open` 与 click 双发；配置热更新
幂等（重复 ack 不重复绑定监听）。

## 5. 安全审查

- [x] 不新增 `spawn`/`exec`。
- [x] webview CSP 未放宽；未新增插值，沿用 `jsonForScript`。
- [x] `postMessage` 校验 `origin` + `source`；`url` 类型/长度、`kind` 白名单。
- [x] 宿主 `parseHttpUrl` 二次净化（只 http/https、≤8192）。
- [x] token / Cookie 不进日志、错误消息；失败提示不含完整 URL。
- [x] 页面不能指定命令 id；系统/内置浏览器由宿主配置决定。
- [x] 仅 trusted 用户点击；脚本合成 click 不转交。

## 6. 测试策略（先红后绿）

| 层 | 套件 | 要加的断言（映射 AC） |
| --- | --- | --- |
| L3 仿真 | `test/open-external-plugin.test.js` | AC-1/3/4/5/6/7/9/11 |
| L2 中继 | 同上 | AC-1/9/10 |
| L1 宿主 | `test/external-link-open.test.js` | AC-1/2/6/8/10/12 |
| L2 安装 | 同上 | 插件 0.2.0 落盘/幂等/不写 dependencies |

- 必跑：`TMPDIR=/tmp npm test`（当前环境 TMPDIR 指向只读目录）。
- 不涉及 DSH 服务端契约，`npm run test:all` 非必需；实机 F5 覆盖三平台面板点击。

## 7. 实施步骤

1. 基础设施：常量、`externalLinkAction`、`parseHttpUrl`、`__internals`。
2. 宿主路由：`routeOpenLink` / `openInSystemBrowser` / `openInVSCodeBrowser` / 失败提示。
3. 页面插件 0.2.0：click/auxclick 桥、`kind`、去重、`externalLinks` ack。
4. 中继：ack 字段、`open.kind`、`dsh-external-links-config` 热更新。
5. 配置项与配置监听（热更新，不重载）。
6. 文档、测试地图、CHANGELOG；插件版本 0.2.0。

## 8. 回退方案

| 层级 | 手段 | 触发条件 |
| --- | --- | --- |
| 功能 | `dshPanel.externalLinkAction=off` | 用户只想保留原有 window.open 行为 |
| 安装 | `dshPanel.installOpenExternalPlugin=false` | 怀疑插件影响 dsh web |
| 代码 | 回退插件到 0.1.0（窗口打开链路仍在） | 新版页面逻辑异常 |
| 发布 | 补丁版本修复 | 线上故障 |

## 9. 被否方案与原因

| 方案 | 否决原因 |
| --- | --- |
| 让用户把 DSH `linkOpening` 改成「新标签页」 | 只覆盖聊天 markdown，设置页/插件市场/账号页仍死 |
| 给 iframe 加 `allow-popups` | 外层 webview sandbox 由 VS Code 控制，子 frame 无法提权 |
| 直接安装第三方 `dsh-open-links` | 不提供目标选择、不区分 login/popup、需要额外插件与网络安装，违反零依赖 |
| 接管 `target=_self` | 用户拍板保持现状，且会误伤 DSH 同源内部导航 |
| 每次点击弹 QuickPick | 噪音大；全局设置已满足需求 |

## 10. 开放问题

- 登录授权页是否跟随 `vscodeBrowser`：用户已拍板「保持原行为」，后续如需再评估 OAuth 回调。
- `_self` 外链导致面板被导航走：本规格不处理，保留为后续候选。
