# 技术方案 016：侧栏抖动诊断日志 + 缩放实测校准

| 项 | 内容 |
| --- | --- |
| 规格 | [spec.md](spec.md)（状态：approved） |
| 负责人 | @Vithrive |
| 更新 | 2026-11-11 |

## 1. 方案概述

三件事，互不耦合、可分别回退：

1. **实测校准**：插件在 `layout` 上报里加 `innerWidth`（页面自身视口，DSH px）；宿主用
   `iframe.getBoundingClientRect().width`（webview px，含 `zoom:s` 的真实渲染）算
   `ratio = rect / innerWidth`（clamp 0.5–2，异常回退 1），裁剪改成 `round((轨道 + 手柄余量) × ratio)`。
   两个量来自同一次上报/同一次 applyLayout，天然同拍，**没有任何预测或回写**。
   （数学上 `ratio` 与 crop 无关：rect 与 innerWidth 都随裁剪同步缩放，故回路仍单调 → 不引入振荡。）
2. **auto 去抖**：`window.resize` 只标脏，`hidden` 重算延后 150ms（尾沿去抖）；`show/hide/覆盖` 立即生效。
3. **诊断日志**：插件环形 120 条 → 翻转风暴（1s ≥7 次）自动 `layout-diag`；宿主自己的环形 120 条；
   两端合并成 `dsh-sidebar-diag` → 扩展净化 → 输出面板「DeepSeek Harness」；命令 `dshPanel.diagnoseSidebar`
   手动导出（600ms 等页面回包，超时兜底）。

```
拖动/缩放 → window.resize(去抖) ┐
页面布局 → 插件 measure+log ──┼→ layout{w,c,d,innerWidth} → 宿主 log + ratio → crop（+去抖后的 hidden）
翻转风暴 → layout-diag ────────┴→ 宿主合并自身日志 → dsh-sidebar-diag → 扩展净化 → 输出面板 + 状态栏一次
命令 dshPanel.diagnoseSidebar → dsh-sidebar-diag-request →（600ms 合并/超时兜底）→ 输出面板
```

## 2. 影响面

| 文件 / 函数 | 改动性质 | 触碰安全数据流 | 对应 AC |
| --- | --- | --- | --- |
| `dsh-plugins/dsh-vscode-layout/lib/client.js`：环形日志 + `innerWidth` 上报 + 翻转计数/风暴上报 + `layout-diag-request` 应答 + `window.__dshVscodeLayout.{logs,clear,diag}` | 修改 | 否（仅 postMessage 白名单字段） | AC-1、AC-2、AC-4 |
| `dsh-plugins/dsh-vscode-layout/package.json`：`0.2.0 → 0.3.0` | 修改 | 否 | 升级触达 |
| `extension.js` 中继：宿主环形日志、`ratio` 计算与校准、`hidden` 尾沿去抖、`layout-diag` 合并转发、`dsh-sidebar-diag-request` 处理 | 修改 | webview 消息 | AC-4、AC-5、AC-6 |
| `extension.js` 宿主：`normalizeSidebarDiag` 白名单净化、输出面板（懒创建）、`dshPanel.diagnoseSidebar` 命令 + 1.5s 兜底提示 | 新增 | webview 消息 → 输出面板 | AC-2、AC-3 |
| `package.json`：`contributes.commands` 增 `dshPanel.diagnoseSidebar` | 修改 | 否 | AC-3 |
| `test/dsh-sidebar.test.js`：日志/风暴/导出/校准/去抖/四缩放扫描断言 | 扩展 | — | 全部 |
| `docs/*`：TESTING 地图、ARCHITECTURE §3、README、004（AC-8 机制措辞 + 变更历史）、016 验证记录 | 更新 | — | — |

## 3. 契约变更与兼容

| 契约 | 新形态 | 旧形态 / 回退 | 探测方式 |
| --- | --- | --- | --- |
| `layout` 上报 | 增 `innerWidth:number`（页面视口） | 旧插件缺字段 → `ratio=1` → 015 行为 | `typeof === 'number' && >0` 才参与校准 |
| 插件 → 宿主 | 新增 `layout-diag{reason,entries}` | 旧插件不发；旧宿主不认识会忽略（宽度校验先拦） | 只在 `type==='layout-diag'` 分支处理（置于宽度校验之前） |
| 宿主 → 插件 | 新增 `layout-diag-request` | 旧插件 `onMessage` 忽略未知 type → 宿主走 600ms 超时兜底 | 有回包用回包，无回包标 `plugin=unavailable` |
| webview → 扩展 | 新增 `dsh-sidebar-diag{reason,host[],plugin[]\|null}` | 旧扩展会忽略未知 type（不可能组合，同步分发） | `normalizeSidebarDiag` 白名单 + 上限 |
| 扩展 → webview | 新增 `dsh-sidebar-diag-request` | 旧 webview 忽略 → 扩展侧 1.5s 兜底提示 | 超时可见提示 |
| 配置项 | 无新增（复用 `dshPanel.dshSidebar`） | — | — |

## 4. 状态与并发

| 状态 | 位置 | 谁置位 | 谁清理 | 失效策略 |
| --- | --- | --- | --- | --- |
| 宿主环形日志（120 条） | webview 内存 | 每个布局/裁剪/resize/消息事件 | 超限丢最旧 | 面板重载即失 |
| 插件环形日志（120 条） | 页面内存 | 同上 | 同上 | 页面重载即失 |
| 风暴限流（10s）/ 状态栏提示（每窗口一次） | 插件 / `extension.js` 模块级 | 首次触发 | 进程/窗口结束 | 不自动复位 |
| `hidden` 去抖定时器（150ms） | webview | resize 标脏 | 新 resize 重置、回调执行 | 面板关闭即弃 |
| 导出等待（页面 600ms / 扩展 1.5s） | webview / `extension.js` | 收到导出请求 | 回包或超时 | 一次一条，不叠加 |

并发去重：导出请求用「在途即忽略重复」（`diagPending` 标志）；风暴上报用 10s 限流；
日志写入是同步单线程 push，无锁问题。

## 5. 安全审查

- [x] `layout-diag` / `dsh-sidebar-diag` 只含 `{t:number, ev:形状白名单, v:可打印串≤160}`，条目 ≤200；
      扩展侧 `normalizeSidebarDiag` 逐字段校验 + 正则清洗 + 条数截断，非法整条丢弃。
- [x] 日志内容不含 token/路径/对话内容（只记布局数值与短枚举）；不落盘（仅输出面板，用户主动可清）。
- [x] 消息仍走 `fromOurFrame`（origin+source 双校验）与插件侧 `event.source===parent` + HOST_ID 校验；
      未握手不采集、不回包。
- [x] CSP 未放宽；新增字段都是布尔/数字/短串，无新插值面（`jsonForScript`/字面量常量）。
- [x] 新命令不执行任何外部输入（无 spawn/路径），仅向当前面板转发一条固定消息。

## 6. 测试策略（先红后绿）

| 层 | 断言（映射 AC） |
| --- | --- |
| L3 插件仿真 | AC-1（日志条目/上限/clear）、AC-2（7 次翻转 → `layout-diag`、10s 限流、未握手不发）、AC-4（上报带 `innerWidth`） |
| L2 vm 中继 | AC-4（ratio 计算与回退、抽屉仍 0）、AC-6（resize 去抖只翻一次、show/hide/覆盖立即）、AC-2（合并上报、超时兜底）、AC-3（`dsh-sidebar-diag-request` 链路） |
| L1 宿主净化 | AC-3（`normalizeSidebarDiag` 白名单/截断/非法丢弃）、命令与输出面板（stub 捕获） |
| 收敛扫描 | AC-5（s × 240–1400 分段期望 + 无 2-周期） |
| 回归 | AC-7（既有全绿） |

- 必跑：`TMPDIR=/tmp npm run test:one -- dsh-sidebar` → `TMPDIR=/tmp npm test`。
- 实机（回填 §10）：fontSize 14/20 × 界面缩放 0/±1 × 拖动 1024 附近 × 命令导出日志回传。

## 7. 实施步骤

1. `[test]` 日志/风暴/校准/去抖/导出断言先写（红）。
2. `[impl]` 插件：环形日志 + `innerWidth` + 风暴检测/限流 + `layout-diag-request` 应答 + 版本 0.3.0。
3. `[impl]` 中继：宿主日志 + `ratio` 校准与回退 + `hidden` 去抖 + 两种 diag 汇聚转发。
4. `[impl]` 宿主：`normalizeSidebarDiag` + 输出面板 + 命令 + 兜底提示。
5. `[test]` 收敛扫描扩到四档缩放（AC-5）→ 全绿。
6. `[docs]` 004 AC-8 机制措辞修订 + 变更历史、TESTING 地图、ARCHITECTURE §3、README、016 验证记录。

## 8. 回退方案

| 层级 | 手段 | 触发条件 |
| --- | --- | --- |
| 校准 | `ratio` 缺失/越界自动回退 `1`（= 015 行为），无需开关 | 实测发现模型不符（日志可判） |
| 插件 | 旧插件（未重启 dsh web）天然走 015 老路径 + 安装提示 | 升级未生效 |
| 去抖 | 仅 `auto` 分支时序变化；改配置/覆盖即时生效 | 用户不习惯可手动切换覆盖 |
| 日志 | 未握手零动作；`show` 策略不装插件（连日志都没有） | 关闭能力即关闭取证 |
| 发布 | 补丁版本回退 | 线上故障 |

## 9. 被否方案与原因

| 方案 | 否决原因 |
| --- | --- |
| 再次按 `zoom` 静态乘算（004 AC-8 的字面「与缩放无关」） | 未验证语义就乘算 = 1.0.2 老路；改为**实测 ratio**（004 §10 原计划） |
| 断点预测 / 立即回写 / 延迟取值 | 004 §10、§12 两次实机失败（振荡、闪烁更严重），明确不再试 |
| 折叠动画期间延迟上报（animating 延迟） | 004 已否：动画期间会露出/裁切，改为逐帧跟随（保留） |
| 把日志写进 `~/.dsh-debug` 文件 | 输出面板即可取证、避免路径/权限/清理问题（模型诊断的文件式做法不适用） |
| 自动弹输出面板 | 打扰度高 → 状态栏一次提示 + 命令主动打开 |

## 10. 开放问题

- 若实机日志显示 `rect/(stage+crop) ≠ 1`（CSS zoom 盒子被缩放），说明渲染模型与假设不同 →
  下一版把 `ratio` 的分子改成 `stage+crop`（或按 `boxFactor` 修正），日志字段已预留。
- 若风暴阈值 7 次/1s 在正常场景误报 → 调常量（插件内单一常量，测试同步改）。
- 折叠动画 300ms 的瞬态露出（004 §12 第三项）本规格不处理，留待日志数据说话。
