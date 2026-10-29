# 任务清单 008：面板内 VS Code 快捷键转发

> 用法：任务按「先红后绿」排序；每完成一项把 `[ ]` 改成 `[x]` 并在 PR 里贴 `npm test` 结果。
> 粒度：单项 ≤ 半个工作日。`[P]` 表示与相邻任务无依赖、可并行。`[test]` 必须先于对应 `[impl]` 合入。

## 阶段 0 · 准备（基础设施）

- [x] `[impl]` 常量与配置键落位：`KEYS_PLUGIN_NAME/SOURCE`、`FORWARD_KEYS_KEY`、`FORWARD_MAP_KEY`、
      `FOCUS_RELEASE_KEY`、`DEFAULT_FORWARD_KEYS`（13 条）、`FORWARD_MAX_ENTRIES=64` —— 判据：`__internals` 可取到
- [x] `[test]` 创建 `test/key-bridge.test.js` 骨架（vscode 桩 + `ok()` + vm 中继域） —— 判据：能跑到第一断言
- [x] `[test]` 创建 `test/key-bridge-client.test.js` 骨架（vm + 仿真 window/ModuleLoader） —— 判据：能加载真实 `lib/client.js`

## 阶段 1 · 纯逻辑（L1）

- [x] `[test]` `normalizeCombo`：`mod` 三平台展开、修饰键顺序归一、大小写、chord 拒绝、无修饰键拒绝、未知主键拒绝 —— 判据：红
- [x] `[impl]` `normalizeCombo` + `comboToGesture` + `gestureSignature` + `signatureToCombo` —— 判据：绿
- [x] `[test]` `parseForwardKeybindings`：非对象、`true`、非法 id、非法键名、`__proto__`、超 64 条 —— 判据：红
- [x] `[impl]` 逐条校验 + 一次性提示计数（不打断其余条目） —— 判据：绿（AC-5）
- [x] `[test]` `buildForwardTable`：默认表 + 新增 + 覆盖 + `false` 禁用（AC-4） —— 判据：红→绿
- [x] `[test]` `buildForwardTable` 里的 `table`：签名 → true；`forwardVSCodeKeys=false` 时为空表 —— 判据：红→绿（AC-3）

## 阶段 2 · 宿主接入（L2）

- [x] `[test]` 中继：`hello` → `keys-ack{table, releaseKey}`；表项为 `sig → command` —— 判据：红
- [x] `[impl]` `buildIframeHtml` 内联 `KEYS_TABLE` / `KEYS_RELEASE` / `KEYS_ENABLED` + 中继分支 —— 判据：绿
- [x] `[test]` 中继：非法 gesture（`code` 超长、字段缺失、带 `command`）不转发（AC-6） —— 判据：红→绿
- [x] `[test]` 中继：`focus-release` → `frame.blur()` + `#dsh-stage.focus()` + 回宿主（AC-7） —— 判据：红→绿
- [x] `[test]` `dsh-keys-config` 热更新表且不重载 iframe（AC-9） —— 判据：红→绿
- [x] `[test]` `handleWebviewMessage`：`dsh-forwarded-key` 执行命令、非法不执行、失败提示一次 —— 判据：红→绿
- [x] `[impl]` 三个新消息分支 + `notifyForwardFailure` —— 判据：绿

## 阶段 3 · 页面侧（L3）

- [x] `[test]` 未握手不挂 keydown、不发消息（AC-11 的仿真近似） —— 判据：红
- [x] `[impl]` `dsh-plugins/dsh-vscode-keys/lib/client.js`（ES5） —— 判据：绿
- [x] `[test]` 命中键 `preventDefault + stopPropagation` 并只发 gesture（不发命令 id） —— 判据：红→绿
- [x] `[test]` DSH 目录（`catalog`/`fixedCatalog`）命中 → 不拦 + 记入 shadowed（AC-2） —— 判据：红→绿
- [x] `[impl]` `shortcuts` 服务探测 + `degraded` 回报 —— 判据：绿
- [x] `[test]` `F6` → `focus-release`；独立浏览器（`parent === window`）不 hello —— 判据：红→绿
- [x] `[impl]` `package.json` / `cordis.patch.yml` / `lib/index.js`（宿主半边空实现） —— 判据：`node --check` 通过

## 阶段 4 · 命令、配置与文档

- [x] `[impl]` `shouldInstallKeysPlugin` + `ensureKeysPlugin` + `ensureDshPlugins` 接入 —— 判据：关闭开关时不写文件（AC-3）
- [x] `[impl]` `dshPanel.keyStatus`：四分组 QuickPick + 添加转发键（写 Global）+ 复制 Markdown（AC-8）
- [x] `[impl]` 配置变更监听两处推送 `dsh-keys-config`（AC-9）
- [x] `[impl]` `package.json`：3 个配置项（`object` 允许 `string|boolean`）+ 1 个命令
- [x] `[docs]` `docs/TESTING.md` 测试地图补两行（套件 / 断言数 / 覆盖）
- [x] `[docs]` `docs/ARCHITECTURE.md` §6 插件表 + §9 已知限制（chord、F6 语义、不读 keybindings.json）
- [x] `[docs]` `README.md` 设置表 + 默认转发表 + 冲突处理说明
- [x] `[docs]` `CHANGELOG.md` 顶部小节
- [x] `[docs]` `spec.md` 状态改 `implemented`，补「验证记录」（套件 + 断言数）
- [ ] `[impl]` 版本号提升 + 打包 + tag —— **需维护者确认后执行**

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 / AC-6 / AC-9 | 阶段 1 / 2 | `key-bridge.test.js` |
| AC-2 / AC-7 / AC-10 / AC-11 | 阶段 3 | `key-bridge-client.test.js`、`key-bridge.test.js` |
| AC-3 / AC-4 / AC-5 | 阶段 1 / 2 / 4 | `key-bridge.test.js` |
| AC-8 | 阶段 4 | 手动 + `key-bridge.test.js`（报告结构） |

## 例外与决策记录

- 不做 `"<combo>": true` 自动解析（用户决策）：值为 `true` 时按非法条目忽略并提示，改由
  `keyStatus` 的命令搜索或命令面板「复制命令 ID」提供命令 id。
- L4 e2e 不新增：本规格不触达 DSH RPC 契约，页面侧契约由 L3 仿真覆盖；实机验证列入 spec 验证记录待办。
