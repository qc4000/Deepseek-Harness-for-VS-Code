// dsh-vscode-changes —— 宿主半边（无客户端 bundle、无 UI）。
//
// 职责：把「某个会话的某个轮里，某个文件在轮开始/结束时的内容」出口成一条鉴权 GET
// 路由，供 Deepseek-Harness-for-VS-Code 扩展在 VS Code 里渲染并排 diff。
//
// 为什么自己捕获两侧全文（2026-10-27 按 dsh 0.2.1-rc.2 真机实测修正）：
// `ctx.workspaceChanges` 对外只提供 `{ summary(sessionId, seq), diff(...) }`，其中
// `diff()` 只回 3 行上下文的 hunk；轮级整文件两侧内容存在 TurnRecorder 的 `records`
// 里，而那是 dsh 插件 `apply()` 闭包内的私有字段，外部读不到（本插件早期版本正是读
// `records`，结果在真机上 100% 走 404，轮级 diff 从未生效；离线单测因假 ctx 里凭空
// 造了 `records` 而全绿——契约不能靠 mock 固化）。
//
// 现在的数据来源：
//   - 两侧全文：复用 dsh 自家 recorder 同款的公开钩子自行捕获 —— `fs/write-intent` 与
//     `fs/edit-intent` 前置读「轮内首次改动前」的原文（`write` 工具发前者、`edit` 工具
//     发后者，两个都要钩，漏一个就会让该工具的改动取不到 before），`turn/end` 时再读一次
//     作为「轮结束」的内容；同轮多次编辑天然合并为一条净变更，改回原样则不列出
//     （与 dsh 语义一致）。
//   - 「本轮改了哪些文件」：仍以 dsh 的 `summary()`（workspace/changes 事件的权威清单）
//     为准。这样 shell 直接改动（没有 intent 钩子）的文件也能被正确识别，
//     返回 `unavailable:'no-text'` 让扩展退回「与 HEAD 对比」，而不是误报「没变更」。
//
// 路由响应（扩展侧 `parseTurnChangeResponse` 与之对应）：
//   400 参数非法 / 404 {error:'released'|'no-record'|'unavailable'} /
//   200 {matched:false}（该轮没净变更）/ 200 {matched:true, binary|oversized|unavailable:'no-text'} /
//   200 {matched:true, before, after}（两侧：{kind:'text',text} | {kind:'absent'}）。

import { readFile } from 'node:fs/promises'
import nodePath from 'node:path'

export const name = 'dsh-vscode-changes'

// workspaceChanges 提供权威清单，connection 提供鉴权围栏内的路由注册，fs 把写入目标
// 解析成宿主进程路径（三个都是 dsh 公开服务）。
export const inject = ['workspaceChanges', 'connection', 'fs']

/** 路由：与 extension.js 的 CHANGES_ROUTE 必须一致。 */
const ROUTE = '/api/dsh-vscode.changes-file'
/** 单侧上限：超过就不返回内容（扩展会退回普通打开/HEAD 对比）。 */
const MAX_SIDE_BYTES = 1024 * 1024
const MAX_SESSION_ID = 128
const MAX_PATH = 4096
const MAX_TURN = 1000000
/** 内存护栏：会话释放前保留的轮数与字节数，超限淘汰最旧（记录只活到用户看完）。 */
const MAX_RECORDS_PER_SESSION = 64
const MAX_BYTES_PER_SESSION = 8 * 1024 * 1024

/** 统一 JSON 响应（不缓存：内容只对当前会话有效）。 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  })
}

/** 路径归一：反斜杠转 `/`、去掉 `./` 前缀、去尾斜杠。 */
function norm(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * 一次点击可能给出的路径写法（相对 / 绝对 / display），与扩展侧同名函数保持同一语义。
 * 保留 `..` 开头的形式：工作区上方文件在记录里正是以 `../x` 作 display。
 * @param {string} cwd
 * @param {string} target
 * @returns {string[]}
 */
export function changeCandidates(cwd, target) {
  const out = []
  const push = (value) => {
    if (typeof value !== 'string') return
    const s = norm(value)
    if (s === '' || out.includes(s)) return
    out.push(s)
  }
  const raw = typeof target === 'string' ? target : ''
  push(raw)
  const base = typeof cwd === 'string' && cwd !== '' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  if (base === '') return out.slice(0, 8)
  const isAbs = raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.startsWith('\\\\')
  const abs = isAbs ? norm(raw) : norm(base + '/' + raw)
  push(abs)
  if (abs.startsWith(base + '/')) push(abs.slice(base.length + 1))
  return out.slice(0, 8)
}

/** 内容里是否含 NUL（只看前 8 KiB），含则视为二进制。 */
function hasNul(buffer) {
  const n = Math.min(buffer.length, 8192)
  for (let i = 0; i < n; i += 1) {
    if (buffer[i] === 0) return true
  }
  return false
}

/**
 * 读一侧内容。
 * @param {string} abs 宿主进程绝对路径
 * @returns {Promise<{kind:'text',text:string}|{kind:'absent'}|{kind:'binary'}|{kind:'oversized'}>}
 */
async function readSide(abs) {
  let buffer
  try {
    buffer = await readFile(abs)
  } catch {
    // 读不到（不存在/无权限）与 dsh 的 absent 语义一致：作为「空」的一侧。
    return { kind: 'absent' }
  }
  if (buffer.length > MAX_SIDE_BYTES) return { kind: 'oversized' }
  if (hasNul(buffer)) return { kind: 'binary' }
  return { kind: 'text', text: buffer.toString('utf8') }
}

/** 一侧存进记录时的字节量（用于内存护栏）。 */
function sideBytes(side) {
  return side && side.kind === 'text' ? Buffer.byteLength(side.text) : 0
}

/** 净变更判定：两侧完全一致（含都不存在）就不算该轮的变更，与 dsh「改回原样不列出」一致。 */
function unchanged(before, after) {
  if (!before || !after || before.kind !== after.kind) return false
  return before.kind !== 'text' || before.text === after.text
}

/** 净变更判定与路由出口共用的两侧序列化。 */
function sideJson(side) {
  if (side && side.kind === 'text') return { kind: 'text', text: side.text }
  return { kind: 'absent' }
}

/** 在该轮的权威清单里定位本次点击的文件（相对 / 绝对 / display 三种写法）。 */
function fileIndexOf(summary, target) {
  const wanted = new Set(changeCandidates(typeof summary.cwd === 'string' ? summary.cwd : '', target).map(norm))
  for (let i = 0; i < summary.files.length; i += 1) {
    const file = summary.files[i]
    if (!file || typeof file !== 'object') continue
    if (wanted.has(norm(file.path)) || wanted.has(norm(file.display))) return i
  }
  return -1
}

/**
 * 按清单里的相对路径找回自捕获的记录。
 * 优先用 `resolve(cwd, rel)` 精确命中；cwd 规范形式有出入（软链/大小写）时，
 * 再按「以 /<rel> 结尾」兜底——绝不放宽成任意路径读盘（记录键就是我们自己捕获的绝对路径）。
 */
function pickCapture(record, cwd, rel) {
  if (!record || !record.files) return undefined
  if (typeof cwd === 'string' && cwd !== '') {
    const exact = record.files.get(norm(nodePath.resolve(cwd, rel)))
    if (exact) return exact
  }
  const suffix = '/' + norm(rel)
  for (const entry of record.files.values()) {
    if (typeof entry.key === 'string' && (entry.key === norm(rel) || entry.key.endsWith(suffix))) return entry
  }
  return undefined
}

/** 超过轮数/字节上限时淘汰最旧记录。 */
function evict(state) {
  while (state.records.size > MAX_RECORDS_PER_SESSION || state.bytes > MAX_BYTES_PER_SESSION) {
    const first = state.records.keys().next()
    if (first.done) break
    const record = state.records.get(first.value)
    state.bytes -= record ? record.bytes : 0
    state.records.delete(first.value)
  }
}

/**
 * 收尾当前轮：把捕获到的路径再读一次作为「轮结束」内容，产出净变更记录。
 * 幂等：`state.open` 置空后重复调用直接返回。
 */
async function finalize(state) {
  const open = state.open
  if (!open) return null
  state.open = null
  const files = new Map()
  let bytes = 0
  for (const cap of open.captures.values()) {
    const after = await readSide(cap.abs)
    if (unchanged(cap.before, after)) continue // 改回原样 → 不列出
    bytes += sideBytes(cap.before) + sideBytes(after)
    files.set(norm(cap.abs), { key: norm(cap.abs), abs: cap.abs, before: cap.before, after })
  }
  if (files.size > 0) {
    state.records.set(open.turn, { files, bytes })
    state.bytes += bytes
    evict(state)
  }
  return open.turn
}

/**
 * 启动一次收尾并把进行中的 Promise 挂到 state 上。
 * 收尾是异步读盘：`turn/end` 之后、记录写完之前若恰好有点击，路由要能等到同一份结果，
 * 否则会短暂误报「取不到全文」。
 */
function startFinalize(state) {
  if (!state.pending && state.open) {
    // 收尾失败只丢这一轮的记录（路由侧表现为 no-text → 扩展退回 P0），不抛出去。
    state.pending = finalize(state).then((v) => v, () => null).finally(() => { state.pending = null })
  }
  return state.pending
}

/** 轮次是否合法（正整数且在上限内）。 */
function validTurn(value) {
  const turn = Number(value)
  return Number.isSafeInteger(turn) && turn >= 1 && turn <= MAX_TURN ? turn : 0
}

/**
 * 处理一次取数：{sessionId, turn, path} → 两侧内容。
 * 只按「已记录的清单」匹配，绝不按请求里的路径直接读盘。
 */
async function handle(ctx, sessions, request) {
  let url
  try {
    url = new URL(request.url)
  } catch {
    return json(400, { error: 'bad-request' })
  }
  const query = url.searchParams
  const sessionId = query.get('sessionId') || ''
  const pathParam = query.get('path') || ''
  const turn = validTurn(query.get('turn') || '')
  if (sessionId === '' || sessionId.length > MAX_SESSION_ID) return json(400, { error: 'bad-request' })
  if (pathParam === '' || pathParam.length > MAX_PATH) return json(400, { error: 'bad-request' })
  if (turn === 0 || !/^\d+$/.test(query.get('turn') || '')) return json(400, { error: 'bad-request' })

  const state = sessions.get(sessionId)
  const seq = state ? state.seqByTurn.get(turn) : undefined
  // 会话不在内存（已释放 / dsh 重启过）与「会话在但这个轮没有记录」分开报，
  // 扩展据此给不同文案（spec 第 8 节）。
  if (seq === undefined) return json(404, { error: state ? 'no-record' : 'released' })

  const service = ctx && ctx.workspaceChanges
  if (!service || typeof service.summary !== 'function') return json(404, { error: 'unavailable' })
  const summary = service.summary(sessionId, seq)
  if (!summary || typeof summary !== 'object' || !Array.isArray(summary.files)) return json(404, { error: 'unavailable' })

  const index0 = fileIndexOf(summary, pathParam)
  if (index0 < 0) return json(200, { matched: false, turn })
  const file = summary.files[index0]
  const display = typeof file.display === 'string' ? file.display : String(file.path || '')
  const rel = typeof file.path === 'string' ? file.path : ''

  // 点击可能落在「记录已 append、turn/end 收尾还没跑完」的窗口里：等同一份收尾结果。
  const pending = state.pending
  if (pending) await pending.catch(() => {})
  if (state.open && state.open.turn === turn) await startFinalize(state)
  const entry = pickCapture(state.records.get(turn), typeof summary.cwd === 'string' ? summary.cwd : '', rel)
  // 清单里有、但我们没有两侧全文（典型：shell 直接改动，没有 write-intent 钩子）。
  if (!entry) return json(200, { matched: true, turn, display, unavailable: 'no-text' })
  if ((entry.before && entry.before.kind === 'binary') || (entry.after && entry.after.kind === 'binary')) {
    return json(200, { matched: true, turn, display, binary: true })
  }
  if ((entry.before && entry.before.kind === 'oversized') || (entry.after && entry.after.kind === 'oversized')) {
    return json(200, { matched: true, turn, display, oversized: true })
  }
  return json(200, { matched: true, turn, display, before: sideJson(entry.before), after: sideJson(entry.after) })
}

/**
 * 插件主体：按会话维护「进行中的轮捕获 / 轮→事件 seq / 轮→净变更记录」，
 * 并注册鉴权路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // 会话 id → 该会话的捕获与记录（会话 dispose 时整体丢弃）。
  const sessions = new Map()
  const stateOf = (session) => {
    const id = session && typeof session.id === 'string' ? session.id : ''
    if (id === '') return null
    let state = sessions.get(id)
    if (!state) {
      state = { open: null, pending: null, seqByTurn: new Map(), records: new Map(), bytes: 0 }
      sessions.set(id, state)
    }
    return state
  }

  ctx.on('session/event', (session, event) => {
    if (!event || typeof event.type !== 'string') return
    const state = stateOf(session)
    if (!state) return
    const data = event.data || {}
    if (event.type === 'turn/start') {
      const turn = validTurn(data.turn)
      // 上一轮没收尾（异常中断）：丢弃它的捕获，不让它污染新轮。
      if (turn) state.open = { turn, captures: new Map() }
      return
    }
    if (event.type === 'turn/end') {
      const turn = validTurn(data.turn)
      if (turn && state.open && state.open.turn === turn) startFinalize(state)
      return
    }
    if (event.type === 'workspace/changes') {
      // 同一轮可能有两条事件（turn-stopping 与 turn/end），后到者覆盖，读到最终态。
      const turn = validTurn(data.turn)
      const seq = Number(event.seq)
      if (turn && Number.isSafeInteger(seq)) state.seqByTurn.set(turn, seq)
    }
  })

  // 会话释放：连同两侧内容一起丢（dsh 自己也是这么做的，内存里不再留历史快照）。
  ctx.on('session/disposed', (session) => {
    const id = session && typeof session.id === 'string' ? session.id : ''
    if (id !== '') sessions.delete(id)
  })

  // 文件工具写入/编辑前的 waterfall（dsh 自家 recorder 钩的就是这两个同名事件）：
  // `write` 工具发 `fs/write-intent`，`edit` 工具发 `fs/edit-intent`——漏掉后者会让
  // 「先建后编」的文件取不到 before（清单里有、捕获里没有 → no-text → 扩展退 P0，
  // 未跟踪文件就只剩普通打开，用户看到「点了没变更」）。只读不写、失败不阻断工具。
  const captureBefore = async (target, actor) => {
    try {
      const session = actor && actor.agent ? actor.agent.session : undefined
      const state = stateOf(session)
      if (state && state.open) {
        let abs = ''
        try {
          abs = ctx.fs && typeof ctx.fs.processPath === 'function' ? String(ctx.fs.processPath(target) || '') : ''
        } catch {
          abs = ''
        }
        const key = norm(abs)
        if (key !== '' && !state.open.captures.has(key)) {
          const before = await readSide(abs)
          state.open.captures.set(key, { abs, before })
        }
      }
    } catch { /* 捕获失败不影响工具本身 */ }
  }
  ctx.on('fs/write-intent', async (target, actor, next) => {
    await captureBefore(target, actor)
    return next()
  }, { prepend: true })
  ctx.on('fs/edit-intent', async (target, actor, next) => {
    await captureBefore(target, actor)
    return next()
  }, { prepend: true })

  // 路由注册在 connection 的鉴权围栏内：外部（无 Cookie/令牌）拿不到文件内容。
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handle(ctx, sessions, request)
  }), 'dsh-vscode-changes: route')
}
