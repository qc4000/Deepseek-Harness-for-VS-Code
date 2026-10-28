# 技术方案 005：点击对话里的文件链接时展示变更（轮级 diff）

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：approved） |
| 负责人 | @Vithrive |
| 更新 | 2026-10-26 |

## 1. 方案概述

三级取数、两级渲染：能拿到轮级全文就开「轮开始 ↔ 轮结束」的 diff；拿不到就开
「`HEAD` ↔ 工作树」；再拿不到就退回 1.1.x 的普通打开。轮级全文只能从 DSH 进程内存拿到，
因此新增一个**只做数据出口的 DSH 宿主插件**（无客户端半区、无 UI），扩展宿主经现有 authProxy
（带 Cookie）取两侧文本，用虚拟文档 + `vscode.diff` 渲染。客户端插件只负责把「会话 + 轮」
坐标捎上，不搬运正文。

```
点击 → client.js（取 sessionId/turn + ack.diff）→ 中继脚本 → extension.js
  ├ reveal-ack（立即回执，把客户端等待从 2.5s 延长到 6s）
  ├ GET /api/dsh-vscode.changes-file?sessionId&turn&path   ← 新插件（authProxy 带 Cookie）
  │    └ workspaceChanges.records.get(seq).sources[i] → 副本文件 / git cat-file blob
  │        命中文本 → vscode.diff(虚拟文档 before, 虚拟文档 after, "名称 · 第 N 轮")
  ├ 未命中/404/超大/二进制 → P0：git show HEAD:<rel> → vscode.diff(…, 当前文件, "… · 与 HEAD 的差异")
  └ 仍不行 → vscode.open（1.1.x 行为）
```

## 2. 影响面

| 文件 / 函数 | 改动性质 | 触碰安全数据流 | 对应 AC |
| --- | --- | --- | --- |
| `dsh-plugins/dsh-vscode-changes/`（新包：`package.json` / `cordis.patch.yml` / `lib/index.js`） | 新增 | 子进程（`git cat-file`）、文件读、鉴权路由 | AC-1/2/6/9/10 |
| `extension.js` `revealWorkspaceTarget()` → `openFileOrDiff()` | 修改 | webview 消息、子进程（`git`）、路径 | AC-1~8/12 |
| `extension.js` 新增 `dsh-diff` 虚拟文档 provider / `fetchTurnChange()` / `gitHeadBlob()` | 新增 | 子进程、文件读 | AC-4/5/12 |
| `extension.js` `buildIframeHtml()` 中继脚本（`reveal` 字段透传、`reveal-ack` 回传） | 修改 | webview 消息 | AC-7/11 |
| `extension.js` `installBuiltinPlugins()` 等（安装/版本比对新插件） | 修改 | 文件写入 profile | AC-4/8 |
| `dsh-plugins/dsh-vscode-file-links/lib/client.js`（`ack.diff`、坐标、超时） | 修改 | 否 | AC-7/11 |
| `package.json`（`workspaceFileLinkAction` 增 `diffAndOpen`） | 修改 | 否 | AC-8 |
| `test/file-link-diff.test.js`（新）、`test/dsh-changes-plugin.test.js`（新） | 新增 | — | AC-1~12 |
| `test/workspace-file-link.test.js`、`test/file-link-client-sim.test.js` | 修改 | — | AC-7/8/11 |
| `README.md` / `CHANGELOG.md` / `docs/TESTING.md` | 更新 | — | — |

## 3. 契约变更与兼容

| 契约 | 新形态 | 旧形态 / 回退 | 探测方式 |
| --- | --- | --- | --- |
| 插件消息（页面 → 宿主） | `reveal` 增可选 `change:{sessionId,turn}` | 只有 `{token,path}` | 宿主字段类型校验；缺省走 P0 |
| 宿主消息（宿主 → 页面） | `ack` 增 `diff?:true`；新增 `reveal-ack` | 无这两字段 | 老宿主不发 → 客户端不带坐标、维持 2.5 s |
| DSH 路由（新） | `GET /api/dsh-vscode.changes-file` | 无（老插件不注册） | 404 → P0 |
| DSH 服务 | `ctx.workspaceChanges.records` / `sources[].repository.workspace.env` | 无（旧 dsh 无该服务） | `typeof records?.get === 'function'`；结构不符即 404 |
| 配置项 | `workspaceFileLinkAction=diffAndOpen` | 其余四个旧值不变 | 非法值回退 `revealAndOpen` |
| VS Code API | `registerTextDocumentContentProvider` + `vscode.diff` | 1.75 起均可用 | 不存在则不注册 → 直接 L0 |

> 无回退项：本规格不存在「没有回退」的契约；三层降级链即回退本身。

## 4. 状态与并发

| 状态 | 位置（内存 / globalState） | 谁置位 | 谁清理 | 失效策略 |
| --- | --- | --- | --- | --- |
| 虚拟文档内容 | 内存 Map（`dsh-diff:` URI → 文本） | `openDiff()` | provider dispose / LRU（≤64 条、≤8 MiB） | 超限最旧淘汰 |
| 轮索引 `sessionId → turn → seq` | 新插件内存 Map | 插件监听 `session/event` 的 `workspace/changes` | 插件 dispose / 会话结束事件 | 同 `turn` 取最新 `seq` |
| 单次点击的进行中请求 | 客户端 `pending[token]` + 宿主无状态 | 客户端 | 回执 / 6 s 超时 | 超时回放点击 |

并发去重：宿主侧对同一 `(sessionId,turn,path)` 用 `Map<key,Promise>` 单飞，连续点击复用同一次
取数；虚拟文档先写后开，避免 `vscode.diff` 读到空内容（provider 同步返回已写入的文本）。

## 5. 安全审查

- [x] 进 `spawn` 的值：`git` 命令走既有 `sanitizeCommand`（win32 `shell:true` / POSIX 无 shell），
      仓库相对路径由 `path.relative` 生成并拒绝 `..` 开头；新插件里 `git cat-file` 用 `execFile`
- [x] webview CSP 未放宽；无新插值；`reveal` 新字段按类型/长度截断（`sessionId` ≤128、
      `turn` 正整数 ≤ 1e6）
- [x] `postMessage` 仍校验 `source` + `fromOurFrame()`；`reveal-ack` 只回给发起帧
- [x] 文件访问：P0 只读工作区内且 `stat` 成功的文件；新路由只按 `(sessionId,turn,path)`
      在**已记录清单**里匹配，不接受任意路径，单侧 ≤1 MiB
- [x] token/Cookie 不进日志；authProxy 的 `cookies` 只在内存
- [x] 新路由输入进 `test/dsh-changes-plugin.test.js`（缺参/越界/不匹配/超限）

## 6. 测试策略（先红后绿）

| 层 | 套件 | 要加的断言（映射 AC） |
| --- | --- | --- |
| L1 纯函数 | `test/file-link-diff.test.js` | 标题生成（AC-12）、路径归一化与匹配候选（AC-9）、`hasNulByte`/体积上限（AC-6）、`turn` 取最新 `seq`（AC-1）、`change` 字段校验与截断（AC-7） |
| L1 插件路由 | `test/dsh-changes-plugin.test.js` | 假 ctx（`workspaceChanges.records` + `connection.fetch` + 假 fs/git）：file/snapshot/absent/binary/oversized 五个分支、结构探测失败 404（AC-10）、参数校验（AC-9）、同轮多次编辑只一条（AC-1）、跨轮各自独立（AC-2） |
| L2 协议/桥 | `test/file-link-bridge.test.js`、`test/workspace-file-link.test.js` | `change` 透传与截断、`reveal-ack` 回传、`diffAndOpen` 三级降级顺序（AC-4/5）、`off`/`revealOnly` 不变（AC-8）、安装幂等且不写 `dependencies` |
| L3 仿真 | `test/file-link-client-sim.test.js` | `ack.diff` 后带坐标、无坐标不带（AC-7）、`reveal-ack` 延长至 6 s、6 s 后回放且不双开（AC-11） |
| L4 e2e | `test/e2e-real-dsh.test.js` | 真实 dsh 上确认新路由 404 时的降级（AC-10/13） |

- 必跑：`npm test`；涉及 dsh 契约：`npm run test:all`。
- 手验：F5（Linux 本地 + dsh 0.2.1-rc.2）跑一次含 3 次编辑同一文件的真实轮 → 点链接看
  轮级 diff；重启 dsh web 后再点 → 看 P0 标题与提示。

## 7. 实施步骤

1. 基础设施：`package.json` 加枚举值；`extension.js` 常量（`MAX_DIFF_SIDE_BYTES=1<<20`、
   `DIFF_TIMEOUT_MS=6000`）与 `__internals` 导出；`test/file-link-diff.test.js` 骨架。
2. 新插件：包骨架（`package.json` / `cordis.patch.yml` / `lib/index.js`）→ 轮索引 →
   路由与五个内容分支 → `test/dsh-changes-plugin.test.js`。
3. 宿主取数：`fetchTurnChange()`（经 authProxy）→ `gitHeadBlob()` / `hasUncommittedChange()` →
   `openFileOrDiff()` 三级降级 → 虚拟文档 provider + `vscode.diff`。
4. 协议与客户端：中继脚本透传 `change`、回 `reveal-ack`；`client.js` 取坐标 + `ack.diff` + 超时。
5. 安装与配置：`diffAndOpen` 时安装/更新新插件（不写 `dependencies`）；其它模式维持原规则。
6. 文档与发布：README 配置表 + CHANGELOG + 测试地图 + spec 验证记录；版本号改动前请示维护者。

## 8. 回退方案

| 层级 | 手段 | 触发条件 |
| --- | --- | --- |
| 功能 | `workspaceFileLinkAction=revealAndOpen`（默认值即是） | 用户不想要 diff |
| 轮级 | 不安装/禁用 `dsh-vscode-changes`，自动只剩 P0 | 插件与 DSH 失配 |
| 代码 | 保留 1.1.x 的 `vscode.open` 分支为最末级 | P1/P0 都失败 |
| 发布 | 补丁版回退（Marketplace 不可降级） | 线上故障 |

## 9. 被否方案与原因

| 方案 | 否决原因 |
| --- | --- |
| 用 `/api/changes.diff` 的 hunk 反推「改前」全文 | hunk 只有 3 行上下文，历史轮的 after 拿不到，行号对不上，会渲染出错误的 diff |
| 客户端 fetch `/api/changes.*` 再回传正文 | 正文可达 2 MiB × 2，跨 iframe 搬大对象；且仍拿不到整文件 |
| 扩展自己盯文件变化做快照 | 改动发生在 DSH 进程内，宿主拿不到「改之前」的内容 |
| 读 DSH 会话日志（zstd JSONL）反演编辑 | 依赖 `zlib.zstdDecompress` 的 Node 版本、日志格式易变，收益低 |
| 依赖 `dsh-git-rollback` 检查点作为首选 | 第三方插件、只覆盖 git 仓库；留作 P2 |
| 每次编辑粒度 | DSH 不存轮内中间态，需要全部走日志反演 |

## 10. 开放问题

- 若 `records` / `sources` 结构在实现时与当前 DSH 版本不符（探测不到），则 P1 直接不启用，
  只上 P0，spec 状态与 AC 相应收敛（AC-1/2/10 记为「不适用」并在验证记录里写明）。
- 若真实 web 轮不产生 `workspace/changes` 事件（本机抽查未见），同上：先只上 P0，
  另开缺陷规格追 DSH 侧记录条件。
- 1 MiB 上限是否改为配置项：等实机使用反馈再定，本期常量集中一处便于后续外露。
