# 项目宪法（Constitution）

> 本文是 SDD 流程的「上位法」：`spec.md` / `plan.md` / `tasks.md` 与所有代码变更都不得与之冲突。
> 冲突时以本文件为准；确需修订宪法，必须在 PR 中单独提交宪法变更并说明理由与影响面。
> 版本：1.0.0（随 1.0.0 发布确立）

每条原则包含三部分：**原则**（要什么）、**为什么**（历史/架构原因）、**可验证约束**（评审时怎么判）。

---

## 第一条 · 忠实窗口不可妥协

**原则**：面板必须忠实呈现 DSH Web GUI。不得向 DSH 页面注入脚本、改写 DOM、劫持快捷键或
拦截交互——唯一例外是随包分发、默认开启但可关闭的内置插件，且它们必须遵守「只读监听 +
握手后生效 + 失败回放原行为」。

**为什么**：用户（包括 DSH 二次开发者）会自行组织页面、装配第三方插件。任何隐式改写都会与
他们的定制打架，且难以排障。`dsh-webview-clipboard` / `dsh-vscode-file-links` 之所以可接受，
是因为它们在未握手（非本面板内嵌）时完全惰性。

**可验证约束**：
- 页面内注入的最小单元是「一个 `postMessage` 协议 + 只读事件监听」；新增 DOM 写入视为破坏，
  必须走宪法修订。
- 插件能力必须能通过配置关闭（如 `dshPanel.workspaceFileLinkAction=off`、`installClipboardPlugin=false`），
  关闭后行为与该特性不存在时完全一致。
- 有对应回归测试证明「非内嵌场景不介入」（如 `test/file-link-client-sim.test.js`、
  `test/macos-keysim.test.js` 的负面用例）。
- 父容器对 iframe 的**视口裁剪**（只调整外层容器的尺寸/偏移，不注入、不改写页面内容与事件）
  不属于改写；但它改变了用户所见，因此必须可配置关闭（关闭后与不存在该能力时完全一致），
  并有对应规格（见 `docs/sdd/specs/004-dsh-sidebar-toggle/`）。

## 第二条 · 零依赖、零构建

**原则**：扩展本体只用 Node 内置模块与 `vscode` API；不引入运行时依赖、开发依赖、构建器、
转译器或前端框架。`extension.js` 即产物。

**为什么**：这是一次「`git clone` 后按 F5 就能跑、拷进 `.vsix` 就能发」的扩展；依赖会让
Remote / 旧版 Node 场景、审计与最小权限都变复杂。历史提交中所有能力都是在零依赖下实现的。

**可验证约束**：
- `package.json` 无 `dependencies` / `devDependencies`；`node_modules/` 不参与运行。
- 新增测试/构建辅助能力时，实现方式只能是「Node 内置模块 + 仓库内脚本」
  （见 `scripts/run-tests.js`）。
- CI 中 `npm test` 不执行 `npm install` 仍然通过。

## 第三条 · 禁止静默降级

**原则**：任何「功能不可用 / 结果与用户选择不一致 / 本轮没有产出」都必须被显式告知，
并给出下一步动作。宁可噪音，不可无声。

**为什么**：历史事故——DSH 0.2.x 改事件通道后，Copilot 侧表现为「任务已提交、回答空白」；
`session.selectModel` 校验失败会回落到默认模型而界面无提示。两者都因静默而长期未被发现。

**可验证约束**：
- 不可用路径必须产出可见信号：`progress.report` 里的 `⚠️/❌`、`showWarningMessage`、
  状态栏消息或面板错误页；禁止只 `console.log`。
- 模型映射失配必须由 `checkDshModelDrift()` 告警（读 `session/modelCatalog` 对比）。
- 用户取消等待时必须说明「任务仍在 DSH 运行」，而不是留白。
- 新代码路径若存在「失败即什么都不做」的分支，评审必须要求补提示或明确记录为可接受。

## 第四条 · 兼容是与旧能力签订的合同

**原则**：新增能力不得让既有场景变差。必须同时兼容：Windows / macOS / Linux；
本地 / Remote-SSH / WSL / Dev Containers；新版 dsh 与未启用 Web 认证的旧版 dsh。

**为什么**：用户群横跨三种远程形态与两代 dsh；一次硬依赖会导致大批用户直接不可用
（`v0.8.34` 认证适配即为此设计了 stdout 探测、`--no-open` 试探测、RPC 端点回退三层机制）。

**可验证约束**：
- 涉及 dsh 契约的改动必须保留回退：端点（`workspace/create` ↔ `workspace.create`）、
  历史（`session/page` ↔ `session/history`）、事件（`assistant/message` ↔ `assistant/chunk`）、
  启动参数（`--no-open` 探测）。
- 平台差异分支必须写明原因，并有测试或明确的手验记录；不得用「统一实现」删掉 Windows
  `shell: true` 或 POSIX 无 shell 这类差异。
- Remote 场景不得因新特性新增**必需**的本地前置条件（端口转发、令牌粘贴都必须是自动或有出路的）。

## 第五条 · 安全默认

**原则**：默认配置下不引入新的攻击面；所有外部输入（设置项、链接路径、页面消息、DSH 响应）
都按不可信处理。

**为什么**：扩展会以用户权限启动子进程、在 webview 加载远端页面、把模型给出的路径映射到
本地文件系统。历史安全问题（PR #12 的 workspace 设置注入）证明这条线必须持续收紧。

**可验证约束**：
- 进 `spawn`/`exec` 的值必须经白名单净化（`sanitizeCommand` / `getHost` / `getPort`），
  POSIX 使用无 shell 的 `execFile` + 参数数组；改动必须有 `test/command-execution.test.js`、
  `test/config-sanitize.test.js` 断言。
- webview CSP 最小化：`default-src 'none'` + 精确 `frame-src` + `nonce` 脚本；
  所有插值经 `escapeHtml` / `jsonForScript`。
- 文件系统访问限制在「当前工作区文件夹内且 `stat` 成功」；绝对路径与 `../` 越界拒绝。
- 凭据（dsh 令牌、Cookie）只存在于内存与 `globalState`，不得进入日志、错误消息或新落盘位置。

## 第六条 · 可测试性是一等公民

**原则**：新增逻辑默认可以被离线测试。宿主的副作用（`vscode.*`、`fs`、`net`、子进程）
必须能在测试里被替换；核心判定抽成纯函数。

**为什么**：仓库没有测试框架、没有依赖注入容器，全部靠「纯函数 + `__internals` 导出 +
独立进程 stub」实现离线验证（343 项断言全部离线，e2e 只验证真实 dsh 契约）。

**可验证约束**：
- 新纯函数必须可从 `module.exports.__internals` 访问（仅供测试，运行时行为不变）。
- 每个新能力至少新增一个断言组；新增文件必须在 `docs/TESTING.md` 的测试地图登记。
- 不允许「只能手验」的新功能；只能手验的部分（如 macOS 快捷键）必须用仿真环境覆盖。

## 第七条 · 文档、版本、变更三者同步

**原则**：用户可见的改动必须同时更新 `README.md`（用法/配置表/原理）与 `CHANGELOG.md`；
版本号语义化，并与提交信息、tag 一致。

**为什么**：`package.json` 的 `description` 与 README 是 Marketplace 的展示面，
`dshPanel.*` 配置表是用户唯一的行为参考；不同步会造成「功能在、文档无」的支持成本。

**可验证约束**：
- 新增/修改配置项 → `package.json` 的 `contributes.configuration` + README 配置表同步。
- 行为变更 → `CHANGELOG.md` 新增条目，提交信息带 `（vX.Y.Z）`。
- 发布三处一致：`package.json.version` = `CHANGELOG` 顶部版本 = git tag `vX.Y.Z`。
- 新增非运行时目录（`docs/`、`scripts/`、`.github/`）必须同步 `.vscodeignore`。

## 第八条 · 变更纪律：spec 先行、测试先行、小步提交

**原则**：行为变更先有规格与验收标准，再有失败测试，再有实现；一次提交只解决一个问题组。

**可验证约束**：
- PR 关联 `docs/sdd/specs/NNN-*/spec.md`（或声明轻量例外并说明理由）。
- 每个 bug 修复附带能复现该 bug 的测试（修复前红）。
- `npm test` 全绿才可合并；`main` 始终保持可发布。
