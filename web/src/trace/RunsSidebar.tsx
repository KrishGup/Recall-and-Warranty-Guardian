// Runs sidebar (desktop) and the run picker <select> (mobile).
import { fmt } from '../api/client'
import type { GrenRunSummary } from '../api/types'
import type { Theme } from '../theme/tokens'
import { isLiveRun, runStatus } from './model'
import { Dot, Resizer } from './ui'

interface Props {
  runs: GrenRunSummary[] | null
  error: string | null
  selectedId: string | null
  onSelect: (id: string) => void
  width: number
  onWidth: (w: number) => void
  onCommit: () => void
  theme: Theme
  rtl: boolean
}

export function RunsSidebar({ runs, error, selectedId, onSelect, width, onWidth, onCommit, theme, rtl }: Props) {
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
        {runs && runs.length === 0 && <div className="tr-side-empty">No runs yet. “Run sweep now” starts one.</div>}
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

export function RunPicker({ runs, selectedId, onSelect }: { runs: GrenRunSummary[] | null; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="tr-picker">
      <label htmlFor="tr-run-select">Run</label>
      <select id="tr-run-select" className="tr-select" value={selectedId ?? ''} onChange={e => onSelect(e.target.value)}>
        {!runs?.length && <option value="">{runs ? 'No runs yet' : 'Loading runs…'}</option>}
        {runs?.map(r => (
          <option key={r.id} value={r.id}>
            {r.graph} · {fmt.date(r.created_at)} {fmt.time(r.created_at)} · {r.status}
          </option>
        ))}
      </select>
    </div>
  )
}
