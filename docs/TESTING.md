# 测试与 TDD 指南

> 本仓库**没有测试框架**（宪法第二条：零依赖）。所有测试是「Node 脚本 + 自带断言 + 进程退出码」，
> 由 `scripts/run-tests.js` 串行驱动。本文说明：TDD 在本仓库怎么落地、测试分几层、
> 每个套件覆盖什么、怎么写新测试、失败怎么查。

## 1. 命令

```bash
npm test                      # 语法检查 + 14 套离线单测（504 项断言）
npm run test:one -- file-link # 只跑文件名含 file-link 的套件（TDD 内循环）
npm run test:verbose          # 逐套件完整输出（看每个 ✓/✗）
npm run test:all              # 追加真实 dsh e2e（需本机已安装 dsh）
node test/xxx.test.js         # 单套件直跑（最细粒度）
```

退出码约定：`0` 全绿；`1` 断言失败/异常；`2` 环境问题（端口被占、找不到套件）。
CI 只认退出码，不看输出格式。

## 2. TDD 循环（本仓库的具体做法）

```
① 写 spec 的验收标准（Given/When/Then，见 docs/sdd/templates/spec.md）
② 在对应套件里加一个「当前必然失败」的断言（红）
   npm run test:one -- <主题>   → 确认它因「功能不存在」而失败，而不是因写错而失败
③ 最小实现让它变绿（不做多余设计）
   npm test                     → 确认没有打翻别的套件
④ 重构（提取纯函数、去重、补注释），全程保持绿
⑤ 补负面用例：关闭开关 / 平台不符 / 非法输入 / 超时 / 竞态
⑥ 更新 docs/TESTING.md「测试地图」与 spec 的验证记录
```

硬规则（来自宪法第八条）：
- **bug 修复必须先有复现测试**，并确认它在修复前是红的。
- **新增行为必须有断言**；只改注释/文档的提交不需要。
- 一个任务组一次提交；测试与实现同提交（不要「下个 PR 再补测试」）。

## 3. 测试分层

| 层 | 目标 | 手法 | 典型套件 |
| --- | --- | --- | --- |
| L1 纯函数 | 解析、判定、映射、序列化 | 直接调 `__internals` | `dsh-stream-events`、`dsh-model-mapping`、`config-sanitize` |
| L2 协议/桥 | webview 中继脚本、消息协议 | `vm` 真跑生成的脚本 + 假 `acquireVsCodeApi` | `file-link-bridge`、`workspace-file-link` |
| L3 仿真环境 | 浏览器侧插件行为、平台差异 | 最小 DOM/事件/定时器仿真 + 假 UA | `file-link-client-sim`、`macos-keysim` |
| L4 真实进程 | dsh 认证与 RPC 契约 | 本机 spawn 独立 dsh 实例 | `e2e-real-dsh` |

补充：还有「生成物检查」——源码以模板字符串生成的插件（`clipboardPluginFiles()`）必须对生成结果做
`node --check`，因为模板转义写错会让**所有平台**的 DSH 页面加载失败。

## 4. 测试地图

改动某模块时，先看这里该跑哪些套件。

| 套件 | 断言 | 覆盖 |
| --- | --- | --- |
| `auth-proxy.test.js` | 21 | 令牌解析；裸地址 401 控制组；Cookie 换发与注入；dsh 重启后 401 自动重换；SSE 分块不被缓冲；WebSocket 升级透传；`localhost` 与 `127.0.0.1` 按 authority 独立换发 |
| `clipboard-bridge.test.js` | 16 | 复制按钮回退（007）的中继与宿主：合法 `clipboard-write` 转发、origin/source 双校验、超长不转发并回 `ok:false`、宿主回执回传 iframe、`vscode.env.clipboard.writeText` 成功/失败回执、失败提示只一次 |
| `clipboard-plugin.test.js` | 42 | 生成文件的语法真实通过；只拦 ⌘C/⌘V/⌘X（不拦 ⌘A/撤销/光标）；macOS + Electron + iframe 三重门控；不写 `dependencies`；`cordis.patch.yml` 结构；复制按钮三级回退（原生成功不发消息、原生被拒走宿主、无回执/`ok:false` 时 `execCommand` 兜底、非 iframe 不接管、未知 token 忽略）；配置开关与“不拦 click/不碰 readText”约束 |
| `command-execution.test.js` | 5 | `runCommandOk`/`runCommandOutput` 真实命令成功与失败；元字符注入拒绝；POSIX 无 shell / Windows 引号路径两条执行路径 |
| `config-sanitize.test.js` | 14 | `getHost` 白名单与回退；`getPort` 整数/范围；`sanitizeCommand` 拒绝 `& \| < > ^ % ! " \` ;` 与换行；合法带空格路径保留 |
| `dsh-changes-plugin.test.js` | 45 | `dsh-vscode-changes` 宿主插件（按真机契约重写）：包声明/语法/不写 dependencies；路由参数校验（缺参/越界/超长）；公开钩子自捕获两侧全文（`fs/write-intent` **与** `fs/edit-intent` + `turn/end`）：同轮多次编辑合并为一条净变更、write+edit 混用仍一条、跨轮互不累积、改回原样不列出、新增/删除文件两侧 absent；`summary()` 权威清单匹配（未记录路径不读盘）；shell 直接改动 `no-text`；会话释放 `released` / 轮无记录 `no-record` / 服务形状不符 `unavailable` 三种 404；二进制与超大；同轮取最新事件 |
| `dsh-model-mapping.test.js` | 38 | 条目 id/名称（改 id 会丢用户已选）；非 `dsh` 条目映射到 DSH 在册模型；provider info 字段合法（成本串/上限/capabilities/推理档位 schema）；`findMissingDshModels` 漂移检测；诊断文件落临时 HOME |
| `dsh-sidebar.test.js` | 61（有 1 条 zoom 断言待随 1.0.3 回退更新，既有问题、与 005 无关） | 侧栏裁剪中继脚本（`vm` 真跑）：stage/clip 分层与缩放解耦、auto/show/hide × 宽度、280/420/56/0 与 `+4` 手柄余量、异常测量丢弃、按钮切换与上报、宿主 `toggle`/`config` 消息、未测量时不裁并上报 unavailable；测量插件文件/声明/语法/安装幂等/`show` 不安装；插件客户端仿真（握手前静默、上报、拖动重报、折叠标记、卸载清理、元素缺失不误报） |
| `dsh-stream-events.test.js` | 22 | `assistant/message` 只回写 text 块；旧 `text-delta` 增量；历史 `block-end` 不重复；`seq` 游标推进；`turn/end` 结束与异常原因；空事件列表安全 |
| `file-link-bridge.test.js` | 37 | `vm` 真跑 webview 中继脚本：握手 ack（含重试）、reveal 转发、result 回传、origin/source 校验、`off` 模式不转发；`dsh-open-link` / `insert-selection` 既有中继不受影响；diff 模式 `ack.diff`、轮坐标透传与非法坐标丢弃、`reveal-ack` 回传 |
| `file-link-client-sim.test.js` | 46 | 插件客户端仿真：未 ack 前不介入；命中按钮 → 阻断 + 发 reveal；`ok=true` 不回放 / `ok=false` 回放 / 超时回放；修饰键不接管；非链接按钮不接管；独立浏览器不打招呼；卸载后清定时器；diff 模式带轮坐标、`reveal-ack` 把等待从 2.5 s 放宽到 6 s；坐标两条退路（无 `ctx.get` 只有属性访问、祖先无标记取「前一个」标记行）；**布局 ack（`{layout:true}`）不得覆盖 `diffMode`**（真机根因回归）；取不到坐标不带（AC-7） |
| `file-link-diff.test.js` | 74 | 轮级 diff 宿主侧：坐标净化、匹配候选、标题（轮级 vs HEAD）、二进制/体积判定；404 三种含义（`released`/`no-record`/`unavailable`）与 `no-text` 的原因映射及各自文案；`dsh-diff` 虚拟文档存取与容量淘汰；三级降级（P1 → P0 → L0）与提示文案；git 基线（无改动/非仓库/空仓库/二进制/超大）；`handleWebviewMessage` 接单回执与非法坐标丢弃 |
| `macos-keysim.test.js` | 24 | macOS UA 下逐键行为与 IME/修饰键过滤；Windows 与非 iframe 场景完全不激活 |
| `remote-mode.test.js` | 15 | `isLocalLoopbackTarget`：WSL Remote 放行、SSH/Dev Container 禁用、非回环禁用；无服务时 `probeDirectIndexStatus` 安全返回 0 |
| `workspace-file-link.test.js` | 84 | 插件文件齐全/声明/语法；中继脚本语法 + 协议字段；路径解析（相对多工作区、绝对、`../` 越界、不存在、`:12`/`#L12` 行号）；`revealAndOpen`/`revealOnly`/`off`；安装幂等且不写 `dependencies`；`diffAndOpen` 枚举与 `dsh-vscode-changes` 安装（只宿主半边、登记 bundles、幂等、落盘语法通过） |
| `workspace-pin.test.js` | 73 | 工作区跟随（006）：插件包声明（`dsh.client.platform=web`、bundle patch、无依赖）与「不碰 DOM/localStorage」静态约束；`workspacePinPath`/`workspacePinEnabled`/路径形状（空窗口、开关、URL、控制字符、超长）；中继脚本独立消息 `workspace-pin`（origin/source 双校验、8s 超时上报、结果状态白名单与 reason 截断、特殊字符路径不破坏脚本）；客户端仿真（未握手惰性、`create`+`openWorkspace` 各一次、已就位不动作、服务缺失上报 unsupported、失败上报 failed、未就绪轮询、重复下发幂等、非父级消息不认）；`ensureWorkspacePlugin` 落盘/登记/幂等 |
| `e2e-real-dsh.test.js` | — | 真实 dsh：启动参数与扩展一致；捕获 `dsh web:` 令牌；裸地址 401；经代理 200；真实 RPC 信封调用；结束清理 |

## 5. 写新测试的骨架

新建 `test/<主题>.test.js`，复制下面骨架（与现有套件风格一致）：

```js
'use strict';
/**
 * <主题> 回归测试。
 * 运行：node test/<主题>.test.js
 * 覆盖：<逐条列出，评审据此判断是否够>
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');

let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('断言失败: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

// ── vscode 桩：只实现本套件用到的 API ──
const state = { config: {}, folders: [] };
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d) }),
    workspaceFolders: state.folders,
    fs: { stat: async () => ({ type: 1 }) }
  },
  env: { remoteName: undefined },
  window: { showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};
const I = require(path.join(__dirname, '..', 'extension.js')).__internals;

(async () => {
  ok(typeof I.目标函数 === 'function', '函数已导出到 __internals');
  // ……断言……
  console.log('\n全部通过：' + passed + ' 项断言 ✓');
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
```

要点：
- **必须** `Module._load` 拦截 `vscode`：`extension.js` 顶层 `require('vscode')`，不拦截直接崩。
- 需要 `fs`/`http`/子进程时，尽量用真实临时目录、真实回环服务（如 `auth-proxy` 的假 dsh），
  而不是继续 mock——真实 I/O 能抓到端口/编码/时序问题。
- 临时资源一律清理；固定测试端口（如 31117/3199）使用前探测占用。
- 涉及 HOME 的测试必须临时改写 `os.homedir` 并在 `finally` 里恢复（见 `dsh-model-mapping`）。

## 6. 各层编写要点

**L2 中继脚本**：用 `vm` 执行 `buildIframeHtml()` 内联脚本，注入假 `document`/`window`/
`acquireVsCodeApi`，捕获 `postMessage` 与宿主回执。测 `origin`/`source` 校验时，构造不同
`event.origin` 与 `event.source` 断言「不处理」。

**L3 插件仿真**：`file-link-client-sim.test.js` 用 `vm` 加载真实 `lib/client.js`，提供
`window.__ModuleLoader__.load`、`document.addEventListener`、`setTimeout` 队列，手动触发
`click`/`message`，并统计「DSH 自身打开被调用次数」以验证回放语义。

**L4 e2e**：只在需要验证 dsh 真实契约（认证换发、RPC 信封、事件结构）时写；
默认 `npm test` 不跑，CI 不跑（CI 无 dsh）。e2e 必须：用独立端口、独立实例、结束时强杀进程树。

## 7. 断言设计原则

1. **每个正面用例配一个负面用例**：开关关闭、未握手、平台不符、非法输入、越界路径。
2. **断言用户可观察结果**，而不是实现细节：断言「发出去的 message 形状」「progress 文本包含 ⚠️」，
   而不是「内部变量为 true」。
3. **钉住契约字符串**：协议字段（`source`/`type`）、DSH 端点名、模型 id、配置键名——这些改了就断，
   断得越早越好。
4. **时序相关要留余量**：等待用「轮询 + 超时」，不用固定 `sleep` 当作唯一同步手段。
5. 断言文案用中文，说明「期望的行为」而不是「实现」。

## 8. 失败了怎么看

| 现象 | 常见原因 |
| --- | --- |
| `Cannot find module 'vscode'` | 忘记 `Module._load` 拦截，或拦截写在 `require` 之后 |
| 端口被占用 / `EADDRINUSE` | 上次 e2e 进程未清理；先释放端口再跑 |
| 断言在 CI 红、本地绿 | 平台差异（路径分隔符、`shell`、大小写）或时序；用 `process.platform` 分支断言 |
| 中继脚本相关测试失败但源码「看起来对」 | 模板字面量转义（`\\\\`）、CSP nonce、`event.origin` 精确匹配 |
| `__internals` 里没有目标函数 | 新增函数没有导出到 `module.exports.__internals` |
| macOS 键位测试失败 | 门控条件（iframe/Electron/macOS UA）与环境构造不一致 |

## 9. 完成标准

- `npm test` 全绿（含语法检查）；
- 新增/修改行为在测试地图中有对应行；
- 新增断言数出现在 PR 的「测试证据」里（套件名 + 断言数）；
- 涉及真实 dsh 契约的改动已跑 `npm run test:all`，结果写进 spec 的验证记录。
