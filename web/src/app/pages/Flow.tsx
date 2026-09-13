// Agent flow summary page (Technical): the latest sweep run as a row of node cards, one detail container for the
// selected node, and the roadmap container. Data: summary.last_sweep.run_id → GET /gren/api/run?id=…
import { useEffect, useMemo, useState } from 'react'
import { Api, fmt } from '../../api/client'
import type { GrenNodeRecord, GrenRun, GrenRunStatus } from '../../api/types'
import { kindColors } from '../../theme/tokens'
import { ErrorNote, Skeleton, Status } from '../../ui/primitives'
import { excerpt, modelLabel } from '../format'
import { useShell } from '../shell/ShellContext'
import { useAsync } from '../shell/useAsync'

const BULLETS = [
  'Live trace from AgentCore Observability for any night, not just tonight.',
  'Per-node structured output (MatchVerdict, SurfacePlan, ActionReport) with the interrupt highlighted and the hours it waited.',
  'Memory reads and writes: which preference or household fact changed the plan.',
  'Token and cost totals per run against the credit.',
  'Replay: re-run the matcher on one candidate pair after a photo arrives.',
]

function nodeStatus(rec: GrenNodeRecord | undefined): { label: string; color: string; pulse: boolean } {
  switch (rec?.status) {
    case 'completed':
      return { label: `Done · ${fmt.ms(rec.duration_ms)}`, color: 'var(--ok)', pulse: false }
    case 'running':
      return { label: 'Running…', color: 'var(--primary)', pulse: true }
    case 'waiting_approval':
      return { label: 'Waiting on you', color: 'var(--warn)', pulse: true }
    case 'waiting_task':
      return { label: 'Waiting on a task', color: 'var(--warn)', pulse: true }
    case 'failed':
      return { label: 'Failed', color: 'var(--critical)', pulse: false }
    case 'skipped':
      return { label: 'Skipped', color: 'var(--ink2)', pulse: false }
    default:
      return { label: 'Not started', color: 'var(--ink2)', pulse: false }
  }
}

function runColor(status: GrenRunStatus): string {
  switch (status) {
    case 'completed':
      return 'var(--ok)'
    case 'running':
      return 'var(--primary)'
    case 'paused':
      return 'var(--warn)'
    case 'failed':
      return 'var(--critical)'
    default:
      return 'var(--ink2)'
  }
}

function tokensOf(rec: GrenNodeRecord | undefined): string {
  if (!rec || rec.status === 'pending') return '—'
  const u = rec.usage ?? {}
  const total = u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
  return fmt.int(total)
}

function outputOf(rec: GrenNodeRecord | undefined): string {
  if (!rec || rec.status === 'pending') return '(not run)'
  if (rec.status === 'waiting_approval') return rec.gate ? JSON.stringify(rec.gate, null, 2) : '(awaiting approval)'
  if (rec.status === 'running') return rec.outputs?.length ? JSON.stringify(rec.outputs, null, 2) : '(running…)'
  if (rec.status === 'skipped') return rec.skip_reason ? `(skipped: ${rec.skip_reason})` : '(skipped)'
  if (rec.status === 'failed') return rec.error ? `(failed: ${rec.error})` : '(failed)'
  const v = rec.output ?? rec.outputs ?? rec.verify ?? rec.items ?? null
  if (v == null) return '(no output)'
  const s = JSON.stringify(v, null, 2)
  return s.length > 8000 ? `${s.slice(0, 8000)}\n…` : s
}

/** The node worth looking at first: a waiting gate, else the running node, else a failure, else the last completed. */
function pickDefault(run: GrenRun | null): string | null {
  if (!run) return null
  const ids = run.run.spec.nodes.map(n => n.id)
  const by = (pred: (r: GrenNodeRecord | undefined) => boolean) => ids.find(id => pred(run.nodes[id]))
  return by(r => r?.status === 'waiting_approval' || r?.status === 'waiting_task') ?? by(r => r?.status === 'running') ?? by(r => r?.status === 'failed') ?? [...ids].reverse().find(id => run.nodes[id]?.status === 'completed') ?? ids[0] ?? null
}

export function Flow() {
  const { summary, summaryError, runVersion, dataVersion, theme, runSweep } = useShell()
  const runs = useAsync(() => Api.gren.runs(), [dataVersion])
  const runId = summary?.last_sweep.run_id ?? runs.data?.[0]?.id ?? null
  const resolving = !summary && !summaryError && !runs.data && !runs.error
  const run = useAsync(() => (runId ? Api.gren.run(runId) : Promise.resolve(null)), [runId, runVersion])
  const data = run.data
  const [sel, setSel] = useState<string | null>(null)
  const auto = useMemo(() => pickDefault(data), [data])
  const specNodes = data?.run.spec.nodes ?? []
  const selId = sel && specNodes.some(n => n.id === sel) ? sel : auto
  const selSpec = specNodes.find(n => n.id === selId)
  const selRec = selId && data ? data.nodes[selId] : undefined
  const st = nodeStatus(selRec)
  const kinds = kindColors(theme)
  // Keep the selected node visible in the horizontally scrolling row (the waiting gate is usually far to the end).
  useEffect(() => {
    if (!selId) return
    const el = document.querySelector<HTMLElement>('.g-node[aria-pressed="true"]')
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'auto' })
  }, [selId])
  const traceHref = `/flow/trace${runId ? `?run=${encodeURIComponent(runId)}` : ''}`
  const showSkeleton = resolving || (runId !== null && run.loading && !data)

  return (
    <>
      <div className="g-page__head" style={{ marginBottom: 16 }}>
        <div>
          <div className="g-titlerow">
            <h1 className="g-h1">Agent flow</h1>
            <span className="g-tag">Technical</span>
          </div>
          <p className="g-sub">Tonight's run as the Strands graph saw it. Deterministic code in grey, agents in blue, the human in amber.</p>
        </div>
        <a href={traceHref} className="g-btn g-btn--primary">
          Open full trace view{' '}
          <span aria-hidden="true" className="g-arrow">
            →
          </span>
        </a>
      </div>

      <section aria-label="Graph" className="g-card g-flow" aria-busy={run.loading || run.refreshing}>
        {showSkeleton && (
          <ol className="g-flow__row" aria-hidden="true">
            {[0, 1, 2, 3].map(i => (
              <li key={i} className="g-flow__li">
                <Skeleton w={196} h={124} style={{ borderRadius: 12 }} />
                {i < 3 && <span className="g-conn" />}
              </li>
            ))}
          </ol>
        )}
        {run.error && !data && <ErrorNote message={run.error} onRetry={run.reload} />}
        {!resolving && runId === null && (
          <div className="g-empty" style={{ padding: '24px 0' }}>
            <h2 className="g-h2" style={{ fontSize: 20, marginBottom: 6 }}>
              No sweep has run yet
            </h2>
            <p style={{ margin: '0 auto 16px', maxWidth: 440 }}>Start one to watch the graph fill in node by node: feeds, candidates, matcher, triage, the household gate and the remedy.</p>
            <button type="button" className="g-btn g-btn--primary g-btn--lg" onClick={runSweep}>
              Run sweep now
            </button>
          </div>
        )}
        {data && (
          <>
            <div className="g-flow__meta g-bidi">
              <span className="g-mono" dir="ltr">
                {data.run.id}
              </span>
              <Status color={runColor(data.run.status)} pulse={data.run.status === 'running'}>
                {data.run.status}
              </Status>
              <span>{fmt.usd(data.run.totals.cost_usd)}</span>
              <span>{fmt.ms(data.metrics?.wall_ms ?? data.run.totals.wall_ms)}</span>
              {data.metrics?.tokens && <span>{fmt.int(data.metrics.tokens.input + data.metrics.tokens.output)} tokens</span>}
            </div>
            <ol className="g-flow__row">
              {specNodes.map((n, i) => {
                const rec = data.nodes[n.id]
                const s = nodeStatus(rec)
                const k = kinds[n.kind] ?? kinds.code
                return (
                  <li key={n.id} className="g-flow__li">
                    <button type="button" className="g-node" aria-pressed={selId === n.id} onClick={() => setSel(n.id)}>
                      <span className="g-node__kind" style={{ background: k.c, color: k.ink }}>
                        {k.label}
                      </span>
                      <span className="g-node__name">{n.id}</span>
                      <span className="g-node__meta">
                        {modelLabel(n.model)}
                        {n.description ? ` · ${excerpt(n.description, 64)}` : ''}
                      </span>
                      <Status color={s.color} pulse={s.pulse}>
                        {s.label}
                      </Status>
                    </button>
                    {i < specNodes.length - 1 && <span aria-hidden="true" className="g-conn" />}
                  </li>
                )
              })}
            </ol>
          </>
        )}
      </section>

      <div className="g-grid-2">
        <section aria-labelledby="node-h" className="g-card g-card--pad">
          {selSpec ? (
            <>
              <h2 id="node-h" className="g-h2" style={{ marginBottom: 4 }}>
                {selSpec.id}
              </h2>
              <p className="g-muted" style={{ margin: '0 0 8px', fontSize: 14 }}>
                {selSpec.description ?? 'No description in the spec.'}
              </p>
              <div style={{ marginBottom: 14 }}>
                <Status color={st.color} pulse={st.pulse}>
                  {st.label}
                </Status>
              </div>
              <dl className="g-kvgrid">
                <div>
                  <dt className="g-eyebrow">Duration</dt>
                  <dd>{selRec?.duration_ms != null ? fmt.ms(selRec.duration_ms) : '—'}</dd>
                </div>
                <div>
                  <dt className="g-eyebrow">Tokens</dt>
                  <dd>{tokensOf(selRec)}</dd>
                </div>
                <div>
                  <dt className="g-eyebrow">Cost</dt>
                  <dd>{selRec && selRec.status !== 'pending' ? fmt.usd(selRec.cost_usd) : '—'}</dd>
                </div>
              </dl>
              <div className="g-eyebrow" style={{ marginBottom: 6 }}>
                Structured output
              </div>
              <pre className="g-pre" dir="ltr">
                {outputOf(selRec)}
              </pre>
            </>
          ) : (
            <>
              <h2 id="node-h" className="g-h2" style={{ marginBottom: 4 }}>
                Node detail
              </h2>
              <p className="g-muted" style={{ margin: 0, fontSize: 14 }}>
                {showSkeleton ? 'Loading the latest run…' : 'Select a node in the graph to see its description, cost and structured output.'}
              </p>
            </>
          )}
        </section>
        <section aria-labelledby="plan-h" className="g-card g-card--pad g-card--dashed">
          <h2 id="plan-h" className="g-h2" style={{ marginBottom: 8 }}>
            What this view will show
          </h2>
          <ul className="g-bullets">
            {BULLETS.map(b => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </section>
      </div>
    </>
  )
}
