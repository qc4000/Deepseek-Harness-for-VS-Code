## 关联规格

<!-- 行为变更必须关联 spec；轻量例外（纯文档/注释/无行为变化重构）请写「轻量例外：<理由>」 -->

- 规格：`docs/sdd/specs/NNN-<name>/spec.md`（状态：<approved/implementing/implemented>）
- Issue：#

## 改动摘要

<!-- 用户可观察的变化是什么；为什么这样做（关键决策与被否方案） -->

## 测试证据

<!-- 贴实际输出，不要写「已测试」 -->

```
$ npm test
▸ 测试套件（12 个，离线）
...
全部通过：12 套套件 / 343 项断言 ✓
```

- 新增/修改的套件：`test/<x>.test.js`（+N 项断言，覆盖 AC-x）
- e2e：`npm run test:all`（不适用请写原因）
- 实机验证：<OS / 本地或远程 / dsh 版本 / 步骤与结论>

## 兼容性影响

| 场景 | 影响 | 验证方式 |
| --- | --- | --- |
| Windows / macOS / Linux | | |
| 本地 / WSL / Remote-SSH / Dev Containers | | |
| 新版 dsh / 旧版 dsh | | |

## 安全审查

- [ ] 未新增 npm 依赖 / 构建步骤
- [ ] 进 `spawn`/`exec` 的值已净化；POSIX 无 shell
- [ ] webview CSP 未放宽；插值经 `escapeHtml`/`jsonForScript`
- [ ] `postMessage` 校验 `origin` + `source`；字段截断
- [ ] 文件路径限制在工作区内且 `stat` 成功
- [ ] token / Cookie 未进日志、错误消息或新落盘位置

## 回退方案

<!-- 配置开关 / 保留旧路径 / 补丁版本；说明触发条件 -->

## 自检（Definition of Done）

- [ ] spec 的每条 AC 都能指到一条断言
- [ ] 负面用例（开关关闭 / 平台不符 / 非法输入 / 超时）已覆盖
- [ ] 契约变更保留新旧回退
- [ ] 用户可见失败都有中文提示与出口
- [ ] README / CHANGELOG / 版本号已同步（若发布）
- [ ] `docs/TESTING.md` 测试地图已更新（新增套件时）
- [ ] 非运行时新增目录已加入 `.vscodeignore`
