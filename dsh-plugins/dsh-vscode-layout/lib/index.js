// dsh-vscode-layout host half: no-op.
// 本插件只做客户端（浏览器侧）的**只读测量**：把 DSH 左侧栏的宽度与折叠状态
// 上报给外层 VS Code 宿主，由宿主决定是否做视口裁剪。宿主侧无需任何逻辑。
export const name = 'dsh-vscode-layout'

export const inject = []

export function apply(_ctx) {}
