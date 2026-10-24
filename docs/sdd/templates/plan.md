# 技术方案 NNN：<能力名称>

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：approved） |
| 负责人 | @<github-handle> |
| 更新 | YYYY-MM-DD |

## 1. 方案概述

<3-6 句：整体思路、为什么选它、一句话说明数据怎么流。>

```
<触发点> → <模块/函数> → <DSH 契约 / VS Code API / webview> → <可观察结果>
```

## 2. 影响面

| 文件 / 函数 | 改动性质 | 触碰安全数据流 | 对应 AC |
| --- | --- | --- | --- |
| `extension.js` `xxx()` | 新增 / 修改 | 子进程 / webview / 路径 / token / 否 | AC-1 |
| `dsh-plugins/<plugin>/lib/client.js` | 新增 / 修改 | 否 | AC-2 |
| `test/<主题>.test.js` | 新增 | — | 全部 |
| `package.json` 配置项 | 新增 / 修改 | 否 | AC-3 |
| `README.md` / `CHANGELOG.md` | 更新 | — | — |

## 3. 契约变更与兼容

| 契约 | 新形态 | 旧形态 / 回退 | 探测方式 |
| --- | --- | --- | --- |
| DSH RPC 端点 | | | 404 / `raw === 'not found'` |
| DSH 事件 | | | 按事件 `type` 分派 |
| VS Code API | | | `typeof vscode.xxx === 'function'` 判断后降级 |
| webview / 插件消息 | | | 握手 `ack` + 字段校验 |
| 配置项 | | | 非法值回退默认 |

> 「无回退」必须写明理由（并说明失败时用户看到什么）。

## 4. 状态与并发

| 状态 | 位置（内存 / globalState） | 谁置位 | 谁清理 | 失效策略 |
| --- | --- | --- | --- | --- |
| | | | | |

并发去重：<单飞 Promise / `Map<key, Promise>` / 幂等文件写入>。

## 5. 安全审查

- [ ] 进入 `spawn`/`exec` 的值经 `getHost`/`getPort`/`sanitizeCommand`，POSIX 无 shell
- [ ] webview CSP 未放宽；新插值经 `escapeHtml`/`jsonForScript`；脚本带 nonce
- [ ] `postMessage` 校验 `origin` + `source`，字段类型与长度截断
- [ ] 文件系统访问限制在工作区内且 `stat` 成功
- [ ] token / Cookie 不进日志、错误消息与新落盘位置
- [ ] 新增外部输入已列入 `test/config-sanitize` 或对应套件

## 6. 测试策略（先红后绿）

| 层 | 套件 | 要加的断言（映射 AC） |
| --- | --- | --- |
| L1 纯函数 | `test/<主题>.test.js` | AC-1、AC-3 |
| L2 协议 | `test/file-link-bridge.test.js` 等 | AC-1、AC-2 |
| L3 仿真 | `test/<插件>-sim.test.js` | AC-2 |
| L4 e2e（如需要） | `test/e2e-real-dsh.test.js` | AC-4（真实契约） |

- 必跑：`npm test`；涉及 dsh 契约：`npm run test:all`。
- 手验（如有）：<OS/远程形态/步骤/期望>。

## 7. 实施步骤

1. 基础设施：<导出 `__internals`、桩扩展、常量>
2. 纯逻辑：<函数与断言>
3. 宿主接入：<命令/消息/进程/代理>
4. 页面侧：<webview 中继 / 插件>
5. 文档与发布：<README/CHANGELOG/版本>

## 8. 回退方案

| 层级 | 手段 | 触发条件 |
| --- | --- | --- |
| 功能 | 配置项 `<key>=false`（默认 <值>） | 用户遇到兼容问题 |
| 代码 | 保留旧路径（<旧函数/参数>） | 新版契约异常 |
| 发布 | 补丁版本回退（Marketplace 不可降级，只能发修复版） | 线上故障 |

## 9. 被否方案与原因

| 方案 | 否决原因 |
| --- | --- |
| | |

## 10. 开放问题

- 若 <假设 A 不成立>，则改为 <方案 B>。
