# 任务清单 005：点击对话里的文件链接时展示变更（轮级 diff）

> 用法：任务按「先红后绿」排序；每完成一项把 `[ ]` 改成 `[x]` 并在 PR 里贴 `npm test` 结果。
> 粒度：单项 ≤ 半个工作日。`[P]` 表示与相邻任务无依赖、可并行。`[test]` 必须先于对应 `[impl]` 合入。

## 阶段 0 · 准备（基础设施）

- [ ] `[impl]` `package.json` 的 `dshPanel.workspaceFileLinkAction` 增 `diffAndOpen`（含 `enumDescriptions`，默认值保持 `revealAndOpen`） —— 判据：非法值仍回退默认
- [ ] `[impl]` `extension.js` 常量与 `__internals` 导出：`MAX_DIFF_SIDE_BYTES`、`DIFF_TIMEOUT_MS`、`buildDiffTitle()`、`hasNulByte()`、`normalizeChangeCandidates()`、`pickLatestSeq()` —— 判据：测试可直接取到
- [ ] `[test]` 新建 `test/file-link-diff.test.js` 骨架（vscode 桩 + `ok()` 计数） —— 判据：`node test/file-link-diff.test.js` 能跑到第一断言
- [ ] `[test]` 新建 `test/dsh-changes-plugin.test.js` 骨架（假 ctx + 假 fs/git） —— 判据：同上

## 阶段 1 · 新插件（轮级数据出口）

- [ ] `[impl]` `dsh-plugins/dsh-vscode-changes/` 包骨架（`package.json` / `cordis.patch.yml` / `lib/index.js`），`inject: ['workspaceChanges','connection']` —— 判据：`node --check` 通过、`cordis.patch.yml` 的 `name` 与包名一致
- [ ] `[test]` 结构探测：`records` 缺失 / 非 Map / `sources` 形状不符 → 404（AC-10） —— 判据：红
- [ ] `[impl]` 轮索引（监听 `session/event` 的 `workspace/changes`，`sessionId → turn → 最新 seq`） —— 判据：绿
- [ ] `[test]` 参数校验：缺 `sessionId`/`turn`/`path`、`turn` 非正整数、路径不匹配 → 400 或 `{matched:false}`（AC-9） —— 判据：红
- [ ] `[impl]` 路由 `GET /api/dsh-vscode.changes-file` 与匹配逻辑（`path` / `display` / `resolve(cwd,p)` 三种候选归一） —— 判据：绿
- [ ] `[test]` 五个内容分支：`file`（读副本）/ `snapshot`（假 `git cat-file`）/ `absent` / `refusal:"binary"` / `oversized`（AC-1/2/6） —— 判据：红
- [ ] `[impl]` `sources` 读取实现（`execFile('git', ['cat-file','blob',…], {env: workspace.env})`，tree 校验 40 位十六进制） —— 判据：绿
- [ ] `[test]` 同轮多次编辑只一条、跨轮各自独立（用两条 `workspace/changes` 记录构造）（AC-1/2） —— 判据：绿
- [ ] `[impl]` 单侧 ≤1 MiB 上限与超限标记 —— 判据：上限用例绿

## 阶段 2 · 扩展宿主取数与渲染

- [ ] `[test]` `openFileOrDiff()` 三级降级顺序：P1 命中 → P0 → L0（AC-4/5） —— 判据：红
- [ ] `[impl]` `fetchTurnChange()`（经 authProxy 带 Cookie，超时 1.5 s）+ 单飞 `Map<key,Promise>` —— 判据：绿
- [ ] `[impl]` `dsh-diff` 虚拟文档 provider（Map + LRU ≤64 条/8 MiB），注册/注销随扩展激活 —— 判据：内容读回一致
- [ ] `[test]` 标题规则与 `preview:false`（AC-12） —— 判据：红→绿
- [ ] `[test]` P0：`git show HEAD:<rel>`、未跟踪文件（空左侧）、无未提交改动、非 git、git 缺失（AC-5） —— 判据：红→绿
- [ ] `[impl]` `gitHeadBlob()` / `hasUncommittedChange()`（`sanitizeCommand`、POSIX 无 shell、拒绝 `..`） —— 判据：绿
- [ ] `[test]` 二进制 / 超大 / 本轮未改 → L0 + 状态栏中文提示（AC-3/6） —— 判据：红→绿
- [ ] `[impl]` 状态栏文案（含「怎么办」） —— 判据：绿

## 阶段 3 · 协议与客户端插件

- [ ] `[test]` 中继脚本：`reveal` 透传 `change`（`sessionId` ≤128、`turn` ≤1e6，非法即丢）、`reveal-ack` 回传（AC-7/11） —— 判据：红
- [ ] `[impl]` `buildIframeHtml()` 中继 + `handleWebviewMessage` 校验 —— 判据：绿
- [ ] `[test]` 客户端仿真：`ack.diff` 后带坐标、取不到坐标不带、`reveal-ack` 把等待从 2.5 s 延到 6 s、6 s 回放且不双开（AC-7/11） —— 判据：红
- [ ] `[impl]` `dsh-plugins/dsh-vscode-file-links/lib/client.js`（ES5 风格）实现 + 版本号提升 —— 判据：绿
- [ ] `[test]` `off`/`revealOnly`/`revealAndOpen` 行为不变，`off` 不安装任何插件（AC-8） —— 判据：绿

## 阶段 4 · 安装与配置

- [ ] `[test]` `diffAndOpen` 时安装新插件、不写 `dependencies`、版本不一致覆盖安装（AC-4/8） —— 判据：红
- [ ] `[impl]` `changesPluginFiles()` / `changesPluginVersion()` + `ensureProfileDeclaration(profile, pkg, null)` + 提示重启 —— 判据：绿
- [ ] `[test]` `[P]` 旧 dsh / 无 `git` 环境下安装与降级不报错（AC-10/13） —— 判据：绿

## 阶段 5 · 文档与发布

- [ ] `[docs]` `docs/TESTING.md` 测试地图补两行（`file-link-diff` / `dsh-changes-plugin`）并更新断言总数
- [ ] `[docs]` `README.md` 配置表新增 `diffAndOpen` 说明与四级数据来源/降级说明
- [ ] `[docs]` `CHANGELOG.md` 顶部新版本小节
- [ ] `[docs]` `spec.md` 状态改 `implemented`，补「验证记录」（套件 + 断言数 + 实机结论）
- [ ] `[impl]` `package.json` 与插件 `package.json` 版本号提升 —— **发版前需维护者确认**
- [ ] `[impl]` 打 tag `v<版本>` 并确认 Release 工作流绿 —— **需维护者确认**

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 | 阶段 1 | `dsh-changes-plugin.test.js` |
| AC-2 | 阶段 1 | `dsh-changes-plugin.test.js` |
| AC-3 | 阶段 2 | `file-link-diff.test.js` |
| AC-4 | 阶段 2 / 4 | `file-link-diff.test.js`、`workspace-file-link.test.js` |
| AC-5 | 阶段 2 | `file-link-diff.test.js` |
| AC-6 | 阶段 1 / 2 | `dsh-changes-plugin.test.js`、`file-link-diff.test.js` |
| AC-7 | 阶段 3 | `file-link-client-sim.test.js`、`file-link-bridge.test.js` |
| AC-8 | 阶段 3 / 4 | `workspace-file-link.test.js` |
| AC-9 | 阶段 1 | `dsh-changes-plugin.test.js` |
| AC-10 | 阶段 1 / 2 / 4 | `dsh-changes-plugin.test.js`、`file-link-diff.test.js` |
| AC-11 | 阶段 3 | `file-link-client-sim.test.js` |
| AC-12 | 阶段 2 | `file-link-diff.test.js` |
| AC-13 | 阶段 4 / 5 | `e2e-real-dsh.test.js` + 实机 F5 |

## 例外与决策记录

- 若实现时发现 `records` / `sources` 与当前 dsh 结构不符：P1 不启用，只交付 P0，
  AC-1/2/10 标注「不适用」，spec 状态与验证记录同步（不得静默跳过测试任务）。
- 若真实 web 轮不产生 `workspace/changes` 事件：同上，只交付 P0，另开缺陷规格跟进。
