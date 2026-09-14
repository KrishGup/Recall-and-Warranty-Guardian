// Timeline panel (a Gantt, the way Kestra shows an execution): one row per node in execution order, a bar from the
// node's start to its end, or to now while it runs or waits, on an axis that begins at the run's first node. Bars take
// the node's kind color; a failed node is critical red, a node waiting on a human is amber and hatched. A repaired or
// retried node shows each attempt as a thin marker under its bar. A blueprint shows the estimated timeline from gren's
// analysis: nodes in one level run in parallel, a level takes as long as its slowest node.
import { useMemo } from 'react'
import { fmt } from '../api/client'
import type { GrenRun } from '../api/types'
import { kindColors, type Theme } from '../theme/tokens'
import { isBlueprint } from './blueprint'
import { hms, isWaiting, nodeStatus, type Graph } from './model'
import { Dot } from './ui'

interface Props {
  run: GrenRun | null
  graph: Graph
  sel: string | null
  onSelect: (id: string) => void
  theme: Theme
  now: number
}

interface Row {
  id: string
  kind: string
  status: string
  start: number | null
  end: number | null
  live: boolean
  meta: string
  attempts: { s: number; e: number; ok: boolean }[]
  note: string
}

const ts = (iso?: string | null): number | null => {
  if (!iso) return null
  const v = Date.parse(iso)
  return Number.isNaN(v) ? null : v
}

function buildRows(run: GrenRun, graph: Graph, now: number): { rows: Row[]; t0: number; t1: number; est: boolean } {
  const est = isBlueprint(run)
  const order = graph.levels.length ? graph.levels.flat() : graph.nodes.map(n => n.id)
  const rows: Row[] = []
  if (est) {
    let cursor = 0
    for (const level of graph.levels) {
      let widest = 0
      for (const id of level) {
        const e = run.analysis?.nodes?.[id]?.est_ms ?? 0
        const cost = run.analysis?.nodes?.[id]?.est_cost_usd ?? 0
        rows.push({ id, kind: graph.byId[id]?.kind ?? 'code', status: 'estimate', start: cursor, end: cursor + e, live: false, meta: cost ? `about ${fmt.usd(cost)}` : 'no model cost', attempts: [], note: '' })
        widest = Math.max(widest, e)
      }
      cursor += widest
    }
    return { rows, t0: 0, t1: Math.max(1, cursor), est }
  }
  let t0 = ts(run.run.started_at) ?? Number.POSITIVE_INFINITY
  let t1 = 0
  for (const id of order) {
    const rec = run.nodes[id]
    const kind = graph.byId[id]?.kind ?? rec?.kind ?? 'code'
    const start = ts(rec?.started_at)
    const live = rec?.status === 'running' || isWaiting(rec?.status)
    const end = ts(rec?.ended_at) ?? (live ? now : start != null && rec?.duration_ms != null ? start + rec.duration_ms : null)
    if (start != null) t0 = Math.min(t0, start)
    if (end != null) t1 = Math.max(t1, end)
    const attempts = (rec?.attempts ?? [])
      .map(a => {
        const s = ts(a.started_at) ?? 0
        return { s, e: ts(a.ended_at) ?? s + (a.duration_ms ?? 0), ok: a.status === 'ok' }
      })
      .filter(a => a.s > 0)
    const parts: string[] = []
    if (rec?.items?.length) parts.push(`${rec.items.filter(i => i.status === 'completed').length}/${rec.items.length} items`)
    if (attempts.length > 1) parts.push(`${attempts.length} attempts`)
    if (rec?.repairs) parts.push(`${rec.repairs} repair${rec.repairs === 1 ? '' : 's'}`)
    const note = rec?.status === 'skipped' ? (rec.skip_reason ? `skipped: ${rec.skip_reason}` : 'skipped') : rec?.status === 'pending' || !rec ? 'did not run' : ''
    rows.push({ id, kind, status: rec?.status ?? 'pending', start, end, live, meta: parts.join(' · '), attempts, note })
  }
  if (!Number.isFinite(t0)) t0 = ts(run.run.created_at) ?? now
  return { rows, t0, t1: Math.max(t0 + 1, t1), est }
}

export function TimelinePanel({ run, graph, sel, onSelect, theme, now }: Props) {
  const data = useMemo(() => (run ? buildRows(run, graph, now) : null), [run, graph, now])
  if (!run || !data) return <p className="tr-empty">Select a run to see when each node ran.</p>
  if (!data.rows.length) return <p className="tr-empty">No nodes in this graph.</p>
  const { rows, t0, t1, est } = data
  const span = t1 - t0
  const kinds = kindColors(theme) as Record<string, { c: string; ink: string; label: string }>
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / span) * 100))}%`
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ f, label: f === 0 ? (est ? '0' : hms(new Date(t0).toISOString())) : `+${fmt.ms(span * f)}` }))
  const liveRun = rows.some(r => r.live)
  return (
    <div className="tr-gantt" aria-label={est ? 'Estimated timeline' : 'Timeline'}>
      <div className="tr-gantt-head">
        <span className="tr-gantt-label tr-eyebrow">{est ? 'Estimated order' : 'Node'}</span>
        <span className="tr-gantt-track tr-gantt-axis" aria-hidden="true">
          {ticks.map(t => (
            <span key={t.f} className={`tr-gantt-tick tr-num${t.f === 1 ? ' tr-gantt-tick--end' : ''}${t.f === 0.25 || t.f === 0.75 ? ' tr-gantt-tick--mid' : ''}`} style={{ insetInlineStart: pct(span * t.f) }}>
              {t.label}
            </span>
          ))}
        </span>
        <span className="tr-gantt-dur tr-eyebrow">{est ? 'estimate' : 'took'}</span>
      </div>
      <ol className="tr-gantt-rows">
        {rows.map(r => {
          const st = est ? { dot: theme.faint, text: theme.ink2, label: 'estimate', pulse: false } : nodeStatus(theme, r.status)
          const k = kinds[r.kind] ?? kinds.code
          let bg = k.c
          let cls = 'tr-gantt-bar'
          if (est) cls += ' tr-gantt-bar--est'
          else if (r.status === 'failed') bg = theme.critical
          else if (isWaiting(r.status)) {
            bg = theme.amberLine
            cls += ' tr-gantt-bar--wait'
          } else if (r.status === 'running') {
            bg = theme.primary
            cls += ' tr-gantt-bar--live'
          }
          const has = r.start != null && r.end != null
          const dur = has ? fmt.ms((r.end as number) - (r.start as number)) : '—'
          return (
            <li key={r.id}>
              <button type="button" className="tr-gantt-row" aria-pressed={sel === r.id} onClick={() => onSelect(r.id)} aria-label={`${r.id}, ${st.label}, ${dur}`}>
                <span className="tr-gantt-label">
                  <Dot color={st.dot} pulse={st.pulse} />
                  <b>{r.id}</b>
                  <span className="tr-gantt-meta">{[est ? k.label.split(' · ')[0] : st.label, r.meta].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="tr-gantt-track">
                  {has && <span className={cls} style={{ insetInlineStart: pct((r.start as number) - t0), width: `max(3px, ${pct((r.end as number) - (r.start as number))})`, background: bg }} />}
                  {r.attempts.length > 1 &&
                    r.attempts.map((a, i) => <span key={i} className={`tr-gantt-att${a.ok ? '' : ' tr-gantt-att--bad'}`} style={{ insetInlineStart: pct(a.s - t0), width: `max(2px, ${pct(a.e - a.s)})` }} title={`attempt ${i + 1}: ${fmt.ms(a.e - a.s)}${a.ok ? '' : ' (failed)'}`} />)}
                  {!has && <span className="tr-gantt-none">{r.note}</span>}
                </span>
                <span className="tr-gantt-dur tr-num">{dur}</span>
              </button>
            </li>
          )
        })}
      </ol>
      <div className="tr-gantt-foot">
        {est
          ? 'Estimates come from gren’s analysis of the spec. Nodes in the same level run in parallel; a level takes as long as its slowest node.'
          : liveRun
            ? 'Bars grow while a node runs or waits. Amber is time spent waiting on a person; it is kept out of the wall-clock speedup.'
            : 'Bars take the node’s kind color. Red failed, amber waited on a person, thin marks are attempts.'}
      </div>
    </div>
  )
}
