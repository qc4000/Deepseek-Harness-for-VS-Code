# 方案 011：相对路径按 DSH 工作区解析 + 老会话链接仍可看变更

## 1. 影响面

| 文件 | 改动 |
| --- | --- |
| `dsh-plugins/dsh-vscode-file-links/lib/client.js` | 新增 `currentSessionCwd()`（与 `dsh-vscode-workspace` 同源读 `sessions.list` 的 `cwd`）；点击时随 `path` 一起上报 `cwd`；无轮标记时改发 `change={sessionId, latest:true}`；新增诊断环形日志 `__dshVscodeFileLinks.log()/.clear()/.cwd()`；`0.2.5 → 0.2.6` |
| `dsh-plugins/dsh-vscode-changes/lib/index.js` | 路由接受 `turn=latest`：在该会话「已记录」的轮里找该文件最后一次改动，回包带实际 `turn` 与 `latest:true`；`0.2.4 → 0.2.5` |
| `extension.js` | 中继透传 `cwd` 与 `change.latest`；`candidateLinkUris`/`resolveWorkspaceTarget` 支持 cwd 基准；`sanitizeChangeCoord`/`fetchTurnChange` 支持 latest；新增 `absoluteFromCwd()`；`openOutOfWorkspaceDiff()` 改为「写法 × 坐标」尝试链；新增 `notifyLatestHit()` |
| `test/*` | 4 套件补断言（见第 3 节），既有断言只按新语义调整（「无轮标记不带坐标」→「无轮标记改带 latest」） |
| `README.md` / `docs/ARCHITECTURE.md` / `docs/TESTING.md` / `CHANGELOG.md` | 行为说明、消息协议、断言数、发布条目 |

## 2. 关键设计

### 2.1 相对路径的基准：DSH 会话 cwd

```
客户端点击 → 读 sessions.list 里主视图会话的 cwd（uiSession.current 优先，retainedBy.mainView 兜底）
          → postMessage { path, cwd, change? }
中继      → 透传 cwd（长度截断；宿主再校验形状）
宿主      → candidateLinkUris(clened, folders, cwd)：给了合法 cwd 时**只**产出 cwd 候选
          → 仍要求 isInsideFolder + stat 成功（001 的安全边界不变）
```

- 没 cwd（老 dsh / 会话未就绪）→ 退回旧的多根猜测，不报错。
- cwd 非法（相对路径、超长、控制字符）→ 同样退回旧解析。

### 2.2 没有轮坐标时的 latest 兜底

```
客户端：有 session + 无 data-chat-turn  → change = {sessionId, latest:true}
路由  ：turn=latest → latestTurnOf() 从大到小扫 seqByTurn，用 summary.files 匹配
        → 命中：{matched:true, turn:<实际>, latest:true, before, after}
        → 未命中：{matched:false, latest:true}
宿主  ：openOutOfWorkspaceDiff 的尝试链
        写法 [原文 → 去行号 → cwd 绝对化] × 坐标 [点击所属轮 → latest]
        只有 no-change 才继续换下一组；其它原因（unavailable/released/timeout）直接收工
        命中且 latest=true → notifyLatestHit(实际轮, 点击所属轮)
```

- 仍然只在**已记录清单**里匹配，不按请求路径读盘（宪法第五条）。
- `notifyLatestHit` 区分两种文案：`该链接没有轮次信息…` / `第 N 轮没有它的变更…`。

### 2.3 诊断

- 客户端环形日志（≤ 20 条）记录 `{path, cwd, change, result}`，`result ∈ pending|accepted|ok|failed|timeout`。
- 失败原因仍由宿主侧中文状态栏文案区分（无坐标 / 该轮无记录 / 未重启 / 二进制 / 超时…）。

## 3. 测试策略（先红后绿）

| 套件 | 新增覆盖 |
| --- | --- |
| `dsh-changes-plugin.test.js` | `turn=latest` 命中最新改动、没改过的文件 `matched:false`、未知会话 404、缺 turn 非 latest 400、latest 仍要求 path |
| `file-link-diff.test.js` | `sanitizeChangeCoord` 接受 latest；`absoluteFromCwd`；latest 坐标直达；指定轮无变更→自动 latest 并提示；相对路径额外给 cwd 绝对候选；不可用不重试 |
| `file-link-client-sim.test.js` | 无轮标记改发 latest；cwd 上报与缺失；诊断日志记录/结果/清空 |
| `workspace-file-link.test.js` | cwd 指向别处时不按 VS Code 根解析；cwd 为空/非法退回旧解析；中继透传 `cwd` 与 `latest` |

## 4. 发布

- 两个插件版本号提升（客户端 0.2.6 / 宿主半边 0.2.5）：`ensure*Plugin` 会比较版本并覆盖安装。
- 目标版本仍是 `1.0.7`；`package.json` 版本号与 tag 由维护者确认后再改。
