# 任务清单 016：侧栏抖动诊断日志 + 缩放实测校准

> 顺序：`[test]` → `[impl]`；单项 ≤ 半个工作日；`[P]` 可并行。勾选后在 PR 贴 `TMPDIR=/tmp npm test` 结果。

## 阶段 0 · 准备（基础设施）

- [x] `[impl]` 消息与字段落位：`innerWidth`、`layout-diag`、`layout-diag-request`、`dsh-sidebar-diag`、
      `dsh-sidebar-diag-request`；插件版本 `0.2.0 → 0.3.0`（单一源头 package.json + PLUGIN_VERSION）
      —— 判据：三方命名一致，测试可直接引用
- [x] `[impl]` 环形缓冲骨架（插件/宿主各 120 条，`{t, ev, v}` 形状）挂到各自作用域
      —— 判据：超限丢最旧、`clear()` 可清

## 阶段 1 · 插件侧（先红）

- [x] `[test]` AC-1：ack/上报/recv/flip 入日志，`logs()` 形状与 ≤120 上限、`clear()` 清空
      —— 判据：当前失败（无日志 API）
- [x] `[test]` AC-4：`layout` 上报携带 `innerWidth`（`window.innerWidth`）
      —— 判据：当前失败
- [x] `[test]` AC-2：1s 内 7 次 band 翻转 → 发 `layout-diag{reason:'flip-storm'}`；10s 限流；
      未握手不发；条目 ≤200 且 `v` 只含可打印串
      —— 判据：当前失败
- [x] `[impl]` 插件：`log()/logs()/clear()`、`innerWidth`、翻转计数（注入时钟便于测试）、风暴检测与
      限流、`layout-diag-request` 应答、`window.__dshVscodeLayout` 排障 API
      —— 判据：阶段 1 断言变绿，`node --check` 通过（保持 ES5 风格）
- [x] `[impl]` `package.json` 版本 0.3.0 —— 判据：`ensureLayoutPlugin` 触发覆盖安装 + 重启提示

## 阶段 2 · 宿主中继（先红）

- [x] `[test]` AC-4（中继）：ratio=1.25 → 导轨 70 / 展开 355；ratio=0.75 → 42 / 213；
      `innerWidth` 缺失/0/非数、实宽 ≤0、ratio 越界 → 回退 1（= 015 数值）并记 `ratio-fallback`；
      抽屉态恒 0
      —— 判据：当前失败（裁剪未乘 ratio）
- [x] `[test]` AC-6：连续 resize（拖动）150ms 内不重算、静默后按最终宽度翻一次；
      初始加载立即算；show/hide/覆盖立即生效
      —— 判据：当前失败（现在逐帧重算）
- [x] `[test]` AC-2/AC-3（中继）：收到 `layout-diag` → 合并宿主日志发 `dsh-sidebar-diag`；
      `dsh-sidebar-diag-request` → 发 `layout-diag-request` 并在 600ms 内回包/超时兜底标
      `pluginUnavailable`
      —— 判据：当前失败
- [x] `[impl]` 中继：宿主环形日志、`cropPixels` 按 ratio 计算与回退、`hidden` 尾沿去抖、
      两种 diag 汇聚转发与超时兜底
      —— 判据：阶段 2 断言变绿

## 阶段 3 · 扩展宿主（先红）

- [x] `[test]` AC-3（宿主）：`normalizeSidebarDiag` 白名单（`ev` 形状、`v` 清洗截断、条数 ≤200、
      非法整条丢弃）；命令 → 发 `dsh-sidebar-diag-request`；回包 → 输出面板追加 + `show()`；
      无面板 → 中文信息提示；1.5s 无回包 → 兜底写入说明
      —— 判据：当前失败（分支/命令/通道不存在）
- [x] `[test]` AC-2（宿主）：`dsh-sidebar-diag` → 输出面板 + 状态栏一次提示，重复风暴不刷屏
      —— 判据：当前失败
- [x] `[impl]` `normalizeSidebarDiag` + 懒创建输出面板 + `dshPanel.diagnoseSidebar` 注册与
      `package.json` 贡献点 + 1.5s 兜底
      —— 判据：阶段 3 断言变绿

## 阶段 4 · 收敛证明与回归

- [x] `[test]` AC-5：固定点扫描扩到 `s ∈ {0.75,0.875,1,1.25}` × 240–1400，分段期望
      `0 / round(56s) / round(284s)`、无 2-周期、`crop ≤ round((轨道+4)×s)`
      —— 判据：先确认 s≠1 时旧公式（未乘 ratio）**红**，再变绿
- [x] `[test]` AC-7：`TMPDIR=/tmp npm run test:one -- dsh-sidebar` 全绿（含 004/015 既有项）
      → `TMPDIR=/tmp npm test` 全量绿 —— 判据：输出「全部通过：N 项断言 ✓」

## 阶段 5 · 文档与发布

- [x] `[docs]` `docs/TESTING.md` 测试地图 `dsh-sidebar.test.js` 行更新（断言数 + 本规格覆盖）
- [x] `[docs]` `docs/ARCHITECTURE.md` §3 裁剪公式改「轨道 × 实测 ratio」+ 诊断链路一句
- [x] `[docs]` `docs/sdd/specs/004-dsh-sidebar-toggle/spec.md`：AC-8 机制措辞修订（裁剪量按实测比例换算，
      「与缩放无关」改为「不出现错位/白边/内容被切」的可观察目标）+ 变更历史一行指向 016
- [x] `[docs]` `README.md`：命令「DeepSeek Harness: 导出 DSH 侧栏诊断」与非 1 倍字号行为更新
- [x] `[docs]` 016 `spec.md` 状态 → `implemented`，§10 验证记录回填（含实机日志回传位）
- [ ] `[docs]` `CHANGELOG.md` + `package.json` 版本（**发版动作，需维护者确认，不自动执行**）

## 验收对齐

| AC | 覆盖任务 | 套件 |
| --- | --- | --- |
| AC-1 | 阶段 1 | `dsh-sidebar.test.js`（插件仿真） |
| AC-2 | 阶段 1 / 2 / 3 | 插件仿真 + vm 中继 + 宿主净化 |
| AC-3 | 阶段 3 | `dsh-sidebar.test.js`（宿主 + 中继链路） |
| AC-4 | 阶段 2 | `dsh-sidebar.test.js`（vm 中继） |
| AC-5 | 阶段 4 | `dsh-sidebar.test.js`（收敛扫描 ×4 缩放） |
| AC-6 | 阶段 2 | `dsh-sidebar.test.js`（resize 去抖） |
| AC-7 | 阶段 4 | `npm test` 全量 |

## 例外与决策记录

- 004 §10 的「实测量自校准」由本规格落地；**不做**任何预测/回写（1.0.2 两次失败先例）。
- 日志用输出面板而非 `~/.dsh-debug` 文件（避免路径与清理问题）。
- 自动取证用「状态栏一次提示 + 命令打开」，不自动弹面板（打扰度）。
