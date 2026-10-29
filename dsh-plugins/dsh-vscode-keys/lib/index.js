// dsh-vscode-keys host half: no-op.
//
// 本插件只做客户端（浏览器侧）工作：面板内按下的快捷键由这里识别后转发给外层宿主
// （Deepseek-Harness-for-VS-Code 扩展的 webview），由宿主执行 VS Code 命令。
// 宿主侧不需要任何逻辑，也没有自己的 RPC 路由。
export const name = 'dsh-vscode-keys'

export const inject = []

export function apply(_ctx) {}
