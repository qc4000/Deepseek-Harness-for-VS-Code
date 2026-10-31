# 方案 010：工作区外文件链接也能在 VS Code 里看变更

## 1. 影响面

| 文件 | 改动 |
| --- | --- |
| `extension.js` | 新增 `openOutOfWorkspaceDiff()` / `notifyOutOfWorkspaceLink()`；`revealWorkspaceTarget()` 在「目标解析失败」分支先尝试轮级 diff；抽出 `stripLinkLineSuffix()` 供两处复用；`__internals` 导出新函数 |
| `dsh-plugins/dsh-vscode-changes/lib/index.js` | `changeCandidates()` 增加「折叠 `..`/`.` 后的绝对路径」候选；插件版本 `0.2.3` → `0.2.4`（改了代码就要能覆盖安装） |
| `dsh-plugins/dsh-vscode-changes/package.json` | 版本号 + 描述补一句「工作区外文件也按记录匹配」 |
| `test/file-link-diff.test.js` | 新增 `[6] 工作区外链接` 断言组（纯函数 + 消息链路） |
| `test/dsh-changes-plugin.test.js` | 新增 `changeCandidates` 折叠断言 |
| `README.md` / `docs/ARCHITECTURE.md` / `docs/TESTING.md` / `CHANGELOG.md` | 行为说明、链路说明、断言数、发布条目 |

**不动**：`dsh-vscode-file-links`（客户端协议不变）、配置项、`revealAndOpen` / `revealOnly`
的既有边界、`.vscodeignore`（无新目录）。

## 2. 关键设计

### 2.1 位置：只补在「解析失败」分支

```
revealWorkspaceTarget(msg)
  ├─ resolveWorkspaceTarget(msg.path) 命中 → 原三级链路（P1 → P0 → L0），一行不改
  └─ 未命中（工作区外 / 文件已删除 / 无工作区）
       ├─ diffAndOpen → openOutOfWorkspaceDiff(msg.path, msg.change)
       │     ├─ 命中 → 打开虚拟文档 diff，回执 ok:true（不 revealInExplorer）
       │     └─ 未命中 → 回执 ok:false + 状态栏原因与出路
       └─ 其它模式 → 回执 ok:false + 状态栏原因（含「改成 diffAndOpen」出路）
```

这样「工作区内」这条主路径完全零改动，005 的三级降级回归断言不受影响（AC-7）。

### 2.2 数据流与安全边界

- 只请求 `dsh-vscode-changes` 的既有路由（`CHANGES_ROUTE`），参数是
  `sessionId + turn + path`（路径是链接原文，不是拼出来的绝对路径）。
- 不调用 `resolveWorkspaceTarget` 之外的任何文件系统 API：即不 `stat`、不 `readFile`、
  不跑 git（P0 只属于工作区内分支）。
- 路由侧仍然只按 `summary.files` 的已记录清单匹配，`pickCapture` 只从自己捕获的记录里取，
  绝不按请求路径读盘——所以「放开点击」不等于「放开读盘」。

### 2.3 路径写法收敛

- `openOutOfWorkspaceDiff()` 先用 `normalizeLinkPath()`（去引号/空白、`\`→`/`、去 `./`）
  净化，再做 001 同款校验（非空、≤ 4096、无控制字符）。
- 行号后缀：先按原文请求；仅当返回 `no-change`（清单里没有）时去掉 `:12` / `#L12` 再试一次，
  最多两次请求（避免对每种写法都打一次路由）。
- 插件侧 `changeCandidates()` 新增 `posix.normalize(abs)`：`/w/proj/../other/a.ts` →
  `/w/other/a.ts`。工作区外文件的链接常见 `../x` 写法，记录的 `path` 可能是绝对路径，
  不折叠 `..` 就匹配不到。

### 2.4 契约与回退

- 客户端 `change` 坐标缺失（老客户端 / 取不到会话）→ 不发请求、直接回落侧栏，行为同 1.0.6。
- 旧插件（0.2.3 及以前）仍然能响应原文写法；只是 `../x` 类写法匹配率低 → 走回落，不报错。
- 插件升级后 `ensureChangesPlugin()` 版本不同 → 写盘并提示重启 dsh web（既有机制）。

## 3. 测试策略（先红后绿）

| 断言组 | 覆盖 AC |
| --- | --- |
| `openOutOfWorkspaceDiff` 命中：`vscode.diff`、标题含「第 N 轮」、左右取自记录 | AC-1 |
| 命中时 `revealInExplorer` / `readGitHeadBaseline` / `stat` 均未被调用 | AC-1、AC-5 |
| `no-change` → 去行号后缀重试；两次请求后成功 | AC-3 |
| 无坐标 / 非法坐标 → 不请求、回执 false、提示含「无法确定」 | AC-4 |
| `unavailable` / `released` / `no-text` / `binary` / `oversized` / 超时 → false + 定向文案 | AC-5、AC-8（表格） |
| 消息链路：`diffAndOpen` + 工作区外路径 → 一次 `ok:true`、无 `revealInExplorer` | AC-1、AC-2 |
| `revealAndOpen` + 工作区外路径 → `ok:false`、不请求轮级、提示含 `diffAndOpen` 出路 | AC-6 |
| `changeCandidates('/w/proj', '../other/a.ts')` 含 `/w/other/a.ts` | AC-8 |
| 既有 `[3]`/`[5]` 断言全部保留 | AC-7 |

新增断言都进既有套件（不新建文件），`docs/TESTING.md` 只更新断言数与覆盖描述。

## 4. 发布

- 目标版本 `1.0.7`（含此前 Windows 反斜杠路径修复）。
- `CHANGELOG.md` 顶部新增 `1.0.7` 小节；`package.json` 版本号与 tag 由维护者确认后再改。
