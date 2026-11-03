# 方案 013：拿不到点击所属轮时不再跨轮展示变更

## 1. 影响面

| 文件 | 改动 |
| --- | --- |
| `dsh-plugins/dsh-vscode-file-links/lib/client.js` | `coordsOf()`：轮次取不到 → `return null`（只发 `{path, cwd}`，不再发 `change={sessionId, latest:true}`）；`PLUGIN_VERSION 0.2.7 → 0.2.8` |
| `dsh-plugins/dsh-vscode-file-links/package.json` | `version 0.2.7 → 0.2.8`（版本单一源头，宿主比对后覆盖安装） |
| `dsh-plugins/dsh-vscode-changes/lib/index.js` | 路由删除 `turn=latest` 分支与 `latestTurnOf()`：`turn` 必须正整数否则 400；`0.2.6 → 0.2.7` |
| `dsh-plugins/dsh-vscode-changes/package.json` | `version 0.2.6 → 0.2.7` |
| `extension.js` | 中继只透传具体轮次（丢弃 `change.latest`）；`sanitizeChangeCoord` 拒绝 `latest`；`fetchTurnChange` 不再拼 `turn=latest`；`parseTurnChangeResponse` 去掉 `latest` 字段；删除 `notifyLatestHit()`；`notifyDiffFallback(reason)` 去掉 `latest` 参数；`openOutOfWorkspaceDiff` 坐标尝试链退成单坐标（只按写法重试） |
| `test/*` | 4 套件按新语义先改断言（见第 3 节），既有断言只减不增的部分限于 latest 专属项 |
| `README.md` / `docs/ARCHITECTURE.md` / `docs/TESTING.md` / `CHANGELOG.md` | 行为说明、消息协议、测试地图、发布条目 |
| `docs/sdd/specs/011-*/spec.md` | AC-4 / AC-5 / AC-7 标注「已被 013 取代」，变更历史补一行（cwd 部分不受影响） |

## 2. 关键设计

### 2.1 「轮坐标」回到单一语义：具体轮次

```
客户端：有 session + 有 data-chat-turn  → change = {sessionId, turn}      （005 AC-1/2 不变）
        有 session + 无轮标记           → 不带 change（005 AC-7 / 013 AC-1）
中继  ：只透传正整数 turn；`change.latest === true` 直接丢（013 AC-4，旧插件 0.2.7 过渡期）
宿主  ：sanitizeChangeCoord 只认 {sessionId, turn}；{latest:true} → null（按无坐标降级）
路由  ：turn 必须正整数 → 否则 400（`turn=latest` 出口移除，013 AC-5）
```

### 2.2 降级链恢复为 005 的三级

```
点击所属轮已知 → P1（该轮两侧全文）→ 命中：标题「名称 · 第 N 轮」（只可能是点击所属轮）
点击所属轮未知 → 不查 P1 → P0（HEAD ↔ 工作树，标题「与 HEAD 的差异」）→ L0（普通打开）
P1 该轮无记录/无全文/无该文件 → 不再换轮重查 → P0 → L0（005 AC-3/AC-4 文案不变）
工作区外：无坐标 → no-coord → DSH 侧栏（012 开关另计）；有坐标 → 只按写法重试，不换轮
```

### 2.3 过渡期兼容（新宿主 × 旧页面插件）

`dsh web` 未重启时页面里仍是 0.2.7 插件，会继续发 `latest`。三层各自兜住：

1. 中继丢弃 → 宿主收到的 `reveal` 无 `change` → 走 2.2 的「未知轮」分支；
2. 即使中继漏网，`sanitizeChangeCoord({latest:true}) === null` → 同样分支；
3. 路由侧 `turn=latest → 400`，旧宿主（1.0.7）拿到 400 按 `error` 退 P0——不产生错觉，
   且插件随扩展同包分发，实际到不了这一层。

## 3. 测试策略（先红后绿）

| 套件 | 先改的断言（红） | 后实现（绿） |
| --- | --- | --- |
| `file-link-client-sim` | 无轮标记 → `reveal.change === undefined`（原：`latest===true`）；全无标记 → 不带坐标（原：走 latest） | `coordsOf()` 返回 null |
| `workspace-file-link` | 中继脚本**不含** `change.latest === true`、仍含具体轮次透传 | 中继删 latest 分支 |
| `file-link-diff` | `sanitizeChangeCoord({latest:true}) === null`；`openDiffFor`/`openOutOfWorkspaceDiff` 对 latest 坐标零查询、不换轮、不开别的轮 diff；具体轮次命中/降级断言保持 | 宿主删 latest 通路 + `notifyLatestHit` |
| `dsh-changes-plugin` | `turn=latest → 400`（含未知会话）；具体轮次仍出数（含自捕获兜底） | 路由删 `latestTurnOf` |

既有断言不减少：005/010/012/001 的降级、边界、提示文案全部保持。

## 4. 契约与回退

- `change` 字段形状不变（`{sessionId, turn}`），只是 `latest` 这一取值被三层拒绝——协议向后兼容，
  不需要改 `dsh-vscode-file-links/AGENTS.md` 的协议表（那里本来就只写了 `{sessionId, turn}`）。
- 回退方案：本规格整体回退即恢复 011 的 `latest` 行为（`git revert` 013 的实现提交即可）；
  插件版本号会随回退一并回到 0.2.7 / 0.2.6，宿主比对后自动覆盖安装。
- 风险最高处：`dsh-changes-plugin` 删除 `turn=latest` 会让「旧宿主 + 新插件」拿 400——按 2.3 第 3 条
  退 P0，仍可见、不误导。

## 5. 验证

1. `npm run test:one -- file-link`（client-sim / diff / workspace-file-link）→ 先红后绿；
2. `npm run test:one -- dsh-changes-plugin` → 先红后绿；
3. `npm test` 全量（语法检查 + 全部离线套件）；
4. 涉及 dsh 契约（路由删字段）→ `npm run test:all`（真实 dsh e2e）；
5. 实机 F5：老会话续问后点先前轮次链接 → 打开文件/HEAD 对比，标题不得是「第 N 轮」。
