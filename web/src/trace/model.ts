// Pure helpers for the full trace view: graph building from a GrenRun, column layout, edge geometry,
// status/kind styling, output pretty-printing, event text and a small YAML dumper. No React here.
import { fmt } from '../api/client'
import type { GrenEvent, GrenNodeKind, GrenNodeRecord, GrenRun, GrenSpecNode } from '../api/types'
import type { Theme } from '../theme/tokens'

export const NODE_W = 216
export const NODE_H = 88
export const GAP_X = 76
export const GAP_Y = 26

export interface GNode {
  id: string
  kind: GrenNodeKind
  level: number
  spec: GrenSpecNode | null
  model: string | null
}
export interface GEdge {
  from: string
  to: string
  kind: string
  data: string[]
  repair: boolean
}
export interface Box {
  x: number
  y: number
  w: number
  h: number
}
export type PosMap = Record<string, Box>
export interface Graph {
  nodes: GNode[]
  edges: GEdge[]
  levels: string[][]
  byId: Record<string, GNode>
}
export const EMPTY_GRAPH: Graph = { nodes: [], edges: [], levels: [], byId: {} }

/** Nodes in spec order with their level column, plus analysis edges (repair edges included). */
export function buildGraph(run: GrenRun): Graph {
  const specNodes = run.run.spec?.nodes ?? []
  const an = run.analysis
  const ids: string[] = []
  const seen = new Set<string>()
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  for (const n of specNodes) push(n.id)
  for (const id of an?.order ?? []) push(id)
  for (const id of Object.keys(run.nodes ?? {})) push(id)

  const specById: Record<string, GrenSpecNode> = {}
  for (const n of specNodes) specById[n.id] = n

  const levelOf: Record<string, number> = {}
  const levels: string[][] = []
  if (an?.levels?.length) {
    an.levels.forEach((col, i) => {
      levels.push(col.filter(id => seen.has(id)))
      col.forEach(id => {
        levelOf[id] = i
      })
    })
  }
  for (const id of ids) {
    if (levelOf[id] == null) {
      const l = Math.max(0, an?.nodes?.[id]?.level ?? 0)
      levelOf[id] = l
      while (levels.length <= l) levels.push([])
      levels[l].push(id)
    }
  }

  const nodes: GNode[] = ids.map(id => {
    const spec = specById[id] ?? null
    const kind = (spec?.kind ?? an?.nodes?.[id]?.kind ?? run.nodes?.[id]?.kind ?? 'code') as GrenNodeKind
    const model = an?.nodes?.[id]?.model ?? spec?.model ?? null
    return { id, kind, level: levelOf[id], spec, model }
  })
  const byId: Record<string, GNode> = {}
  for (const n of nodes) byId[n.id] = n

  const edges: GEdge[] = []
  const have = new Set<string>()
  const add = (e: GEdge) => {
    const key = `${e.from}>${e.to}:${e.kind}`
    if (have.has(key) || !byId[e.from] || !byId[e.to]) return
    have.add(key)
    edges.push(e)
  }
  for (const e of an?.edges ?? []) add({ from: e.from, to: e.to, kind: e.kind, data: e.data ?? [], repair: e.kind === 'repair' })
  for (const [from, to] of an?.repair_edges ?? []) add({ from, to, kind: 'repair', data: ['repair feedback'], repair: true })
  return { nodes, edges, levels, byId }
}

/** Column layout exactly as the prototype's layout(): columns by level, rows vertically centered per column.
 *  In RTL the columns are mirrored so the graph flows from the inline start. */
export function layout(levels: string[][], rtl: boolean): PosMap {
  const rows = Math.max(1, ...levels.map(l => l.length))
  const last = levels.length - 1
  const pos: PosMap = {}
  levels.forEach((ids, l) => {
    const total = ids.length * NODE_H + (ids.length - 1) * GAP_Y
    const off = (rows * (NODE_H + GAP_Y) - total) / 2
    const col = rtl ? last - l : l
    ids.forEach((id, i) => {
      pos[id] = { x: col * (NODE_W + GAP_X), y: off + i * (NODE_H + GAP_Y), w: NODE_W, h: NODE_H }
    })
  })
  return pos
}

/** Cubic bezier from the source's mid inline-end to the target's mid inline-start (±44 px handles); repair edges arc over the top. */
export function edgePath(f: Box, t: Box, repair: boolean, rtl: boolean): string {
  if (repair) return `M${f.x + f.w / 2},${f.y} C${f.x + f.w / 2},${f.y - 70} ${t.x + t.w / 2},${t.y - 70} ${t.x + t.w / 2},${t.y}`
  if (rtl) return `M${f.x},${f.y + f.h / 2} C${f.x - 44},${f.y + f.h / 2} ${t.x + t.w + 44},${t.y + t.h / 2} ${t.x + t.w},${t.y + t.h / 2}`
  return `M${f.x + f.w},${f.y + f.h / 2} C${f.x + f.w + 44},${f.y + f.h / 2} ${t.x - 44},${t.y + t.h / 2} ${t.x},${t.y + t.h / 2}`
}

/** Ancestors + descendants of a node through non-repair edges (plus the node itself). */
export function relatedSet(sel: string | null, edges: GEdge[]): Set<string> {
  const rel = new Set<string>()
  if (!sel) return rel
  rel.add(sel)
  const walk = (id: string, up: boolean) => {
    for (const e of edges) {
      if (e.repair) continue
      const nx = up ? (e.to === id ? e.from : null) : e.from === id ? e.to : null
      if (nx && !rel.has(nx)) {
        rel.add(nx)
        walk(nx, up)
      }
    }
  }
  walk(sel, true)
  walk(sel, false)
  return rel
}

export interface StatusStyle {
  dot: string
  text: string
  label: string
  pulse: boolean
}

/** Node status → dot color, text color (never alpha-faded), label and whether it pulses. */
export function nodeStatus(t: Theme, s: string | undefined | null): StatusStyle {
  switch (s) {
    case 'completed':
      return { dot: t.ok, text: t.ok, label: 'completed', pulse: false }
    case 'running':
      return { dot: t.primary, text: t.primary, label: 'running', pulse: true }
    case 'failed':
      return { dot: t.critical, text: t.critical, label: 'failed', pulse: false }
    case 'waiting_approval':
      return { dot: t.amberLine, text: t.amberLine, label: 'waiting approval', pulse: true }
    case 'waiting_task':
      return { dot: t.amberLine, text: t.amberLine, label: 'waiting task', pulse: true }
    case 'skipped':
      return { dot: t.faint, text: t.ink2, label: 'skipped', pulse: false }
    default:
      return { dot: t.faint, text: t.ink2, label: s || 'pending', pulse: false }
  }
}

export function runStatus(t: Theme, s: string | undefined | null): StatusStyle {
  switch (s) {
    case 'running':
      return { dot: t.primary, text: t.primary, label: 'running', pulse: true }
    case 'paused':
      return { dot: t.amberLine, text: t.amberLine, label: 'paused', pulse: true }
    case 'completed':
      return { dot: t.ok, text: t.ok, label: 'completed', pulse: false }
    case 'failed':
      return { dot: t.critical, text: t.critical, label: 'failed', pulse: false }
    case 'cancelled':
      return { dot: t.faint, text: t.ink2, label: 'cancelled', pulse: false }
    default:
      return { dot: t.faint, text: t.ink2, label: s || 'created', pulse: false }
  }
}

export const isWaiting = (s: string | undefined | null) => s === 'waiting_approval' || s === 'waiting_task'
export const isLiveRun = (s: string | undefined | null) => s === 'running' || s === 'paused' || s === 'created'

/** Node ids currently waiting on a gate or task. */
export function waitingGates(run: GrenRun | null): string[] {
  if (!run) return []
  return Object.values(run.nodes ?? {})
    .filter(r => isWaiting(r.status))
    .map(r => r.id)
}

/** metrics.critical_path.nodes when available, else analysis.critical_path.nodes. */
export function criticalNodes(run: GrenRun | null): string[] {
  if (!run) return []
  const m = run.metrics?.critical_path?.nodes
  if (m && m.length) return m
  return run.analysis?.critical_path?.nodes ?? []
}

/** Engine outputs are often JSON strings; turn them back into values ("null" → null). */
export function parseOutput(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const s = v.trim()
  if (s === 'null' || s === '') return null
  if (s.startsWith('{') || s.startsWith('[') || s.startsWith('"')) {
    try {
      return JSON.parse(s)
    } catch {
      return v
    }
  }
  return v
}

export function pretty(v: unknown): string {
  const p = parseOutput(v)
  if (p === undefined) return ''
  if (typeof p === 'string') return p
  try {
    return JSON.stringify(p, null, 2) ?? String(p)
  } catch {
    return String(p)
  }
}

export function ellipsis(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, Math.max(1, n - 1)) + '…' : one
}

export const modelShort = (m: string | null | undefined) => (m ? m.replace(/^claude-/, '') : '')

function moduleName(spec: GrenSpecNode | null): string {
  const m = spec?.module ?? spec?.fn ?? spec?.run
  if (typeof m !== 'string') return ''
  return m.split(/[\\/]/).pop() ?? ''
}

/** Card sub line: model (without "claude-"), "map", tools, "side-effect". Code nodes show their module. */
export function nodeSub(n: GNode): string {
  const parts: string[] = []
  const m = modelShort(n.model)
  if (m) parts.push(m)
  else {
    parts.push(n.kind)
    const mod = moduleName(n.spec)
    if (mod) parts.push(mod)
  }
  if (n.spec?.map) parts.push('map')
  if (n.spec?.tools?.length) parts.push(n.spec.tools.join(', '))
  if (n.spec?.side_effect) parts.push('side-effect')
  return parts.join(' · ')
}

/** Inspector sub line: longer wording than the card. */
export function inspectorSub(n: GNode): string {
  const parts: string[] = []
  const m = modelShort(n.model)
  const mod = moduleName(n.spec)
  if (m) parts.push(m)
  else if (n.kind === 'code') parts.push(mod ? `deterministic · ${mod}` : 'deterministic')
  if (n.spec?.tools?.length) parts.push('tools: ' + n.spec.tools.join(', '))
  if (n.spec?.map) parts.push(`map over ${String(n.spec.map)}`)
  if (n.spec?.side_effect) parts.push('side effect · at most once')
  if (n.spec?.requires_gate) parts.push('after gate ' + (Array.isArray(n.spec.requires_gate) ? n.spec.requires_gate.join(', ') : String(n.spec.requires_gate)))
  return parts.join(' · ')
}

/** Monospace badge on the card: items, kills, attempts, "awaiting approval", skip reason. */
export function nodeBadge(rec: GrenNodeRecord | undefined, n: GNode): string {
  if (!rec) return ''
  if (rec.status === 'waiting_approval') return 'awaiting approval'
  if (rec.status === 'waiting_task') return 'awaiting task'
  if (rec.status === 'skipped') return rec.skip_reason ? ellipsis(rec.skip_reason, 28) : 'skipped'
  if (rec.status === 'failed' && rec.error) return ellipsis(rec.error, 28)
  if (n.kind === 'verify' && rec.verify) {
    const v = rec.verify
    const total = v.total ?? 0
    const killed = v.killed?.length || Math.round((v.kill_rate ?? 0) * total)
    if (total > 0) return `${killed}/${total} killed`
    if (v.kill_rate != null) return `${Math.round(v.kill_rate * 100)}% killed`
  }
  if (rec.items && rec.items.length) {
    const done = rec.items.filter(i => i.status === 'completed').length
    return `${done}/${rec.items.length} items`
  }
  if (n.kind === 'gate' && rec.gate?.decision) return `${rec.gate.decision}${rec.gate.by ? ' · ' + rec.gate.by : ''}`
  if (rec.attempts && rec.attempts.length > 1) return `${rec.attempts.length} attempts`
  if (rec.side_effect_done) return 'side-effect done'
  return ''
}

export function tokensOf(rec: GrenNodeRecord | undefined): number {
  const u = rec?.usage ?? {}
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
}

export function kfmt(n: number | null | undefined): string {
  if (n == null) return '—'
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(n))
}

export const pct = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? '—' : `${Math.round(v * 100)}%`)

/** Bottom-end text on the card: duration · cost once done, live elapsed while running or waiting. */
export function nodeRight(rec: GrenNodeRecord | undefined, now: number): string {
  if (!rec) return ''
  if (rec.status === 'running' && rec.started_at) return fmt.ms(Math.max(0, now - Date.parse(rec.started_at)))
  if (isWaiting(rec.status) && rec.gate?.requested_at) return 'waiting ' + fmt.ms(Math.max(0, now - Date.parse(rec.gate.requested_at)))
  if (rec.status === 'completed' || rec.status === 'failed') return fmt.ms(rec.duration_ms) + (rec.cost_usd ? ' · ' + fmt.usd(rec.cost_usd) : '')
  return ''
}

export function nodeDuration(rec: GrenNodeRecord | undefined, now: number): string {
  if (!rec) return '—'
  if (rec.duration_ms != null) return fmt.ms(rec.duration_ms)
  if (rec.status === 'running' && rec.started_at) return fmt.ms(Math.max(0, now - Date.parse(rec.started_at))) + ' so far'
  return '—'
}

/** The "structured output" block of the inspector. */
export function nodeOutputText(rec: GrenNodeRecord | undefined, n: GNode): string {
  if (!rec) return '(no data for this node yet)'
  if (rec.items && rec.items.length) {
    if (rec.outputs && rec.outputs.length) return pretty(rec.outputs)
    if (rec.items.some(i => i.output !== undefined)) return pretty(rec.items.map(i => ({ index: i.index, status: i.status, output: i.output, error: i.error })))
  }
  const out = parseOutput(rec.output)
  if (n.kind === 'gate') {
    if (isWaiting(rec.status)) return '(awaiting approval)' + (rec.gate ? '\n' + pretty(rec.gate) : '')
    if (rec.gate) return pretty(out != null ? { ...rec.gate, output: out } : rec.gate)
  }
  if (n.kind === 'verify' && rec.verify) return pretty(out != null && typeof out === 'object' ? { ...rec.verify, ...(out as object) } : rec.verify)
  if (out != null) return pretty(out)
  if (rec.status === 'skipped') return `(skipped${rec.skip_reason ? ' · ' + rec.skip_reason : ''})`
  if (rec.status === 'pending') return '(not run)'
  if (rec.status === 'running') return '(running · no output yet)'
  if (rec.status === 'failed') return rec.error ? `(failed)\n${rec.error}` : '(failed)'
  return '(no output)'
}

// ------------------------------------------------------------------------------------------------ events

export type Tone = 'critical' | 'ok' | 'amber' | 'muted'

export function eventTone(type: string): Tone {
  if (/kill|reject|fail|cancel/.test(type)) return 'critical'
  if (/finished|completed|approved|executed/.test(type)) return 'ok'
  if (/waiting|paused|repair|reset|retry/.test(type)) return 'amber'
  return 'muted'
}

/** HH:MM:SS in the viewer's zone; ISO passthrough when unparsable. */
export function hms(iso: string | undefined | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
}

type D = Record<string, unknown>
const str = (d: D, k: string): string | null => {
  const v = d[k]
  return v == null ? null : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null
}
const num = (d: D, k: string): number | null => (typeof d[k] === 'number' ? (d[k] as number) : null)
const arr = (d: D, k: string): unknown[] => (Array.isArray(d[k]) ? (d[k] as unknown[]) : [])
const join = (parts: (string | null | undefined | false)[]) => parts.filter((p): p is string => !!p).join(' · ')
const label = (k: string, v: number | null, unit = '') => (v == null ? null : `${k} ${v}${unit}`)

function compact(d: D): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(d)) {
    if (v == null) continue
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    parts.push(`${k}=${ellipsis(s, 60)}`)
  }
  return ellipsis(parts.join(' '), 200)
}

/** One line of text per event, derived from event.data. */
export function eventText(ev: GrenEvent): string {
  const d: D = ev.data ?? {}
  let text = ''
  switch (ev.type) {
    case 'run.started':
      text = join([str(d, 'graph') && 'graph ' + str(d, 'graph'), str(d, 'bridge') && 'bridge ' + str(d, 'bridge'), label('', num(d, 'nodes'), ' nodes')?.trim(), num(d, 'critical_path_est_ms') != null && 'est ' + fmt.ms(num(d, 'critical_path_est_ms'))])
      break
    case 'node.started':
      text = join([str(d, 'kind'), label('repair round', num(d, 'repair_round'))])
      break
    case 'call.started':
      text = join([label('attempt', num(d, 'attempt')), str(d, 'model'), str(d, 'bridge'), str(d, 'role')])
      break
    case 'call.finished':
      text = join([d.ok === false ? 'error' : 'ok', fmt.ms(num(d, 'duration_ms')), num(d, 'cost_usd') != null && fmt.usd(num(d, 'cost_usd')), str(d, 'model'), str(d, 'error')])
      break
    case 'code.executed': {
      const st = d.stats as D | undefined
      text = join([fmt.ms(num(d, 'duration_ms')), st && num(st, 'in') != null && `in ${num(st, 'in')} · out ${num(st, 'out')}`])
      break
    }
    case 'node.completed':
      text = join([fmt.ms(num(d, 'duration_ms')), num(d, 'cost_usd') ? fmt.usd(num(d, 'cost_usd')) : null, typeof d.items === 'number' && `${d.items} items`])
      break
    case 'node.skipped':
      text = str(d, 'reason') ?? str(d, 'skip_reason') ?? 'skipped'
      break
    case 'node.failed':
      text = str(d, 'error') ?? 'failed'
      break
    case 'node.retry':
      text = join([label('attempt', num(d, 'attempt')), str(d, 'error')])
      break
    case 'node.reset':
      text = str(d, 'reason') ?? 'reset'
      break
    case 'item.started':
      text = ev.item != null ? `item ${ev.item}` : ''
      break
    case 'item.completed':
      text = join([ev.item != null && `item ${ev.item}`, fmt.ms(num(d, 'duration_ms'))])
      break
    case 'item.failed':
      text = join([ev.item != null && `item ${ev.item}`, str(d, 'error') ?? 'failed'])
      break
    case 'fanout.started':
      text = join([label('', num(d, 'total'), ' items')?.trim(), label('width', num(d, 'width'))])
      break
    case 'fanout.finished':
      text = join([`${num(d, 'completed') ?? 0}/${num(d, 'total') ?? 0} completed`, num(d, 'failed') ? `${num(d, 'failed')} failed` : null, label('quorum', num(d, 'quorum'))])
      break
    case 'verify.kill': {
      const r = arr(d, 'reasons')
      text = (typeof r[0] === 'string' ? r[0] : null) ?? str(d, 'reason') ?? 'killed'
      break
    }
    case 'verify.finished':
      text = join([`${num(d, 'killed') ?? 0}/${num(d, 'total') ?? 0} killed`, 'rate ' + pct(num(d, 'kill_rate'))])
      break
    case 'repair.scheduled':
      text = join([label('round', num(d, 'round')), str(d, 'producer') && '→ ' + str(d, 'producer'), arr(d, 'reset').length ? `reset ${arr(d, 'reset').length} nodes` : null])
      break
    case 'route.selected':
      text = join(['→ ' + (str(d, 'to') ?? str(d, 'route') ?? str(d, 'selected') ?? '?'), str(d, 'reason')])
      break
    case 'gate.waiting':
      text = str(d, 'title') ?? str(d, 'prompt') ?? 'awaiting approval'
      break
    case 'gate.approved':
    case 'gate.rejected':
      text = join([str(d, 'by') && 'by ' + str(d, 'by'), str(d, 'decision'), str(d, 'comment')])
      break
    case 'side_effect.executed':
      text = join([str(d, 'kind'), str(d, 'detail'), str(d, 'description')]) || 'side effect executed'
      break
    case 'run.paused':
      text = join([str(d, 'reason'), str(d, 'gate') && 'gate ' + str(d, 'gate'), str(d, 'node') && 'node ' + str(d, 'node')]) || 'paused'
      break
    case 'run.resumed':
      text = join([str(d, 'by') && 'by ' + str(d, 'by'), str(d, 'from') && 'from ' + str(d, 'from')]) || 'resumed'
      break
    case 'run.completed':
      text = join([num(d, 'cost_usd') != null && fmt.usd(num(d, 'cost_usd')), num(d, 'wall_ms') != null && fmt.ms(num(d, 'wall_ms')), num(d, 'human_wait_ms') ? 'human wait ' + fmt.ms(num(d, 'human_wait_ms')) : null])
      break
    case 'run.failed':
    case 'run.cancelled':
      text = str(d, 'error') ?? str(d, 'reason') ?? ev.type.split('.')[1]
      break
    default:
      text = ''
  }
  return text || compact(d)
}

// ------------------------------------------------------------------------------------------------ yaml

function isScalar(v: unknown): boolean {
  if (v == null || typeof v !== 'object') return true
  if (Array.isArray(v)) return v.length === 0
  return Object.keys(v as object).length === 0
}
function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return /^[\w.$@/:-]+$/.test(v) && !/^(true|false|null|-?\d+(\.\d+)?)$/.test(v) ? v : JSON.stringify(v)
  if (typeof v === 'object') return Array.isArray(v) ? '[]' : '{}'
  return String(v)
}

/** YAML-ish dump of a spec node (or any JSON value). Multi-line strings become block scalars. */
export function toYaml(v: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  if (isScalar(v)) return pad + yamlScalar(v)
  if (Array.isArray(v)) {
    return v
      .map(x => {
        const body = toYaml(x, indent + 1)
        return pad + '- ' + body.slice(pad.length + 2)
      })
      .join('\n')
  }
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => {
      if (typeof x === 'string' && x.includes('\n')) return `${pad}${k}: |\n${x.split('\n').map(l => pad + '  ' + l).join('\n')}`
      if (isScalar(x)) return `${pad}${k}: ${yamlScalar(x)}`
      return `${pad}${k}:\n${toYaml(x, indent + 1)}`
    })
    .join('\n')
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : 'request failed'
}

export async function copyText(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = s
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
