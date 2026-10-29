# 任务清单 007：面板内 DSH「复制」按钮写入剪贴板失败

> 先红后绿；每完成一项把 `[ ]` 改成 `[x]` 并在交付说明里贴 `npm test` 结果。

## 阶段 0 · 准备

- [x] `[impl]` 常量 `CLIPBOARD_PLUGIN_SOURCE` / `CLIPBOARD_MAX_TEXT` / `CLIPBOARD_TIMEOUT_MS` 落位 —— 判据：`__internals` 可取到
- [x] `[test]` `test/clipboard-plugin.test.js` 增加客户端 vm 仿真骨架 —— 判据：能跑到第一断言
- [x] `[test]` 新建 `test/clipboard-bridge.test.js`（复用 file-link-bridge 的 realm 模式） —— 判据：能跑到第一断言
- [x] `[impl]` `scripts/run-tests.js` 登记新套件 —— 判据：`npm test` 会执行它

## 阶段 1 · 协议与宿主（L2）

- [x] `[test]` AC-5：中继转发合法 `clipboard-write`、拒绝错误 origin/source/超长 —— 判据：红
- [x] `[impl]` 中继新增 `clipboard-write` 分支与 `clipboard-result` 回传 —— 判据：绿
- [x] `[test]` AC-1：`handleWebviewMessage` 调 `vscode.env.clipboard.writeText` 并回 `ok:true` —— 判据：红
- [x] `[impl]` 宿主写入 + 回执 —— 判据：绿
- [x] `[test]` AC-6：写入抛错回 `ok:false` 且状态栏只提示一次 —— 判据：红→绿

## 阶段 2 · 插件客户端（L3）

- [x] `[test]` AC-2：原生成功不发消息、不装宿主回退 —— 判据：红
- [x] `[test]` AC-3：非 iframe 不包装 `navigator.clipboard.writeText` —— 判据：红
- [x] `[test]` AC-1：原生失败 → 发 `clipboard-write` → 收 `clipboard-result(ok)` → resolve —— 判据：红
- [x] `[test]` AC-7：1.5 s 无回执 → `execCommand` 兜底 —— 判据：红
- [x] `[impl]` client.js 三级回退 + 幂等安装 + 回执监听 —— 判据：绿
- [x] `[impl]` 插件版本 0.3.0 —— 判据：`ensureClipboardPlugin` 会覆盖安装并提示重启 dsh web

## 阶段 3 · 回归与文档

- [x] `[test]` AC-4：`installClipboardPlugin=false` 不写插件文件（复用既有安装测试） —— 判据：绿
- [x] `[test]` AC-8：client.js 不出现 `readText` 覆写、不碰 click/DOM 结构 —— 判据：绿
- [x] `[docs]` `docs/TESTING.md` 测试地图补行
- [x] `[docs]` `README.md` 配置说明与行为说明
- [x] `[docs]` `docs/ARCHITECTURE.md` 插件表更新（0.3.0 能力）
- [x] `[docs]` `CHANGELOG.md` 新版本小节（发版需维护者确认）
- [x] `[docs]` `spec.md` 状态改 `implemented`，补验证记录

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 | 阶段 1 / 2 | `clipboard-bridge.test.js` · `clipboard-plugin.test.js` |
| AC-2 | 阶段 2 | `clipboard-plugin.test.js` |
| AC-3 | 阶段 2 | `clipboard-plugin.test.js` |
| AC-4 | 阶段 3 | `clipboard-plugin.test.js` |
| AC-5 | 阶段 1 | `clipboard-bridge.test.js` |
| AC-6 | 阶段 1 | `clipboard-bridge.test.js` |
| AC-7 | 阶段 2 | `clipboard-plugin.test.js` |
| AC-8 | 阶段 3 | `clipboard-plugin.test.js` |

## 例外与决策记录

- 粘贴（`readText`）不在本次范围：用户反馈与复现都集中在复制按钮；避免扩大对 DSH
  页面的接管面。
