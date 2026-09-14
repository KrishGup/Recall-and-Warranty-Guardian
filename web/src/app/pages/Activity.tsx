// Activity: every sweep, including the ones that found nothing. Per-night containers from GET /api/activity?days=7.
// Rows that share a run_id fold into one run block (a nightly sweep, a receipt intake) with the run's outcome as
// its headline and the steps beneath; household actions and other one-off rows stay as single timeline entries.
import { Link } from 'react-router-dom'
import { Api } from '../../api/client'
import type { ActivityNight, ActivityRow, Tone } from '../../api/types'
import { ErrorNote, Skeleton, Status } from '../../ui/primitives'
import { plural, toneVar } from '../format'
import { useShell } from '../shell/ShellContext'
import { useAsync } from '../shell/useAsync'

export function Activity() {
  const { dataVersion } = useShell()
  const res = useAsync(() => Api.activity(7), [dataVersion])
  const nights = res.data?.nights ?? []
  return (
    <>
      <div className="g-page__head">
        <div>
          <h1 className="g-h1" style={{ marginBottom: 4 }}>
            Activity
          </h1>
          <p className="g-sub" style={{ margin: 0 }}>
            Every sweep is logged, including the ones that found nothing.
          </p>
        </div>
        <Link to="/flow" className="g-link">
          How last night ran{' '}
          <span aria-hidden="true" className="g-arrow">
            →
          </span>
        </Link>
      </div>
      {res.error && !res.data && <ErrorNote message={res.error} onRetry={res.reload} />}
      {res.loading && !res.data && (
        <div className="g-nights" aria-busy="true">
          {[0, 1].map(i => (
            <div key={i} className="g-card g-card--pad" aria-hidden="true">
              <Skeleton w={140} h={18} style={{ marginBottom: 12 }} />
              <Skeleton h={14} style={{ marginBottom: 8 }} />
              <Skeleton w="80%" h={14} />
            </div>
          ))}
        </div>
      )}
      {res.data && nights.length === 0 && <div className="g-card g-card--dashed g-empty">No activity in the last 7 days.</div>}
      <div className="g-nights" aria-busy={res.refreshing}>
        {nights.map((n, i) => (
          <Night key={n.date} night={n} latest={i === 0} />
        ))}
      </div>
    </>
  )
}

// ---- grouping

type Entry = { kind: 'run'; id: string; rows: ActivityRow[] } | { kind: 'row'; row: ActivityRow }

/** Fold rows (newest first) into run blocks keyed by run_id, keeping the position of each run's first appearance. */
function groupRows(rows: ActivityRow[]): Entry[] {
  const out: Entry[] = []
  const byRun = new Map<string, Extract<Entry, { kind: 'run' }>>()
  for (const r of rows) {
    if (!r.run_id) {
      out.push({ kind: 'row', row: r })
      continue
    }
    let g = byRun.get(r.run_id)
    if (!g) {
      g = { kind: 'run', id: r.run_id, rows: [] }
      byRun.set(r.run_id, g)
      out.push(g)
    }
    g.rows.push(r)
  }
  return out
}

function runKind(id: string): string {
  if (id.startsWith('intake')) return 'Receipt intake'
  if (id.startsWith('nightly-sweep')) return 'Nightly sweep'
  return id.replace(/-\d{8}-\d{6}-[0-9a-f]+$/, '').replace(/-/g, ' ')
}

/** The run's outcome row is the Guardian/Intake line that names the result ("Sweep complete", "Intake failed"). */
function outcomeOf(rows: ActivityRow[]): ActivityRow | null {
  return rows.find(r => (r.source === 'Guardian' || r.source === 'Intake') && /^(Sweep|Intake|Late-approval run)\b/.test(r.text)) ?? null
}

function costOf(rows: ActivityRow[]): number {
  let total = 0
  for (const r of rows) {
    const m = r.result?.match(/\$(\d+(?:\.\d+)?)/g)
    if (m) for (const s of m) total += Number(s.slice(1))
  }
  return total
}

// ---- rendering

function Night({ night, latest }: { night: ActivityNight; latest: boolean }) {
  const entries = groupRows(night.rows)
  const runs = entries.filter(e => e.kind === 'run').length
  const failed = entries.filter(e => e.kind === 'run' && outcomeOf(e.rows)?.tone === 'critical').length
  const actions = entries.filter(e => e.kind === 'row' && e.row.source === 'Household').length
  const meta = [runs > 0 && plural(runs, 'run'), failed > 0 && `${failed} failed`, actions > 0 && plural(actions, 'household action')].filter(Boolean).join(' · ')
  let firstRun = true
  return (
    <section aria-label={night.label} className="g-card g-night">
      <div className="g-night__head">
        <div style={{ minWidth: 0 }}>
          <h2 className="g-night__title">{night.label}</h2>
          {meta && <div className="g-night__meta g-ui g-muted">{meta}</div>}
        </div>
        <Status color={toneVar(night.tone)}>{night.summary}</Status>
      </div>
      <ol className="g-night__rows">
        {entries.length === 0 && (
          <li className="g-small g-muted" style={{ padding: '10px 0' }}>
            Nothing logged.
          </li>
        )}
        {entries.map(e => {
          if (e.kind === 'row') return <RowEntry key={`${e.row.at}-${e.row.text}`} row={e.row} />
          const open = latest && firstRun
          firstRun = false
          return <RunEntry key={e.id} id={e.id} rows={e.rows} defaultOpen={open} />
        })}
      </ol>
    </section>
  )
}

function RunEntry({ id, rows, defaultOpen }: { id: string; rows: ActivityRow[]; defaultOpen: boolean }) {
  const outcome = outcomeOf(rows)
  const steps = rows.filter(r => r !== outcome)
  const started = rows[rows.length - 1]
  const tone: Tone = outcome ? outcome.tone : 'muted'
  const headline = outcome ? outcome.text.replace(/^Sweep /, '').replace(/^Intake /, '') : 'in progress'
  const cost = costOf(rows)
  const failed = tone === 'critical' && !!outcome && /failed/i.test(outcome.text)
  return (
    <li className={`g-act g-act--run${failed ? ' is-failed' : ''}`}>
      <details open={defaultOpen} className="g-act__details">
        <summary className="g-act__head">
          <time dateTime={started.at} className="g-act__time">
            {started.time}
          </time>
          <span aria-hidden="true" className="g-act__dot" style={{ background: toneVar(tone) }} />
          <span className="g-act__main">
            <span className="g-act__title">
              {runKind(id)} <span className="g-act__outcome" style={{ color: toneVar(tone) }}>{headline}</span>
            </span>
            <span className="g-act__sub g-ui g-muted">
              {plural(steps.length, 'step')}
              {cost > 0 ? ` · $${cost.toFixed(3)}` : ''}
              {outcome?.result && !failed ? ` · ${outcome.result}` : ''}
            </span>
          </span>
          <span className="g-act__chev" aria-hidden="true">
            ▾
          </span>
        </summary>
        {failed && outcome?.result && (
          <p className="g-act__err" dir="ltr">
            {outcome.result}
          </p>
        )}
        <ol className="g-act__steps">
          {steps.map((r, i) => (
            <li key={`${r.at}-${i}`} className="g-act__step">
              <time dateTime={r.at} className="g-act__time g-act__time--step">
                {r.time}
              </time>
              <span className="g-src">{r.source}</span>
              <span className="g-act__text">
                {r.text}
                {r.result && <span className="g-act__result g-muted"> — {r.result}</span>}
              </span>
            </li>
          ))}
        </ol>
        <div className="g-act__foot">
          <Link to={`/flow?run=${encodeURIComponent(id)}`} className="g-link g-ui">
            See this run in Agent flow{' '}
            <span aria-hidden="true" className="g-arrow">
              →
            </span>
          </Link>
        </div>
      </details>
    </li>
  )
}

function RowEntry({ row }: { row: ActivityRow }) {
  const { openItem } = useShell()
  return (
    <li className="g-act">
      <div className="g-act__head g-act__head--row">
        <time dateTime={row.at} className="g-act__time">
          {row.time}
        </time>
        <span aria-hidden="true" className="g-act__dot" style={{ background: toneVar(row.tone) }} />
        <span className="g-act__main">
          <span className="g-act__text">
            <span className="g-src">{row.source}</span>
            {row.text}
            {row.result && <span className="g-act__result g-muted"> — {row.result}</span>}
          </span>
          {(row.item_id || row.decision_id) && (
            <span className="g-act__links g-ui">
              {row.item_id && (
                <button type="button" className="g-linkbtn g-ui" onClick={() => openItem(row.item_id!)}>
                  Open item
                </button>
              )}
              {row.decision_id && (
                <Link to="/decisions" className="g-link">
                  See decision
                </Link>
              )}
            </span>
          )}
        </span>
      </div>
    </li>
  )
}
