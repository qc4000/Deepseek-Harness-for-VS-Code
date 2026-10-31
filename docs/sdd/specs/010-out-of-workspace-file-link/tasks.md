# 任务清单 010：工作区外文件链接也能在 VS Code 里看变更

## 阶段 0 · 准备

- [x] `[impl]` 抽出 `stripLinkLineSuffix()`（`:12` / `#L12`），`resolveWorkspaceTarget` 与新链路共用
- [x] `[impl]` `openOutOfWorkspaceDiff` / `notifyOutOfWorkspaceLink` 挂 `__internals` —— 判据：测试可直接调用
- [x] `[test]` `test/file-link-diff.test.js` 增 `[6] 工作区外链接`（vscode 桩复用）—— 判据：红

## 阶段 1 · 纯逻辑（L1）

- [x] `[test]` AC-1 命中：`vscode.diff` + 标题含「第 N 轮」+ 左右取自记录 —— 判据：红
- [x] `[impl]` 最小实现（P1 取数 → `openVirtualDiff`）—— 判据：绿
- [x] `[test]` AC-5 命中路径不调 `revealInExplorer` / `readGitHeadBaseline` —— 判据：红→绿
- [x] `[test]` AC-3 行号后缀：`no-change` 时去后缀重试（最多两次）—— 判据：红→绿
- [x] `[test]` AC-4 无坐标/非法坐标 → 不发请求 —— 判据：红→绿
- [x] `[test]` AC-5 各失败原因都有定向文案（`unavailable` 含「重启 dsh web」）—— 判据：红→绿

## 阶段 2 · 宿主接入（L2）

- [x] `[test]` AC-1/AC-2 消息链路：`dsh-reveal-path` → 一次 `ok:true` / `ok:false` —— 判据：红
- [x] `[impl]` `revealWorkspaceTarget` 未命中分支接入 —— 判据：绿
- [x] `[test]` AC-6 `revealAndOpen` / `revealOnly` / `off` 不取轮级数据 + 提示含出路 —— 判据：红→绿
- [x] `[test]` AC-7 既有三级降级断言全部保留（未删改）—— 判据：绿

## 阶段 3 · 插件侧

- [x] `[test]` AC-8 `changeCandidates` 折叠 `..` 的绝对候选 —— 判据：红
- [x] `[impl]` `posix.normalize` 候选 + 注释说明原因 —— 判据：绿
- [x] `[test]` 反方向补丁：点击给绝对路径、记录给 `../x` —— 判据：红（真机最常见的那一半）
- [x] `[impl]` `posix.relative(base, abs)` 候选 —— 判据：绿
- [x] `[impl]` 插件版本 `0.2.3` → `0.2.4`（判据：`ensureChangesPlugin` 会覆盖安装）

## 阶段 4 · 文档与发布

- [x] `[docs]` `README.md`：配置表与 `diffAndOpen` 章节补「工作区外文件也能看该轮变更」
- [x] `[docs]` `docs/ARCHITECTURE.md`：文件链接链路补「解析失败 → P1-only」分支
- [x] `[docs]` `docs/TESTING.md`：断言数更新（`file-link-diff` 105、`dsh-changes-plugin` 52）
- [x] `[docs]` `CHANGELOG.md` 新增 `1.0.7` 小节（含 Windows 反斜杠路径修复）
- [x] `[docs]` `package.json`：`workspaceFileLinkAction` 的 `diffAndOpen` 说明同步（未动版本号）
- [ ] `[impl]` `package.json` 版本号与 tag —— **需维护者确认后执行**
- [x] `[docs]` spec 状态改 `implemented`，补验证记录

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 / AC-2 | 阶段 1 / 2 | `file-link-diff.test.js` |
| AC-3 / AC-4 | 阶段 1 | `file-link-diff.test.js` |
| AC-5 | 阶段 1 | `file-link-diff.test.js` |
| AC-6 / AC-7 | 阶段 2 | `file-link-diff.test.js`、`workspace-file-link.test.js` |
| AC-8 | 阶段 3 | `dsh-changes-plugin.test.js` |
| AC-9 | 阶段 2 / 3 | 既有安全断言（`workspace-file-link` 越界拒绝、插件 AC-9） |

## 例外与决策记录

- 不新建测试文件：新断言并入 `file-link-diff.test.js`（已有 diff harness 与 vscode 桩），
  避免重复造桩。
- 不跑 `npm run test:all`：本次没有改 dsh 契约字段（路由参数/响应不变，只多了路径候选），
  实机验证由维护者用 dev 包完成。
