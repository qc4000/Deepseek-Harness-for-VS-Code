# CI / CD 说明

> 流水线文件：`.github/workflows/ci.yml`、`.github/workflows/release.yml`。
> 设计前提：**零依赖**（不 `npm install`）、**无构建**（`extension.js` 即产物）、
> **测试串行**（套件会绑定回环端口）。

## 1. 流水线总览

| 工作流 | 触发 | 做什么 | 门禁 |
| --- | --- | --- | --- |
| **CI** | push 到 `main`、任意 PR、手动 | 5 个矩阵任务跑 `npm test`（语法检查 + 12 套单测）；全部通过后在 ubuntu 上打包 `.vsix` 并校验包内容 | PR 合并前必须绿 |
| **Release** | push tag `v*`、手动 | 跑测试 → 校验 tag 与 `package.json.version` 一致 → 打包 → 建 GitHub Release 上传 `.vsix` →（可选）发布 Marketplace | 发布必须绿 |

合并前的必需检查（建议在仓库 Settings → Branches 中启用）：

- `测试 ubuntu-latest / Node 18`、`Node 20`、`Node 22`
- `测试 windows-latest / Node 20`、`测试 macos-latest / Node 20`
- `打包 .vsix`

## 2. CI 为什么这样设计

- **不装依赖**：仓库没有 `dependencies`，`npm test` 直接跑；这让 CI 快（约 1 分钟）且不受 npm 供应链影响。
- **三平台 + 三 Node 版本**：扩展大量使用平台分支（`shell: true` 仅 Windows、路径规范化、大小写），
  只在 Linux 上绿等于没测。Node 18 是实际下限（`fs.promises.cp`、对 ESM 文件的 `node --check` 均可用），
  CI 另覆盖 20/22 以提前发现运行时变化。
- **测试串行**：`scripts/run-tests.js` 逐套件 `spawn`，因为 `auth-proxy`/`remote-mode` 会绑定固定端口。
  并行化需要改造套件的端口分配，收益不大。
- **不跑 e2e**：`test/e2e-real-dsh.test.js` 需要本机安装 `@deepseek-ai/dsh` 并起真实实例，
  CI 环境不满足且不稳定。e2e 由维护者在涉及 dsh 契约变更的 PR 中本地执行（`npm run test:all`），
  结果写进 spec 的「验证记录」。
- **打包任务的意义**：`vsce` 的打包会暴露 `.vscodeignore` 漏配（把 `docs/`、`test/` 打进包）
  或丢失运行时必备文件（`dsh-plugins/`、`media/`），这类问题单测发现不了。

## 3. 本地复现 CI

```bash
npm test                      # 等同 CI 的 test 任务（不跑 e2e）
npm run package               # 等同 CI 的打包步骤，产物在当前目录
# 校验包内容（与 CI 一致）
unzip -l deepseek-harness-vscode-*.vsix | grep -E 'extension/(docs|test|scripts|\.github)/' ; echo "上面应无输出"
unzip -l deepseek-harness-vscode-*.vsix | grep 'dsh-plugins/dsh-vscode-file-links/lib/client.js'
```

Windows 本地验证包内容可用 `tar -tf`（Windows 10+ 自带 bsdtar）或解压后查看。

## 4. CD：发布流程

> **人工确认门禁**：改版本号、提交版本变更、打 tag、push、打包交付必须由维护者确认后再执行；
> 代理/贡献者不得自行发版（日常实现、测试、文档修改不受限）。

1. **改版本**（三处必须一致，宪法第七条）：
   - `package.json` → `version`
   - `CHANGELOG.md` → 顶部新增版本小节
   - `README.md` → 若用户可见行为/版本适配说明变化
2. **本地全绿**：`npm test`；涉及 dsh 契约再加 `npm run test:all`。
3. **提交**：`<type>: <描述>（v<版本>）`，推 `main`。
4. **打标签并推送**：

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

5. **Release 工作流自动**：测试 → 版本校验 → 打包 → GitHub Release（附 `.vsix`，自动生成 release notes）。
6. **Marketplace（可选）**：仓库 Secrets 里配置 `VSCE_PAT` 后，同一工作流会执行
   `vsce publish --packagePath`；未配置则跳过（GitHub Release 仍可用）。
7. **发布后验证**：下载 Release 里的 `.vsix`，`code --install-extension <file>`，
   打开面板确认能启动 dsh、Copilot 模型选择器出现 DSH 条目。

> 手动发布（不经 Actions）也可：`npm run package` → `code --install-extension <vsix>` 自测 →
> `npx --yes @vscode/vsce publish`（需 `VSCE_PAT`）。

## 5. 密钥与权限

| 名称 | 用途 | 配置位置 | 缺失后果 |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | 建 Release、上传产物 | Actions 自动注入 | Release 步骤失败（无法手动补齐，需重跑） |
| `VSCE_PAT` | 发布到 VS Code Marketplace | 仓库 Secrets | 仅跳过 Marketplace 发布，不影响 Release |

- 工作流权限最小化：CI `contents: read`；Release `contents: write`（建 Release 必需）。
- `VSCE_PAT` 只以 `env` 注入，不要写进命令回显；不要 `echo` 任何 token。
- 第三方 Action 固定大版本（`actions/checkout@v4` 等），升级需单独 PR 并说明原因。

## 6. 失败处置

| 失败点 | 处置 |
| --- | --- |
| 单套件断言失败 | 看 CI 日志里该套件的完整输出（运行器失败时会打印全量），本地 `npm run test:one -- <主题>` 复现 |
| 仅某平台失败 | 多为路径/`shell`/大小写差异；在该平台语义下修正实现或断言，不要 `skip` |
| 打包校验失败 | `.vscodeignore` 漏配（混入非运行时文件）或漏掉运行时文件（`dsh-plugins/`、`media/`） |
| Release 版本校验失败 | tag 与 `package.json.version` 不一致；删除错误 tag（`git tag -d` + `git push origin :vX`）后重打 |
| 一次 push 多个 tag，只跑了一个（或一个都没跑） | GitHub 对同一次 push 里的多个 tag 不可靠（实测 4 个 tag 一次推送 0 个 run）；而 `workflow_dispatch` 需要 `actions:write`，普通 PAT 常缺。逐个重推：`git push origin :refs/tags/vX && git push origin vX`，每个 tag 独立触发 |
| 多个 Release 里 `Latest` 标到了旧版本 | `gh release create` 不重置 Latest，它跟随最后完成的那个 | `gh release edit v<新版本> --latest` 手动指回 |
| Marketplace 发布失败 | PAT 过期/权限不足/版本已存在（Marketplace 不允许覆盖同一版本，必须提升版本号） |

**回滚策略**：Marketplace 上的版本不能覆盖，只能发布更高版本修复（或在市场页 unpublish）；
GitHub Release 可编辑说明或删除后重发。因此发布前必须完成第 2 步的本地验证。

## 7. 后续可选增强（未启用，按需走 spec）

- **e2e nightly**：定时任务里 `npm i -g @deepseek-ai/dsh` 后跑 `npm run test:all`，
  用于提前发现 dsh 新版本的契约漂移（对应 `checkDshModelDrift` 的 CI 侧补充）。
- **`npm publish` 分发插件**：让 `dsh-drop-caret` 之外的插件也能走 npm（当前刻意不走）。
- **PR 标签自动化**：按 `docs/sdd/specs/` 路径自动标注规格号。
