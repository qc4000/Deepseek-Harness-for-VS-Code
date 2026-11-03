# 任务 014：面板内新窗口/新标签外链的浏览器选择

> 顺序：先红 → 最小实现 → 负面用例 → 文档。每完成一项勾选。

## A. 规格与基础设施

- [x] 014 `spec.md` / `plan.md` / `tasks.md`
- [x] `extension.js`：`EXTERNAL_LINK_ACTION_KEY` / `EXTERNAL_LINK_ACTIONS` /
      `MAX_EXTERNAL_LINK_LENGTH`
- [x] `extension.js`：`externalLinkAction()` / `parseHttpUrl()`
- [x] `__internals` 导出上述纯函数与路由函数

## B. 先红（测试）

- [x] `test/open-external-plugin.test.js`：插件 0.2.0 文件/版本/`externalLinks` ack
- [x] 同上：`_blank` 普通左键转交；DSH `preventDefault` 跳过；`stopPropagation` 仍转交
- [x] 同上：修饰键/中键立即转交；Alt/`_self`/同源/`download`/非 http(s)/超长不转交
- [x] 同上：`window.open` 与 click 同 URL 去重；`kind` 区分 login/popup/link
- [x] 同上：`dsh-external-links-config` 热更新并重发 ack
- [x] `test/external-link-open.test.js`：设置默认/非法值、system/vscode/off 路由
- [x] 同上：`simpleBrowser.show` 失败回退 + 状态栏提示；`openExternal=false` 提示
- [x] 同上：`parseHttpUrl` 负面用例；远程回环 `asExternalUri`
- [x] 同上：`ensureOpenExternalPlugin` 0.2.0 落盘/幂等/不写 dependencies
- [x] `TMPDIR=/tmp npm run test:one -- open-external` 确认红

## C. 实现

- [x] 插件 `package.json` 0.2.0
- [x] 插件 `lib/client.js`：click/auxclick capture、意图判定、微任务、去重、kind
- [x] 插件 `lib/client.js`：`externalLinks` ack 开关、状态 API、卸载清理
- [x] `buildIframeHtml`：ack 增加 `externalLinks`；中继透传 `kind`；热更新分支
- [x] `handleWebviewMessage`：`kind` 白名单 + `routeOpenLink`
- [x] `routeOpenLink` / `openInSystemBrowser` / `openInVSCodeBrowser` / 失败提示
- [x] 配置监听（侧栏 + 标签页）→ `pushExternalLinksConfig` + `ensureDshPlugins`
- [x] `package.json` 新增 `dshPanel.externalLinkAction`
- [x] 重启提示文案加入 `dsh-vscode-open-external`

## D. 文档与验收

- [x] `README.md` 功能说明 + 设置表（并修掉 `dsh-open-links` 旧说法）
- [x] `CHANGELOG.md` 未发布条目
- [x] `docs/ARCHITECTURE.md` 插件表 + 外链消息协议
- [x] `docs/TESTING.md` 测试地图与套件数
- [x] `TMPDIR=/tmp npm test` 全绿
- [ ] 实机 F5：设置页外链、Ctrl+点击、中键、off、登录
