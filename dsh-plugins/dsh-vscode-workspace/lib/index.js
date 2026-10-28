// dsh-vscode-workspace host half: no-op.
//
// 本插件只做客户端（浏览器侧）工作：把 DSH 的「当前工作区」切到外层 VS Code 宿主
// 正在打开的那个文件夹。切换走 DSH 公开的客户端服务（`ctx.workspaces.create` +
// `ctx.uiWorkspace.openWorkspace`），不改页面 DOM、不拦交互、不写 DSH 存储。
// 宿主侧不需要任何逻辑，故这里是空实现（与 dsh-vscode-file-links 同构）。

export const name = 'dsh-vscode-workspace'

export const inject = []

export function apply(_ctx) {}
