# 架构说明

> 面向要改 `extension.js` 的人。本文只描述**现状**（1.0.0）；变更流程见
> [docs/sdd/README.md](sdd/README.md)，原则见 [docs/CONSTITUTION.md](CONSTITUTION.md)。
> 代码引用一律用函数名定位（行号会漂移）：`extension.js` 内按
> `// =====` / `// ──` 注释分节，搜函数名最快。

## 1. 运行时形态

| 项 | 值 | 说明 |
| --- | --- | --- |
| 入口 | `./extension.js`（CommonJS） | `activate(context)` / `deactivate()` |
| 扩展类型 | `extensionKind: ["workspace"]` | Remote-SSH / Dev Containers 下**跑在服务器端**，子进程与文件访问都发生在远端 |
| 激活事件 | `onView:dsh.webview`、`onCommand:dshPanel.resetChatMapping`、`onCommand:dshPanel.chatStatus`、`onStartupFinished` | `onStartupFinished` 用于尽早注册语言模型提供方 |
| 视图 | 活动栏容器 `dsh-panel` → webview 视图 `dsh.webview` | `retainContextWhenHidden: true` |
| 标签页 | `vscode.window.createWebviewPanel('dsh.tab', …)` | 单例，关闭时恢复侧边栏 |
| 语言模型 | `contributes.languageModelChatProviders: vendor=dsh` | 实际注册在 `registerDshModelProvider()`，需 `vscode.lm` 可用 |
| 依赖 | 无 | 只用 `vscode` + Node 内置模块（`http/https/net` 相关均用内置实现） |

## 2. `extension.js` 分区

| 分区（搜注释/函数） | 职责 |
| --- | --- |
| 顶部常量与可变状态 | `VIEW_ID`、`DEFAULT_URL`、`managedChild`、`authProxy`、`dshInvocation` 等模块级单例 |
| 配置读取与净化 | `cfg` / `getUrl` / `getHost` / `getPort` / `sanitizeCommand` / `getDshCommand` |
| 子进程执行 | `runCommandOk` / `runCommandOutput` / `resolveDshInvocation` / `installDsh` / `ensureDshInstalled` |
| 网络与 RPC | `checkUrl` / `httpPostJson` / `dshRpc` / `fetchSessionHistory` / `DSH_RPC_ENDPOINT_RENAME` |
| 认证代理（`// ===== dsh web 浏览器认证…`） | `isLocalLoopbackTarget` / `learnDshToken` / `ensureAuthProxy` / `createAuthProxy` / `resolvePanelTarget` / `maybeGuideAuth` / `apiBase` |
| 进程生命周期 | `startDsh` / `dshWebSupportsNoOpen` / `attachDshOutputReader` / `killTree` / `ensureRunning` / `startDshAndWaitReady` / `waitDshFullBoot` / `freePort` / `restartDsh` |
| 面板 HTML | `getFontScale` / `buildLoadingHtml` / `buildErrorHtml` / `buildSuspendedHtml` / `jsonForScript` / `buildIframeHtml` / `escapeHtml` |
| 插件管理（`// ===== DSH 配套插件自动安装/管理`） | `dshWebProfileDir` / `ensureProfileDeclaration` / `installPluginViaNpm` / `clipboardPluginFiles` / `fileLinkPluginFiles` / `ensureDshPlugins` |
| 文件链接接管 | `normalizeLinkPath` / `resolveWorkspaceTarget` / `revealWorkspaceTarget` / `handleWebviewMessage` |
| 会话文件解析（`// ===== 磁盘直读`） | `parseChatSessionText` / `readChatSessionCached` / `chatUserDataDirs` / `listChatSessionFiles` / `locateModelChatSessionId` |
| Copilot 桥接（`// ===== DSH 语言模型提供方`） | `lmMessageText` / `serializeLmMessages` / `detectSyntheticRequest` / `dshEventText` / `applyDshEvents` / `replayDshAnswer` / `handleDshModelRequest` / `resolveDshModelSelection` / `checkDshModelDrift` / `registerDshModelProvider` |
| 命令与激活 | `activate`（视图/标签页/8 个命令）、`deactivate`、`__internals` |

## 3. 链路 A：面板渲染

```
render(view)
 ├─ 若 activeTab 存在 → buildSuspendedHtml()（单活动视图让位）
 ├─ buildLoadingHtml()
 ├─ preparePanelHtml(isTab=false)
 │   ├─ ensureDshInstalled()        探测 dsh → 失败则 npx --no-install 兜底 → 询问并 npm i -g
 │   ├─ ensureDshPlugins()          写入 dsh web profile（见链路 D）
 │   ├─ ensureRunningOnce()         ensureRunning() 单飞去重
 │   │   ├─ checkUrl(url) 成功 → 复用
 │   │   └─ startDshAndWaitReady()  → startDshAndAwaitPort（60×500ms，401 也算）→ waitDshFullBoot（等 stdout `dsh web:` 行）
 │   ├─ registerWorkspace()         workspace/create，幂等，best-effort
 │   └─ resolvePanelTarget(isTab)   → 代理地址 / 直连地址 / { unauthorized:true }
 └─ buildIframeHtml(displayUrl, scale, fileLinkAction)
```

**失败分支**（对应 `buildErrorHtml` 文案与 `view.description`）：
`not-installed`（未安装）→ `unreachable`（未连接）→ `unauthorized`（等待认证，并触发 `maybeGuideAuth` 3 分钟冷却）
→ `unloadable`（地址协议非法/无法解析）。

**就绪判定**：端口可达 ≠ 就绪。必须等 stdout 打印 `dsh web: <url>`（新旧版本都打印）。
「从不打印的安静 dsh」会记忆 `globalState['dsh.quietBoot']`，之后不再等。

**单活动视图**：DSH 前端在 webview 双实例下退化为单例，因此标签页与侧边栏不能同时加载；
标签页接管时侧边栏只渲染占位页，标签页关闭后 `render(activeView)` 恢复。
标签页 URL 会把 `127.0.0.1` ↔ `localhost` 互换（`getTabDisplayUrl`），制造不同 origin。

## 4. 链路 B：受管认证代理

```
dsh web (新版) 启动 → stdout: "dsh web: http://127.0.0.1:3080/?token=<T>"
        │ attachDshOutputReader 逐行解析
        ▼
learnDshToken(T) → globalState['dsh.webAuth.tokenCache'] {target, token, ts}
        │
ensureAuthProxy() → createAuthProxy(target)
   监听 127.0.0.1:<随机端口>（0）
   cookies: Map<authority, 'name=value'>，exchanges: Map<authority, Promise>（并发去重）
   exchangeFor(authority): GET http://target/?token=T，Host 头 = authority
        → 期待 303 + Set-Cookie，取第一段 name=value
        → 按 authority 独立保存（127.0.0.1:P 与 localhost:P 各一份）
   forward(req): 剥离 hop-by-hop 头 → 注入 Host=authority、Cookie → 401 则重换重试一次
   onUpgrade: WebSocket 握手透传（注入 Host/Cookie），升级失败把状态原样回给客户端
   probeSelf()：请求代理自身首页，200 才算链路可用
   waitAuthed(ms)：等待 127.0.0.1 来源 Cookie 就绪
```

- `resolvePanelTarget()`：代理 + Cookie 就绪 → 代理地址（侧边栏 `http://127.0.0.1:P`，标签页 `http://localhost:P`）；
  代理不可用但直连探测到 401 → `{ unauthorized: true }`；其余直连。
- `apiBase()`：本扩展自身 RPC 也走代理（带认证）；否则用 `dshPanel.url`。
- **不启用代理的场景**：真 Remote（`vscode.env.remoteName` 存在且不是 `wsl`）或目标非回环地址。
  此时只做「引导可达」：`maybeGuideAuth` 给「在浏览器中打开（携带令牌）」与「粘贴认证链接」。
- 令牌缓存到 `globalState`，其它窗口 / 重载 VS Code 后静默复用（target 相同才用）。

## 5. 链路 C：Copilot 桥接

### 5.1 入口与模型信息

`registerDshModelProvider()` 注册 `vendor='dsh'` 的 provider，返回 `DSH_MODEL_DEFS`：

| 条目 id | 名称 | DSH 侧 |
| --- | --- | --- |
| `dsh` | DSH (DeepSeek Harness) | 跟随 `dshPanel.chatProvider/chatModel` 或 DSH 默认 |
| `dsh-deepseek-flash` | DeepSeek-V4.1-Flash (DSH) | `deepseek-official / deepseek-flash` |
| `dsh-deepseek-v4-pro` | DeepSeek-V4-Pro (DSH) | `deepseek-official / deepseek-v4-pro` |
| 历史 id（`dsh-deepseek-v4-flash`、`…-vision-exp`） | 不再展示 | 解析到 `deepseek-flash`，兼容老会话 |

上限 `maxInputTokens=1000000`、`maxOutputTokens=393216`（对齐 DSH 侧 `llm-deepseek` 配置）；
`capabilities: { toolCalling: true, imageInput: false }`（工具由 DSH 自己执行，VS Code 传入的 tools 一律忽略）；
`configurationSchema.reasoningEffort` 枚举 `none|low|high|max`（默认 high），映射到 DSH 的 `off|low|high|max`。

### 5.2 请求处理 `handleDshModelRequest`

```
1. 并行启动 locateModelChatSessionId()（聊天文件定位有落盘竞态，提前开始）
2. detectSyntheticRequest()：进度文案 / 标题生成 / 通用 JSON → 本地秒答，不建 DSH 会话
3. ensureDshInstalled() + ensureRunningOnce()：不可用 → progress.report('❌ …') 并返回
4. checkDshModelDrift()：每次扩展会话一次，读 session/modelCatalog 对比在册模型
5. serializeLmMessages()：清洗转录（见 5.4）
6. 调试落盘（dshPanel.debugModelMessages）：.dsh-debug/lm-messages-<ts>.json
7. 会话映射：chatKey = 'm-' + sessionId（落盘竞态兜底为 'm-' + 首问哈希）
8. 去重：同 chatKey + 同 lastUserText + 同附件签名 + 20s 内 pending/completed → replayDshAnswer()
9. 新建会话：session/create {cwd, agentPreset?}；续聊：找增量边界（5.5）
10. 模型/档位变更（selectionKey 不同）→ session/selectModel
11. 记录游标（session/page）→ session/prompt {mode:'queue', content:[{type:'text',text}]}
12. progress.report('⏳ 已提交…') → 每 1s 轮询 fetchSessionHistory → applyDshEvents
13. 结束：turn/end（reason.kind !== 'completed' 或本轮无正文 → ⚠️ 明确提示）/ 取消 / 超时
```

### 5.3 会话映射与找回

`globalState['dsh.modelSessions']`：`Map<chatKey, { dshSessionId, workspacePath, lastUserText, lastAttachSig, selection, pending, completed, lastUsedAt }>`。

- **定位聊天文件**：`locateModelChatSessionId()`。非首轮用「文件最后一条提问 == 转录里的上一个提问」
  认领（上一轮必已落盘，零竞态）；首轮取「最近 60 秒新建的空聊天文件」。
  扫描范围：`chatUserDataDirs()` × `workspaceStorage/<hash>/chatSessions` + `emptyWindowChatSessions`，
  当前工作区优先、mtime 倒序，取最近 12 个文件。读盘有 `mtime+size` 缓存（10s / 40 条上限）。
- **防串线**：命中条目后必须用「`entry.lastUserText` 仍出现在当前转录中」校验；
  首轮只允许 60s 内同题合并。
- **兜底找回**：键撞车/落盘延迟时，在同工作区、15 分钟内活跃的条目里找回（选转录中出现位置最靠后者）。

### 5.4 消息清洗（`lmMessageText` / `serializeLmMessages`）

| 输入（VS Code 注入） | 处理 |
| --- | --- |
| `system` / `tool` 角色 | 整条丢弃（DSH 有自己的 harness） |
| `You are an expert…`、`<instructions>`+`<skills>` | 丢弃 |
| `<userRequest>` / `<prompt>` 包裹 | 只取内部真实提问 |
| `<environment_info>` / `<workspace_info>` | 丢弃（DSH 有实时文件访问） |
| 其他垃圾块前缀（`<context>`、`<reminderInstructions>`…） | 剥前缀保留尾部真实内容 |
| `<userMemory>` / `<sessionMemory>` / `<repoMemory>` | 提取正文 → `【Copilot 记忆】` 块 |
| `<attachments>` / `<attachment>`（拖入文件） | 只透传**路径**为 `【文件引用】\n- …`，内容绝不透传 |
| 上一轮自己的 `⏳ 已提交…` 占位 | 剥离，避免回传给 DSH |
| 助手消息里的 `<system-reminder>` | 剥离 |
| 其它模型的回答（切走再切回） | 加 `【Copilot 其他模型回答】` 产地标签（可关：`markForeignAssistant`） |

序列化格式：用户 `用户：<提问>`、助手 `助手：<正文>`，块间空行。

### 5.5 增量边界

`findDshKnownBoundary()`：从末尾找最后一条带 `⏳` 产地标记的助手消息（主信号）；
没有标记时退化为「`entry.lastUserText` 对应的提问之后紧跟的助手消息」。
边界之后的内容 = 其它模型的问答（打标签）+ 当前提问，是 DSH 唯一缺失部分。
找不到边界 → 退化为「上次已发提问之后」；再找不到 → 全量（重复但正确）。

### 5.6 事件消费（`dshEventText` / `applyDshEvents`）

| 事件 | 处理 |
| --- | --- |
| `turn/start` | 标记 `started` |
| `turn/end` | 结束本轮，`data.reason` 决定正常/异常提示 |
| `assistant/message`（dsh 0.2.x） | 取 `data.message.content` 中 `type:'text'` 的 `text` 拼接；**每个 step 一条**，多条之间补空行 |
| `assistant/chunk` + `block-end`（dsh 0.1.x 历史回放） | 已 `emitted` 则跳过，否则整块回写 |
| `assistant/chunk` + `text-delta`（dsh 0.1.x 实时） | 增量回写 |

`seq` 必须为数字且大于 `lastSeq` 才处理（游标语义，实时轮询与 `replayDshAnswer` 共用）。
末尾无正文 → `⚠️ DSH 本轮没有产生可回写的正文（可能只执行了工具调用）`。

### 5.7 漂移自检

`checkDshModelDrift()`：DSH 可达时读 `session/modelCatalog`，用 `findMissingDshModels()` 比对
`DSH_MODEL_DEFS` 的非 `dsh` 条目；失配则 `showWarningMessage` 列出条目 → 模型与 DSH 在册模型。
每次扩展会话最多一次（`dshModelDriftChecked`），异常也置位（老版 dsh 无此端点）。

## 6. 链路 D：DSH 配套插件

profile 目录：`$DSH_HOME`（默认 `~/.dsh`）`/profiles/web`；插件写入
`node_modules/<plugin>`，并在 `package.json` 的 `dsh.profile.bundles` 登记（幂等，`ensureProfileDeclaration`）。

| 插件 | 来源 | 版本 | 作用 |
| --- | --- | --- | --- |
| `dsh-drop-caret` | npm（`dsh plugin add` 优先，失败 `npm pack` 解压兜底） | ≥ 0.2.3 | 拖文件 / 选中内容插入对话框光标处 |
| `dsh-webview-clipboard` | `clipboardPluginFiles()` 以源码字符串生成 | 0.2.1 | macOS 内嵌 iframe 下 ⌘C/⌘V/⌘X 失效修复（execCommand） |
| `dsh-vscode-file-links` | `dsh-plugins/` 真实文件随扩展分发 | 见插件 `package.json` | 工作区文件/文件夹链接改在 VS Code 资源管理器定位/打开 |

任一插件新增/升级后：若 dsh 在运行，提示「请点击重启 dsh web 使其生效」。

**文件链接消息协议**（三方必须一致）：

```
插件 → webview：{ source:'dsh-vscode-file-links', type:'hello' | 'reveal', token, path }
webview → 插件：{ source:'dsh-vscode-host', type:'ack', fileLinks:true, mode } | { type:'reveal-result', token, ok }
webview → 宿主：{ type:'dsh-reveal-path', token, path }
宿主 → webview：{ type:'dsh-reveal-result', token, ok }
```

- webview 侧校验 `event.origin === FRAME_ORIGIN` 且 `event.source` 为自身 iframe（允许 `null`）。
- 宿主侧 `resolveWorkspaceTarget()`：规范化 → 去行号（`:12` / `#L12`）→ 相对路径对每个工作区文件夹
  生成候选 → 必须 `isInsideFolder` 且 `stat` 成功；绝对路径同样要求在工作区内。
- 成功才回执 `ok:true`；失败回执 `ok:false`，插件 2.5s 内未收到回执也会回放原始点击。

## 7. 状态与持久化

| 位置 | 键 | 内容 | 失效策略 |
| --- | --- | --- | --- |
| `globalState` | `dsh.modelSessions` | Copilot 聊天 → DSH 会话映射 | 15 分钟不活跃忽略；命令可重置 |
| `globalState` | `dsh.webAuth.tokenCache` | `{ target, token, ts }` | target 不同则不用；仅本机内存 + globalState |
| `globalState` | `dsh.authCapable` | dsh 是否支持 web 认证 | 老版确认后置 false，跳过等待逻辑 |
| `globalState` | `dsh.quietBoot` | 从不打印启动行的 dsh | 置 true 后不再等待启动行 |
| 内存 | `authProxy` / `authProxyPromise` | 代理句柄与并发去重 | `deactivate` 关闭 |
| 内存 | `dshInvocation` / `dshInvocationAt` | dsh/npx 启动方式（15 分钟缓存） | 超时重探 |
| 内存 | `chatFileReadCache` | 会话文件解析缓存 | mtime+size 变化或 10s 过期，上限 40 |
| 工作区 | `.dsh-debug/` | 调试落盘（仅 `debugModelMessages` 开启时） | 用户自行清理；已在 `.gitignore` |
| HOME | `~/.dsh-debug/provider-info.json`、`models-diagnose.json` | 模型注册表诊断 | 诊断命令产物 |

## 8. DSH 契约清单（改这里必须双版本兼容）

| 项 | 新版 | 旧版回退 |
| --- | --- | --- |
| RPC 端点 | `/api/workspace/create` 等斜杠 | `/api/workspace.create`（404 或 `raw==='not found'` 时回退） |
| RPC 信封 | `{type:'client-request', rpcId, method, payload:{args:{request:<业务参数>}}}` | `payload` 直接是业务参数 |
| 历史 | `session/page {address:{kind:'session',sessionId}, throughSeq, maxMessages}`；`throughSeq` 越界报 `past cursor N` | `session/history {sessionId}` |
| 事件 | `assistant/message`（`data.message.content[].text`） | `assistant/chunk`（`text-delta` / `block-end`） |
| 启动 | `dsh web --host … --port … [--no-open]` | `--no-open` 先 `dsh web --help` 探测；误判时去参重试一次 |
| 认证 | stdout `dsh web: …?token=…`，token → 签名 Cookie（SameSite=Strict，绑定 Host） | 无认证时首页 200，代理不介入 |
| 模型 | `session/modelCatalog`（`groups[].models[]`）、`session/selectModel {sessionId, provider, model, reasoningEffort?}` | 端点不存在时自检静默置位，映射照旧 |

## 9. 已知限制与技术债（改动时不要假装它们不存在）

1. **双实例单例**：DSH 前端在 webview 双实例下互斥 → 单活动视图策略（非本扩展能根治）。
2. **文件链接行号不定位**：`src/a.ts#L12` 的 `#L12` 只用于路径解析，打开的编辑器停在第 1 行。
3. **桥接只转发文本**：`imageInput: false`；DeepSeek 多模态能力未透传。
4. **真 Remote 无代理**：认证只能在 dsh 所在机器的浏览器完成一次，或粘贴认证链接。
5. **`engines` 与桥接能力不一致**：`engines.vscode` 为 `^1.75.0`，但桥接依赖较新的
   `vscode.lm.registerLanguageModelChatProvider`；旧版 VS Code 上桥接不可用，目前只有
   `console.warn`（用户不可见）——与宪法第三条冲突，已登记为候选规格 `002`。
6. **`freePort` 会杀端口占用进程**：仅「重启」且用户确认后调用；不要把它挪到自动路径。
