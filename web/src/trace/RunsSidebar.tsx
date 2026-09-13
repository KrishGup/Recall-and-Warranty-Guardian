// Runs sidebar (desktop) and the run picker <select> (mobile): every recorded run, then the graph blueprints gren can
// run (shown as a pending graph with its YAML before anything has executed).
import { fmt } from '../api/client'
import type { GrenGraphInfo, GrenRunSummary } from '../api/types'
import type { Theme } from '../theme/tokens'
import { isLiveRun, runStatus } from './model'
import { Dot, Resizer } from './ui'

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

export function RunsSidebar({ runs, graphs, error, selectedId, selectedGraph, onSelect, onSelectGraph, width, onWidth, onCommit, theme, rtl }: Props) {
  return (
    <aside aria-label="Runs" className="tr-side tr-desk" style={{ width }}>
      <div className="tr-side-head">
        <h2 className="tr-h2">Runs</h2>
        <span className="tr-meta">{runs ? `${runs.length} run${runs.length === 1 ? '' : 's'}` : 'loading…'}</span>
      </div>
      {error && (
        <div className="tr-banner" role="alert">
          Trace stream disconnected · {error}
        </div>
      )}
      <div className="tr-list">
        {runs && runs.length === 0 && <div className="tr-side-empty">No runs yet. “Run sweep now” starts one; the blueprint below is the graph it will follow.</div>}
        {runs?.map(r => {
          const st = runStatus(theme, r.status)
          const live = isLiveRun(r.status)
          return (
            <button key={r.id} type="button" className="tr-run" aria-pressed={r.id === selectedId} onClick={() => onSelect(r.id)}>
              <div className="tr-run-title">
                <Dot color={st.dot} pulse={live} />
                <span>{r.graph}</span>
                {live && <span className="tr-live">live</span>}
                {r.parent != null && <span className="tr-meta">fork</span>}
              </div>
              <div className="tr-run-id" dir="ltr">
                {r.id}
              </div>
              <div className="tr-run-meta">
                <span style={{ color: st.text }}>{st.label}</span>
                <span>
                  {r.nodes.completed}/{r.nodes.total} nodes
                </span>
                <span>{fmt.usd(r.cost_usd)}</span>
                <span className="tr-num">{fmt.time(r.created_at)}</span>
              </div>
            </button>
          )
        })}
        {graphs.length > 0 && (
          <section aria-label="Blueprints">
            <div className="tr-side-head tr-side-head--sub">
              <h2 className="tr-h2">Blueprints</h2>
              <span className="tr-meta">
                {graphs.length} graph{graphs.length === 1 ? '' : 's'}
              </span>
            </div>
            {graphs.map(g => (
              <button key={g.path} type="button" className="tr-run tr-run--bp" aria-pressed={g.path === selectedGraph} onClick={() => onSelectGraph(g.path)} title={g.description ?? g.goal ?? undefined}>
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
                  {g.budget?.max_cost_usd != null && <span>budget {fmt.usd(g.budget.max_cost_usd)}</span>}
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
                {r.graph} · {fmt.date(r.created_at)} {fmt.time(r.created_at)} · {r.status}
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
