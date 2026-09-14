// Runs sidebar (desktop) and the run picker <select> (mobile). Runs are filterable the way an executions list is
// (state chips, free text), grouped by day, each row saying how it started and how long it took; below them the graph
// blueprints gren can run.
import { useMemo, useState } from 'react'
import { fmt } from '../api/client'
import type { GrenGraphInfo, GrenRunSummary } from '../api/types'
import type { Theme } from '../theme/tokens'
import { ellipsis, isLiveRun, runStatus } from './model'
import { Dot, Resizer } from './ui'

type Filter = 'all' | 'live' | 'needs' | 'failed' | 'done'
const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['live', 'Live'],
  ['needs', 'Needs you'],
  ['failed', 'Failed'],
  ['done', 'Done'],
]

interface Props {
  runs: GrenRunSummary[] | null
  graphs: GrenGraphInfo[]
  error: string | null
  selectedId: string | null
  selectedGraph: string | null
  onSelect: (id: string) => void
  onSelectGraph: (path: string) => void
  width: number
  onWidth: (w: number) => void
  onCommit: () => void
  theme: Theme
  rtl: boolean
}

function dayKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayLabel(key: string, iso: string): string {
  const today = dayKey(new Date().toISOString())
  const y = new Date()
  y.setDate(y.getDate() - 1)
  if (key === today) return 'Today'
  if (key === dayKey(y.toISOString())) return 'Yesterday'
  return fmt.date(iso)
}

/** How the run started, in a word: nightly (the schedule), manual (dashboard), cli, fork. */
export function triggerLabel(r: { labels?: Record<string, string> | null; forked_from?: string | null; parent?: unknown }): string {
  if (r.forked_from) return 'fork'
  const t = r.labels?.trigger
  if (t === 'schedule') return 'nightly'
  if (t === 'dashboard') return 'manual'
  if (t) return t
  return r.parent != null ? 'nested' : ''
}

function matches(r: GrenRunSummary, f: Filter): boolean {
  switch (f) {
    case 'live':
      return isLiveRun(r.status) || !!r.in_process
    case 'needs':
      return r.status === 'paused' || r.nodes.waiting > 0
    case 'failed':
      return r.status === 'failed'
    case 'done':
      return r.status === 'completed'
    default:
      return true
  }
}

export function RunsSidebar({ runs, graphs, error, selectedId, selectedGraph, onSelect, onSelectGraph, width, onWidth, onCommit, theme, rtl }: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, live: 0, needs: 0, failed: 0, done: 0 }
    for (const r of runs ?? []) for (const f of Object.keys(c) as Filter[]) if (matches(r, f)) c[f] += 1
    return c
  }, [runs])
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = (runs ?? []).filter(r => matches(r, filter) && (!s || `${r.id} ${r.graph} ${triggerLabel(r)} ${r.status} ${r.error ?? ''}`.toLowerCase().includes(s)))
    const out: { key: string; label: string; runs: GrenRunSummary[] }[] = []
    for (const r of list) {
      const key = dayKey(r.created_at)
      let g = out[out.length - 1]
      if (!g || g.key !== key) {
        g = { key, label: dayLabel(key, r.created_at), runs: [] }
        out.push(g)
      }
      g.runs.push(r)
    }
    return { list, out }
  }, [runs, filter, q])

  return (
    <aside aria-label="Runs" className="tr-side tr-desk" style={{ width }}>
      <div className="tr-side-head">
        <h2 className="tr-h2">Runs</h2>
        <span className="tr-meta">{runs ? (groups.list.length === runs.length ? `${runs.length} run${runs.length === 1 ? '' : 's'}` : `${groups.list.length} of ${runs.length}`) : 'loading…'}</span>
      </div>
      {error && (
        <div className="tr-banner" role="alert">
          Trace stream disconnected · {error}
        </div>
      )}
      {runs && runs.length > 0 && (
        <div className="tr-side-filters">
          <div role="group" aria-label="Filter runs by state" className="tr-chips">
            {FILTERS.map(([id, label]) => (
              <button key={id} type="button" className="tr-chip" aria-pressed={filter === id} onClick={() => setFilter(id)} disabled={id !== 'all' && counts[id] === 0}>
                {label}
                {id !== 'all' && counts[id] > 0 && <span className="tr-chip-n">{counts[id]}</span>}
              </button>
            ))}
          </div>
          {runs.length > 3 && <input type="search" className="tr-input tr-input--sm" placeholder="Find a run" aria-label="Find a run" value={q} onChange={e => setQ(e.target.value)} />}
        </div>
      )}
      <div className="tr-list">
        {runs && runs.length === 0 && <div className="tr-side-empty">No runs yet. “Run sweep now” starts one; the blueprint below is the graph it will follow.</div>}
        {runs && runs.length > 0 && groups.list.length === 0 && <div className="tr-side-empty">No runs match this filter.</div>}
        {groups.out.map(g => (
          <section key={g.key} aria-label={g.label}>
            <div className="tr-side-day">{g.label}</div>
            {g.runs.map(r => {
              const st = runStatus(theme, r.status)
              const live = isLiveRun(r.status)
              const trig = triggerLabel(r)
              return (
                <button key={r.id} type="button" className="tr-run" aria-pressed={r.id === selectedId} onClick={() => onSelect(r.id)} title={r.error ? ellipsis(r.error, 200) : undefined}>
                  <div className="tr-run-title">
                    <Dot color={st.dot} pulse={live} />
                    <span>{r.graph}</span>
                    {live && <span className="tr-live">live</span>}
                    {trig && <span className="tr-trig">{trig}</span>}
                  </div>
                  <div className="tr-run-id" dir="ltr">
                    {r.id}
                  </div>
                  <div className="tr-run-meta">
                    <span style={{ color: st.text }}>{r.status === 'paused' && r.nodes.waiting > 0 ? 'needs you' : st.label}</span>
                    <span>
                      {r.nodes.completed}/{r.nodes.total} nodes
                    </span>
                    {r.wall_ms != null && r.wall_ms > 0 && !live && <span>{fmt.ms(r.wall_ms)}</span>}
                    <span>{fmt.usd(r.cost_usd)}</span>
                    <span className="tr-num">{fmt.time(r.created_at)}</span>
                  </div>
                </button>
              )
            })}
          </section>
        ))}
        {graphs.length > 0 && (
          <section aria-label="Blueprints">
            <div className="tr-side-head tr-side-head--sub">
              <h2 className="tr-h2">Blueprints</h2>
              <span className="tr-meta">
                {graphs.length} graph{graphs.length === 1 ? '' : 's'}
              </span>
            </div>
            {graphs.map(g => (
              <button key={g.path} type="button" className="tr-run tr-run--bp" aria-pressed={g.path === selectedGraph} onClick={() => onSelectGraph(g.path)} title={g.goal ?? g.description ?? undefined}>
                <div className="tr-run-title">
                  <Dot color="var(--ink2)" />
                  <span>{g.name || g.path}</span>
                  {!g.ok && <span className="tr-meta">{g.errors} issue{g.errors === 1 ? '' : 's'}</span>}
                </div>
                <div className="tr-run-id" dir="ltr">
                  {g.path}
                </div>
                <div className="tr-run-meta">
                  <span>{g.nodes} nodes</span>
                  {g.budget?.max_cost_usd != null && <span>budget {fmt.usd(g.budget.max_cost_usd, 2)}</span>}
                  {g.budget?.max_width != null && <span>width {g.budget.max_width}</span>}
                </div>
              </button>
            ))}
          </section>
        )}
      </div>
      <Resizer
        label="Resize runs panel"
        orientation="vertical"
        min={220}
        max={420}
        value={width}
        toDelta={dx => (rtl ? -dx : dx)}
        grow={rtl ? 'ArrowLeft' : 'ArrowRight'}
        shrink={rtl ? 'ArrowRight' : 'ArrowLeft'}
        onChange={onWidth}
        onCommit={onCommit}
        className="tr-sep--side"
      />
    </aside>
  )
}

interface PickerProps {
  runs: GrenRunSummary[] | null
  graphs: GrenGraphInfo[]
  selectedId: string | null
  selectedGraph: string | null
  onSelect: (id: string) => void
  onSelectGraph: (path: string) => void
}

export function RunPicker({ runs, graphs, selectedId, selectedGraph, onSelect, onSelectGraph }: PickerProps) {
  const value = selectedGraph ? `graph:${selectedGraph}` : (selectedId ?? '')
  return (
    <div className="tr-picker">
      <label htmlFor="tr-run-select">Run</label>
      <select
        id="tr-run-select"
        className="tr-select"
        value={value}
        onChange={e => {
          const v = e.target.value
          if (v.startsWith('graph:')) onSelectGraph(v.slice(6))
          else if (v) onSelect(v)
        }}
      >
        {!runs?.length && !graphs.length && <option value="">{runs ? 'No runs yet' : 'Loading runs…'}</option>}
        {!!runs?.length && (
          <optgroup label="Runs">
            {runs.map(r => (
              <option key={r.id} value={r.id}>
                {r.graph} · {fmt.date(r.created_at)} {fmt.time(r.created_at)} · {r.status === 'paused' && r.nodes.waiting > 0 ? 'needs you' : r.status}
                {triggerLabel(r) ? ` · ${triggerLabel(r)}` : ''}
              </option>
            ))}
          </optgroup>
        )}
        {graphs.length > 0 && (
          <optgroup label="Blueprints">
            {graphs.map(g => (
              <option key={g.path} value={`graph:${g.path}`}>
                {g.name || g.path} · {g.nodes} nodes · not run
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  )
}
