// Activity: every sweep, including the ones that found nothing. Per-night containers from GET /api/activity?days=7.
import { Link } from 'react-router-dom'
import { Api } from '../../api/client'
import { ErrorNote, Skeleton, Status } from '../../ui/primitives'
import { toneVar } from '../format'
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
        {nights.map(n => (
          <section key={n.date} aria-label={n.label} className="g-card">
            <div className="g-night__head">
              <h2 className="g-night__title">{n.label}</h2>
              <Status color={toneVar(n.tone)}>{n.summary}</Status>
            </div>
            <ol className="g-night__rows">
              {n.rows.length === 0 && (
                <li className="g-small g-muted" style={{ padding: '10px 0' }}>
                  Nothing logged.
                </li>
              )}
              {n.rows.map((r, i) => (
                <li key={`${r.at}-${i}`} className="g-night__row">
                  <time dateTime={r.at}>{r.time}</time>
                  <div>
                    <span className="g-src">{r.source}</span>
                    <span style={{ verticalAlign: 'middle' }}>
                      {r.text}
                      {r.result ? ` — ${r.result}` : ''}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </>
  )
}
