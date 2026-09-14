// Home: proves the agent worked while nobody watched. Everything comes from GET /api/summary (kept fresh by the shell).
import { Link, useNavigate } from 'react-router-dom'
import { fmt } from '../../api/client'
import { warrantyColor } from '../../theme/tokens'
import { Bar, ErrorNote, Skeleton, Status } from '../../ui/primitives'
import { fullDate, plural, toneVar } from '../format'
import { useShell } from '../shell/ShellContext'

export function Home() {
  const { summary, summaryError, refreshSummary, decisions, theme, openItem, copyAddress, runSweep } = useShell()
  const navigate = useNavigate()
  const n = summary?.decisions_pending ?? 0
  const pending = n > 0
  const criticalPending = decisions?.pending.some(d => d.severity === 'critical') ?? false
  const title = pending ? (n === 1 ? 'One thing needs you' : `${n} things need you`) : 'All quiet'
  const sub = pending
    ? criticalPending
      ? 'A critical recall matched an item you own. Everything else ran on its own.'
      : 'A decision is waiting for you. Everything else ran on its own.'
    : 'What the agent did while you were away.'
  const quiet = pending ? 0 : (summary?.quiet_days ?? 0)

  return (
    <>
      <div className="g-page__head">
        <div>
          <h1 className="g-h1">{summary ? title : <Skeleton w={260} h={30} />}</h1>
          <p className="g-sub">{summary ? sub : <Skeleton w={320} h={16} />}</p>
        </div>
        <div className="g-actions">
          <button type="button" className="g-btn g-btn--outline" onClick={copyAddress}>
            Copy forwarding address
          </button>
          <button type="button" className="g-btn g-btn--primary" onClick={() => navigate('/inventory?add=1')}>
            Add item
          </button>
        </div>
      </div>

      {summaryError && !summary && <ErrorNote message={summaryError} onRetry={refreshSummary} style={{ marginBottom: 16 }} />}

      <section aria-labelledby="quiet-h" className="g-card g-hero">
        <div>
          <h2 id="quiet-h" className="g-hero__eyebrow">
            Quiet score
          </h2>
          <div className="g-hero__row">
            <span className="g-hero__num">{summary ? quiet : <Skeleton w={96} h={72} />}</span>
            <span className="g-hero__cap">days since Guardian last needed you</span>
          </div>
          <p className="g-hero__quote">The agent's best output is silence.</p>
        </div>
        <div className="g-tiles">
          <Tile label="Items watched" value={summary?.items_watched} onClick={() => navigate('/inventory')} />
          <Tile label="Sweeps run" value={summary?.sweeps_run} onClick={() => navigate('/activity')} />
          <Tile label="Recalls screened, 30 days" value={summary?.recalls_screened_30d} onClick={() => navigate('/activity')} />
          <Tile label="Decisions pending" value={summary?.decisions_pending} onClick={() => navigate('/decisions')} critical={pending} />
        </div>
      </section>

      <div className="g-grid-2">
        <section aria-labelledby="act-h" className="g-card">
          <div className="g-card__head">
            <h2 id="act-h" className="g-h2">
              Last night's sweep
            </h2>
            <Link to="/activity" className="g-link">
              All activity
            </Link>
          </div>
          <ol className="g-list">
            {!summary &&
              [0, 1, 2].map(i => (
                <li key={i} className="g-list__row" aria-hidden="true">
                  <Skeleton w={44} h={13} />
                  <Skeleton h={14} />
                </li>
              ))}
            {summary && summary.recent_activity.length === 0 && (
              <li className="g-empty g-small" style={{ padding: '24px 0' }}>
                No sweep has run yet.{' '}
                <button type="button" className="g-linkbtn g-ui" onClick={runSweep}>
                  Run one now
                </button>
              </li>
            )}
            {summary?.recent_activity.map((a, i) => (
              <li key={`${a.at}-${i}`} className="g-list__row">
                <time className="g-time" dateTime={a.at}>
                  {a.time}
                </time>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{a.text}</div>
                  {a.result && (
                    <Status color={toneVar(a.tone)} style={{ marginTop: 2 }}>
                      {a.result}
                    </Status>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="war-h" className="g-card">
          <div className="g-card__head">
            <h2 id="war-h" className="g-h2">
              Warranties ending soon
            </h2>
            <Link to="/inventory" className="g-link">
              Inventory
            </Link>
          </div>
          <ul className="g-list">
            {!summary &&
              [0, 1].map(i => (
                <li key={i} className="g-list__row g-list__row--stack" aria-hidden="true">
                  <Skeleton w="60%" h={16} style={{ marginBottom: 8 }} />
                  <Skeleton h={6} />
                </li>
              ))}
            {summary && summary.ending_soon.length === 0 && (
              <li className="g-empty g-small" style={{ padding: '24px 0' }}>
                Nothing ends in the next 60 days.
              </li>
            )}
            {summary?.ending_soon.map(w => (
              <li key={w.item_id} className="g-list__row g-list__row--stack">
                <div className="g-between">
                  <button type="button" className="g-linkbtn" onClick={() => openItem(w.item_id)}>
                    {w.name}
                  </button>
                  <span className="g-num g-small g-muted g-bidi" title={w.ends_on}>
                    Ends {fullDate(w.ends_on)} · {w.days_left <= 0 ? 'today' : `in ${plural(w.days_left, 'day')}`}
                  </span>
                </div>
                <Bar pct={w.pct} color={warrantyColor(theme, w.pct)} style={{ marginTop: 8 }} />
                <div className="g-small g-muted" style={{ marginTop: 6 }}>
                  {w.note}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  )
}

function Tile({ label, value, onClick, critical = false }: { label: string; value: number | undefined; onClick: () => void; critical?: boolean }) {
  return (
    <button type="button" className={`g-tile${critical ? ' g-tile--critical' : ''}`} onClick={onClick}>
      <div className="g-eyebrow">{label}</div>
      <div className="g-tile__num">{value == null ? <Skeleton w={48} h={28} /> : fmt.int(value)}</div>
    </button>
  )
}
