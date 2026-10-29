# 技术方案 008：面板内 VS Code 快捷键转发

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：approved） |
| 负责人 | @vithrive |
| 更新 | 2026-10-29 |

## 1. 方案概述

沿用 spec 007 的三跳链路：**页面内插件（只读监听）→ webview 中继（校验）→ 宿主动作（executeCommand）**。
关键设计是「宿主把转发表编译成物理键签名下发给页面，页面只做签名查表」，因此页面侧没有键位解析逻辑，
两端不会漂移；冲突判定放在页面侧（只有页面拿得到 DSH 的 `shortcuts` 服务），命中即让位。

```
keydown（冒泡）→ dsh-vscode-keys：签名查表 → 问 DSH 键位目录
   ├─ 冲突 → 放行（不 preventDefault）→ DSH 自己处理
   └─ 不冲突 → preventDefault + postMessage{type:'key', gesture}
        → 中继校验 origin/source/字段 → vscode.postMessage('dsh-forwarded-key')
        → 宿主按自己的表把 gesture 映射成命令 id → workbench.action.*
```

「宿主下发表、页面只查表」也顺带满足了 AC-6：页面即使被篡改也**无法指定命令 id**，只能报一个 gesture。

## 2. 影响面

| 文件 / 函数 | 改动性质 | 触碰安全数据流 | 对应 AC |
| --- | --- | --- | --- |
| `extension.js` 常量区（`KEYS_PLUGIN_*`、`DEFAULT_FORWARD_KEYS`、配置键、上限） | 新增 | 否 | AC-1/3/4 |
| `extension.js` `normalizeCombo` / `comboToGesture` / `gestureSignature` / `comboFromGesture` | 新增（纯函数） | 否 | AC-1/4/5/6 |
| `extension.js` `parseForwardKeybindings` / `buildForwardTable` / `buildForwardKeyMap` | 新增（纯函数） | 否 | AC-4/5 |
| `extension.js` `shouldInstallKeysPlugin` / `ensureKeysPlugin` + `ensureDshPlugins` 接入 | 新增 | 文件写入（DSH profile） | AC-3 |
| `extension.js` `buildIframeHtml`（签名 + 内联 KEYS_TABLE + 中继分支 + `#dsh-stage` tabindex） | 修改 | webview | AC-1/2/3/6/7/9 |
| `extension.js` `handleWebviewMessage`（三个新消息分支） | 修改 | webview → 命令执行 | AC-1/6/7/8 |
| `extension.js` `showKeyStatus` / `addForwardKey`（`dshPanel.keyStatus`） | 新增 | 配置写入（Global） | AC-8/10 |
| `extension.js` 配置变更监听（视图 + 标签页两处） | 修改 | 否 | AC-9 |
| `dsh-plugins/dsh-vscode-keys/*` | 新增 | 否 | AC-2/7/11 |
| `test/key-bridge.test.js` | 新增 | — | AC-1/3/4/5/6/7/9 |
| `test/key-bridge-client.test.js` | 新增 | — | AC-2/7/10/11 |
| `package.json`（3 个配置 + 1 个命令） | 新增 | 否 | AC-8 |
| `README.md` / `CHANGELOG.md` / `docs/TESTING.md` / `docs/ARCHITECTURE.md` | 更新 | — | — |

## 3. 契约变更与兼容

| 契约 | 新形态 | 旧形态 / 回退 | 探测方式 |
| --- | --- | --- | --- |
| DSH `shortcuts` 服务 | `catalog` / `fixedCatalog` 快照（`binding{code,modifiers}`）→ 本地签名索引；`subscribe` 变化即刷新 | 服务不存在 / 快照形态不符 → 不做让位（静态表仍生效），`degraded:true` 回报宿主 | `typeof svc.catalog.getSnapshot === 'function'` 且返回数组 |
| DSH `catalog` / `fixedCatalog` | 同时用于 `keyStatus` 的让位清单展示 | 缺失 → 只展示本次按过的让位项 | 同上 |
| 插件消息 | `hello` → `keys-ack{table, releaseKey}`；`key{gesture}`；`focus-release`；`keys-status{degraded, shadowed}` | 旧扩展不认识 `keys-ack` → 插件永远不 ack，等于不介入 | 新消息类型 **不复用 `ack`**（避免 file-links 的 `layoutOnly` 判别） |
| 宿主 → webview | `dsh-keys-config{enabled, table, releaseKey}` | 无回退：纯新增 | `type` 分派 |
| 配置项 | 3 个新键，默认值与旧行为一致（关闭即等价于不存在） | 非法值逐条忽略 + 一次性提示 | 逐条校验 |

## 4. 状态与并发

| 状态 | 位置 | 谁置位 | 谁清理 | 失效策略 |
| --- | --- | --- | --- | --- |
| `keysInvalidNotified` / `forwardFailureNotified`（Set） | 内存 | `buildForwardTable()` 解析 / 转发失败 | 配置变更时重置 | 每窗口/每 id 一次，避免刷屏 |
| `keyShadowed`（页面让位清单） | 内存（宿主） | `dsh-keys-report` | 面板重载覆盖 | 仅用于 `keyStatus` 展示 |
| `keyReportWaiters`（Promise 等待器） | 内存 | `requestKeysReport()` | 超时 1500ms | 单次请求 |
| 插件版本 | `dsh-plugins/dsh-vscode-keys/package.json` | 维护者 | `ensureKeysPlugin` 比对 | 版本不一致即覆盖安装 |

并发去重：`ensureDshPlugins()` 已在 `preparePanelHtml()` 串行路径上，沿用既有幂等文件写入（版本比对后整包覆盖）。
配置变更只推消息、不重载 iframe，避免丢失 DSH 当前对话。

## 5. 安全审查

- [x] 进入 `spawn`/`exec` 的值：本能力不新增子进程。
- [x] webview CSP 未放宽；新增插值全部走 `jsonForScript`；脚本仍带 nonce。
- [x] `postMessage` 校验 `origin` + `source`；gesture 字段白名单（`code` 正则 ≤16、四个布尔）；
      中继把不符合的整条丢弃。
- [x] 宿主只按自己的表映射命令，页面无法指定命令 id（AC-6）；命令 id 仅
      `^[a-z][a-zA-Z0-9_.\-]*$` 且不传参。
- [x] 不写日志、不落盘 token/Cookie；配置读取只发生在内存。
- [x] 新增外部输入（配置对象、gesture）已列入 `test/key-bridge.test.js`。

## 6. 测试策略（先红后绿）

| 层 | 套件 | 要加的断言（映射 AC） |
| --- | --- | --- |
| L1 纯函数 | `test/key-bridge.test.js` | `normalizeCombo` 三平台 / chord 与无修饰键拒绝；`parseForwardKeybindings` 六类非法；`buildForwardTable` 覆盖与禁用（AC-4/5） |
| L2 协议（中继） | `test/key-bridge.test.js` | vm 跑 `buildIframeHtml` 内联脚本：hello→keys-ack 带表；合法 gesture 转发；非法 gesture 丢弃；`keysEnabled=false` 时不 ack；F6→blur+stage.focus；`dsh-keys-config` 热更新（AC-1/3/6/7/9） |
| L2 宿主 | `test/key-bridge.test.js` | `dsh-forwarded-key` → executeCommand 入参；非法 gesture 不执行；`dsh-focus-released` 提示一次；`dsh-keys-report` 落库（AC-1/6/7/8） |
| L3 插件仿真 | `test/key-bridge-client.test.js` | vm 跑真实 `lib/client.js`：未握手不介入；命中键 preventDefault+发消息；DSH 冲突让位并记入报告；无 shortcuts 服务→降级仍转发；F6→focus-release；独立浏览器不 hello（AC-2/7/10/11） |
| L4 e2e | 不新增 | 不涉及 DSH RPC 契约；插件契约由 L3 仿真覆盖 |

- 必跑：`npm test`（离线全绿）。
- 手验：Windows/macOS/Linux 各一次，确认「按一遍两批键 → 期望动作」「按 Ctrl+Shift+F 仍是 DSH fork」「F6 交还焦点」。

## 7. 实施步骤

1. 基础设施：常量、默认表、配置键；纯函数挂 `__internals`。
2. 纯逻辑：`normalizeCombo` / gesture 互转 / 配置解析 / 表合并（先写红断言）。
3. 宿主接入：`ensureKeysPlugin` 接入 `ensureDshPlugins`；`handleWebviewMessage` 三分支；配置变更推送。
4. 页面侧：`buildIframeHtml` 中继分支 + `#dsh-stage` tabindex；`dsh-plugins/dsh-vscode-keys` 客户端。
5. 命令与文档：`dshPanel.keyStatus`；`package.json` 配置项；README/CHANGELOG/TESTING/ARCHITECTURE。

## 8. 回退方案

| 层级 | 手段 | 触发条件 |
| --- | --- | --- |
| 功能 | `dshPanel.forwardVSCodeKeys=false`（默认 `true`） | 用户遇到兼容问题 / 排查启动 |
| 单键 | `"<combo>": false` | 某组合与自己的工作流冲突 |
| 代码 | 页面侧 `shortcuts` 服务缺失即不与 DSH 冲突判定（只按静态表），不影响转发主链路 | DSH 契约异常 |
| 发布 | 补丁版本回退（Marketplace 不可降级，只能发修复版） | 线上故障 |

## 9. 被否方案与原因

| 方案 | 否决原因 |
| --- | --- |
| 在 webview 外层监听 keydown | 物理上收不到：跨源 iframe 的 keydown 不会冒泡到父文档（microsoft/vscode#65452） |
| `contributes.keybindings` + `when` | 事件到不了 keybinding service，`when` 永远不成立 |
| 宿主合成按键事件重放 | `isTrusted=false`，workbench 不认 |
| 解析用户 `keybindings.json` | Remote 下文件在客户端、扩展在服务端；`when`/chord/平台差异会导致误判 |
| `"ctrl+h": true` 自动解析 | 无公开反查 API；内置镜像表会随 VS Code 版本漂移，且会悄悄改变配置语义（用户决策：不做） |
| 冲突时以 VS Code 为准（抢 DSH 的键） | 违反宪法第一条；改为「DSH 优先 + 用户去 DSH 改绑」 |
| 支持 chord | 需要前缀状态机，与 DSH 的 `secondCode`/`stopSequenceMs` 互相干扰；收益低 |

## 10. 开放问题

- 若 DSH 后续把 `describeBinding` 改成异步，则页面侧改为「按 ack 下发的冲突清单」（由页面启动时批量预取）。
- 若用户普遍反馈 `F6` 与 VS Code `focusNextPart` 混淆，则把默认值改成 `ctrl+shift+alt+v` 或默认关闭。
