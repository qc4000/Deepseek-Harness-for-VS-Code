# 技术方案 017：抽屉态手动显隐落到宿主覆盖

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：implemented） |
| 负责人 | @Vithrive |
| 更新 | 2026-11-12 |

## 1. 方案概述

`toggleSidebarNow()` 在抽屉态分支里，先按「这次点击之后的可见性」写宿主覆盖，再发 `layout-toggle`：

```
点击（抽屉态） → wantHidden = !measured.collapsed（即将变为不可见？）
              → setHidden(wantHidden, 'user')   // 既有入口：改 hidden + 持久化覆盖（dsh-sidebar-state）
              → postToFrame({type:'layout-toggle'})  // 既有：请求 DSH 原生收放
```

`wantHidden = !当前 collapsed`：当前收起（不可见）→ 点击后可见 → `hidden=false`；当前展开 → 点击后收起 →
`hidden=true`。覆盖写在前、转调发在后，两者都幂等；失败时保留用户意图（拉宽后仍按意图执行），
与 015 的失败提示互不干扰。

## 2. 影响面

| 文件 / 函数 | 改动性质 | 触碰安全数据流 | 对应 AC |
| --- | --- | --- | --- |
| `extension.js` 中继 `toggleSidebarNow()` | 修改（抽屉分支先 `setHidden`） | webview 消息（既有 `dsh-sidebar-state`） | AC-1、AC-2、AC-3 |
| `test/dsh-sidebar.test.js`：`[10]` 覆盖断言改向、新增 `[19]` 复现序列 | 修改/新增 | — | 全部 |
| `docs/*`：015 AC-3/plan 行、ARCHITECTURE、README、TESTING 地图、017 验证记录 | 更新 | — | — |

## 3. 契约变更与兼容

| 契约 | 新形态 | 旧形态 / 回退 | 探测方式 |
| --- | --- | --- | --- |
| webview → 扩展 `dsh-sidebar-state` | 抽屉态点击也会发（`reason:'user'`） | 旧版抽屉态不发 → 拉宽被 auto 隐藏（本缺陷） | 消息本身不变，无需回退 |
| 宿主 → 页面 `layout-toggle` | 不变（每次点击一条） | 旧插件忽略未知 type | 既有 |
| 覆盖优先级 | 覆盖 > 策略 > 宽度（既有规则） | — | 既有 `computeHidden` |

## 4. 状态与并发

| 状态 | 位置 | 谁置位 | 谁清理 | 失效策略 |
| --- | --- | --- | --- | --- |
| `hidden` / 覆盖 | webview 内存 + `globalState` | 抽屉态点击（`setHidden`）、grid 态点击、配置变更 | 配置变更清覆盖（既有） | 拉宽/拉窄由覆盖优先 |

并发：单线程点击，`setHidden` 同步改内存 + 异步 post；无新增去重需求。

## 5. 安全审查

- [x] 仍只发既有 `dsh-sidebar-state{hidden:boolean, reason:'user'}`（无新增字段、无用户输入）。
- [x] 仍只调一次公开服务；未握手/非内嵌不动作。
- [x] 无新增权限、路径、token、DOM 写入。

## 6. 测试策略（先红后绿）

| 层 | 断言（映射 AC） |
| --- | --- |
| L2 vm 中继 | AC-1（点击 → 覆盖 false + 一条 layout-toggle；拉宽 900/1200 后 crop 0、标签不变）、AC-2（点「隐藏」→ 覆盖 true；拉宽后 crop=56）、AC-4（去抖不覆盖覆盖值）、AC-5（拉回抽屉态仍 crop 0） |
| 回归 | AC-3（015/016 既有断言：抽屉 crop 恒 0、单条 toggle、失败提示） |

## 7. 实施步骤

1. `[test]` 写 `[19]` 复现序列 + 改 `[10]` 的覆盖断言 → 确认红。
2. `[impl]` `toggleSidebarNow()` 抽屉分支先 `setHidden(want, reason)`。
3. `[test]` 全绿；`[docs]` 同步 015/ARCHITECTURE/README/TESTING/017。

## 8. 回退方案

| 层级 | 手段 | 触发条件 |
| --- | --- | --- |
| 代码 | 删除抽屉分支的 `setHidden` 即回到 015 行为（一行的回退面） | 若实机发现覆盖语义与新预期冲突 |
| 功能 | `dshPanel.dshSidebar=show`（不装插件） | 用户不想被裁剪 |
| 配置 | 任意 `dshPanel.dshSidebar` 变更会清覆盖 | 用户想回到 auto |

## 9. 被否方案与原因

| 方案 | 否决原因 |
| --- | --- |
| 离开抽屉态时再根据 DSH 折叠状态补写覆盖 | 离开瞬间的 `collapsed` 已被 DSH 的断点重置改写，无法区分「用户意图」与「自动折叠」 |
| 只在「显示」时写覆盖 | 隐藏方向不对称，拉宽后仍会冒出侧栏 |
| 抽屉态不写覆盖、改用「记住上次抽屉可见性」的新状态 | 新增状态面、与既有覆盖优先级重复 |

## 10. 开放问题

- 若实机出现「点击后 DSH 抽屉未开但覆盖已显示」的割裂感，可考虑在转调失败时回滚覆盖（当前选择保留意图）。
