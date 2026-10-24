# AGENTS.md

面向在本仓库工作的 AI 编码代理（人类说明见 [README.md](README.md)）。
**读这一页即可开工**，细节按第 9 节跳到 `docs/`。优先级：用户当前指令 > [项目宪法](docs/CONSTITUTION.md) > 本文件 > 其他文档。

## 1. 项目

**DeepSeek Harness for VS Code**（`deepseek-harness-vscode`）：零依赖、零构建的 VS Code 扩展，把 DeepSeek Harness（DSH，`@deepseek-ai/dsh`）接入 VS Code。两条能力线：

- **忠实窗口**：把 DSH Web GUI 原样内嵌到侧边栏/标签页；自动安装、启动、探测、认证 dsh；Remote 走端口转发。
- **Copilot 桥接**：把 DSH 注册为聊天模型（`vendor: dsh`），滤除 VS Code 注入的噪音，按转录增量转发并流式回写。
- **配套插件**（随包分发、可关闭）：`dsh-vscode-file-links`（对话内工作区链接改在资源管理器打开）、`dsh-vscode-layout`（只读上报侧栏宽度，供面板视口裁剪）、内置 `dsh-webview-clipboard`、npm 包 `dsh-drop-caret`。

## 2. 命令

```bash
npm test                      # 语法检查 + 12 套离线单测（343 项断言；无需 npm install）
npm run test:one -- <子串>    # 只跑匹配的套件（TDD 内循环）
npm run test:all              # 追加真实 dsh e2e（需本机已装 dsh）
npm run package               # 打 .vsix
# 交互调试：VS Code 打开仓库按 F5，在扩展开发宿主窗口打开你的项目
```

Node ≥ 18。无 `npm install`、无编译：`extension.js` 就是产物。

## 3. 红线（违反即返工）

1. **不破坏忠实窗口**：除可关闭的内置插件外，不向 DSH 页面注入脚本、改 DOM、拦交互。
2. **零依赖零构建**：不加 `dependencies`/`devDependencies`，不引入 TS / 打包器 / 框架。
3. **禁止静默降级**：功能不可用必须用户可见（`⚠️/❌`、warning、状态栏、错误页），不能只 `console.log`。
4. **安全默认**：进 `spawn`/`exec` 的值必须净化（`sanitizeCommand`/`getHost`/`getPort`，POSIX 无 shell）；
   webview 最小 CSP + nonce；HTML 插值走 `escapeHtml`/`jsonForScript`；路径必须工作区内且 `stat` 成功。
5. **兼容不倒退**：三平台 × 本地/WSL/SSH/容器 × 新旧 dsh；涉及 DSH 契约必须保留回退路径。
6. **行为改动必须带测试**：先红后绿；修 bug 先写复现测试。

## 4. 代码约定（详见 [CONVENTIONS](docs/CONVENTIONS.md)）

- CommonJS、2 空格、单引号、分号；**注释写「为什么」且用中文**，函数上方 JSDoc，`// ====` / `// ──` 分节。
- 命名语义：`get*` 取值、`ensure*` 幂等、`resolve*` 解析、`build*` 产出、`is*` 判定、`try*` 尽力而为。
- 可测性：判定逻辑抽纯函数并挂 `module.exports.__internals`；并发去重复用既有模式（单飞 Promise / `Map<key,Promise>`）。
- 用户文案中文、全角标点，失败要写「怎么办」；日志前缀 `[DeepSeek Harness]`。
- 改 `extension.js` 前先读 [架构说明](docs/ARCHITECTURE.md)（四条链路 + DSH 契约新旧对照表）。

## 5. 测试（TDD，详见 [TESTING](docs/TESTING.md)）

- 每套件独立进程：`Module._load` 拦 `vscode`、自带 `ok()` 计数，成功打印 `全部通过：N 项断言 ✓` 并退出 0。
- 默认全部离线（假 dsh 服务 / `vm` 跑中继脚本 / 仿真 DOM）；真实 dsh 只进 `test/e2e-real-dsh.test.js`。
- 顺序：先加会失败的断言（`npm run test:one`）→ 最小实现变绿 → 补负面用例（开关关闭 / 平台不符 / 非法输入 / 超时）。
- 新增或修改套件后，在 [测试地图](docs/TESTING.md#4-测试地图) 补一行。

## 6. 流程（SDD + TDD，详见 [SDD 说明](docs/sdd/README.md)）

行为变更（含 bug 修复）按序：**spec → plan → tasks → 先红后绿 → 验证 → 发布**。

- 规格：`docs/sdd/specs/NNN-kebab-case/spec.md`，从 [模板](docs/sdd/templates/spec.md) 起手，AC 必须可执行（Given/When/Then）。
- 方案与任务：同目录 `plan.md`（影响面/契约回退/测试策略）、`tasks.md`（`[test]` 先于 `[impl]`）。
- 验证：`npm test`（涉及 dsh 契约再 `npm run test:all`），结论写回 spec 的「验证记录」。
- 发布：`package.json` 版本 + `CHANGELOG.md` + 必要时 `README.md`，打 tag `v<版本>`。
- 轻量例外：纯文档/注释/无行为变化的重构（须说明依据）。

## 7. 提交与 PR

- 提交：`<type>: <中文描述>（v<版本>）`，`type ∈ feat|fix|test|docs|chore|security|merge`。
- PR 必填：关联 spec、改动摘要、**实际测试输出**、兼容性影响、安全审查、回退方案（模板：`.github/pull_request_template.md`）。
- 不提交 `.vsix`、`.dsh-debug/`、`node_modules/`、`.vscode/`。

## 8. 易错点速查

- 模板字面量里生成 JS 源码时，正则反斜杠要写 `\\\\`，否则注入脚本语法错误、功能整体失效。
- Windows 必须 `shell: true`、POSIX 必须无 shell：两端规则不同，别「统一简化」。
- 标签页接管时侧边栏必须让位（DSH 前端在 webview 双实例下互斥）。
- 只认 `assistant/chunk` 会让 Copilot「已提交但无回答」→ 必须同时认 `assistant/message`。
- 模型映射用 DSH 在册 id（如 `deepseek-flash`），失配由 `checkDshModelDrift` 告警。
- 新增非运行时目录必须同步 `.vscodeignore`，否则会被打进 `.vsix`。
- 完整历史事故清单：[CONVENTIONS · 历史坑](docs/CONVENTIONS.md#10-历史坑回归清单)。

## 9. 文档索引

| 需要什么 | 去哪 |
| --- | --- |
| 不可协商的原则 / 架构与 DSH 契约 | [CONSTITUTION](docs/CONSTITUTION.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) |
| 代码风格 / 历史坑 / 提交规范 | [CONVENTIONS](docs/CONVENTIONS.md) |
| 测试分层 / 测试地图 / 新测试骨架 | [TESTING](docs/TESTING.md) |
| CI / Release / 回滚 | [CI-CD](docs/CI-CD.md) |
| SDD 流程 / 模板 / 基线规格 · 插件规则 | [sdd/README](docs/sdd/README.md) · [插件 AGENTS](dsh-plugins/dsh-vscode-file-links/AGENTS.md) |

## 10. 交付前自检

- [ ] 有 spec（或已声明轻量例外），AC 都能指到断言；`npm test` 全绿，新套件已登记测试地图
- [ ] 契约变更保留回退，用户可见失败有提示；README / CHANGELOG / 版本号 / `.vscodeignore` 已同步（若涉及）
