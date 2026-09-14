// Overview panel (Kestra's execution overview, in Guardian's words): the run in one sentence, the facts that decide
// what to do next (trigger, timing, cost against the budget, provider, lineage), Guardian's own account of what it did
// (its activity rows for this run), the inputs, warnings, and the error with a way out. A blueprint shows the analysis
// instead: estimates, findings and the checklist, with a way to run it.
import { fmt } from '../api/client'
import type { ActivityRow, GrenGraphInfo, GrenRun } from '../api/types'
import type { Theme } from '../theme/tokens'
import { isBlueprint } from './blueprint'
import { waitingFor } from './GateCard'
import { ellipsis, hms, kfmt, modelShort, parseOutput, pretty, runStatus, waitingGates, type Graph } from './model'
import { Dot } from './ui'

export interface OverviewActions {
  live: boolean
  busy: boolean
  gatesPending: number
  onSelectRun: (id: string) => void
  onSelectNode: (id: string) => void
  onRetry: (node: string) => void
  onCancel: () => void
  onRunGraph: () => void
  onCopyId: () => void
}

interface Props {
  run: GrenRun | null
  graph: Graph
  activity: ActivityRow[]
  graphInfo: GrenGraphInfo | null
  theme: Theme
  now: number
  actions: OverviewActions
}

const TRIGGER: Record<string, string> = { schedule: 'nightly schedule', dashboard: 'the dashboard', cli: 'the command line', fork: 'a fork', late: 'a late approval' }

/** What the run produced, for the graphs Guardian ships (sweep output: channel, feeds, matching; intake: the item). */
function outcome(run: GrenRun): string {
  const out = parseOutput(run.run.output)
  if (!out || typeof out !== 'object') return ''
  const o = out as Record<string, unknown>
  const parts: string[] = []
  const m = o.matching as Record<string, unknown> | undefined
  if (m && typeof m === 'object') {
    if (typeof m.certain === 'number') parts.push(`${m.certain} certain match${m.certain === 1 ? '' : 'es'}`)
    if (typeof m.candidates === 'number') parts.push(`${m.candidates} sent to the matcher`)
  }
  if (typeof o.channel === 'string') parts.push(o.channel === 'sms_now' ? 'surfaced by SMS' : o.channel === 'digest' ? 'held for the digest' : `channel ${o.channel}`)
  const item = o.item as Record<string, unknown> | undefined
  if (item && typeof item === 'object' && typeof item.name === 'string') parts.push(`added ${[item.brand, item.name].filter(Boolean).join(' ')}`)
  return parts.length ? ` ${parts.join(', ')}.` : ''
}

function toneColor(t: Theme, tone: string): string {
  return tone === 'critical' ? t.critical : tone === 'ok' ? t.ok : tone === 'warn' ? t.amberLine : t.faint
}

export function OverviewPanel({ run, graph, activity, graphInfo, theme, now, actions }: Props) {
  if (!run) return <p className="tr-empty">Select a run, or a blueprint of a graph that has not run yet.</p>
  const bp = isBlueprint(run)
  const recs = Object.values(run.nodes ?? {})
  const gates = waitingGates(run)
  const failed = recs.find(r => r.status === 'failed') ?? null
  const m = run.metrics
  const wall = m?.wall_ms ?? run.run.totals?.wall_ms
  const started = run.run.started_at ?? run.run.created_at
  const startedMs = Date.parse(started)
  const done = recs.filter(r => r.status === 'completed').length
  const skipped = recs.filter(r => r.status === 'skipped').length
  const total = graph.nodes.length
  const budget = run.run.budget?.max_cost_usd ?? run.run.spec?.budget?.max_cost_usd
  const cost = run.run.totals?.cost_usd ?? 0
  const st = bp ? { ...runStatus(theme, 'created'), label: 'blueprint' } : runStatus(theme, run.run.status)
  const trig = run.run.labels?.trigger ?? null
  const forkedFrom = run.run.forked_from ?? null

  let headline: string
  if (bp) {
    const cp = run.analysis?.critical_path?.est_ms
    const est = run.analysis?.est_cost_usd
    headline = `${total} node${total === 1 ? '' : 's'}. Estimated critical path ${fmt.ms(cp)}; estimated cost ${fmt.usd(est?.min, 2)} to ${fmt.usd(est?.max, 2)} a run.`
  } else if (run.run.status === 'running') headline = `Running: ${done} of ${total} nodes done, ${fmt.ms(Number.isNaN(startedMs) ? 0 : now - startedMs)} so far.`
  else if (run.run.status === 'paused' && gates.length) headline = `Paused at ${gates[0]} for ${waitingFor(run.nodes[gates[0]], now)}${actions.gatesPending ? `; ${actions.gatesPending} decision${actions.gatesPending === 1 ? '' : 's'} waiting on the household` : ''}.`
  else if (run.run.status === 'paused') headline = 'Paused.'
  else if (run.run.status === 'completed') headline = `Completed in ${fmt.ms(wall)} for ${fmt.usd(cost)}.${outcome(run)}`
  else if (run.run.status === 'failed') headline = `Failed at ${failed?.id ?? 'a node'} after ${fmt.ms(wall)}.`
  else if (run.run.status === 'cancelled') headline = 'Cancelled before it finished.'
  else headline = 'Created, not started yet.'

  const models = Object.keys(m?.cost_by_model ?? {}).map(modelShort).filter(Boolean)
  const facts: [string, string][] = bp
    ? [
        ['Graph', `${run.run.graph} · ${run.run.spec_file}`],
        ['Nodes', `${total} · ${graph.nodes.filter(n => n.kind === 'agent').length} agent · ${graph.nodes.filter(n => n.kind === 'code').length} code · ${graph.nodes.filter(n => n.kind === 'verify').length} verify · ${graph.nodes.filter(n => n.kind === 'gate').length} gate`],
        ['Parallel width', `${run.analysis?.max_width ?? '—'}${run.run.spec?.budget?.max_width ? ` (budget ${run.run.spec.budget.max_width})` : ''}`],
        ['Speedup', run.analysis?.parallel_speedup != null ? `${run.analysis.parallel_speedup.toFixed(1)}× over running every node in sequence` : '—'],
        ['Budget', `${budget != null ? fmt.usd(budget, 2) : 'none'}${run.run.spec?.budget?.max_wall_ms ? ` · ${fmt.ms(run.run.spec.budget.max_wall_ms)} wall` : ''}`],
      ]
    : [
        ['Started by', forkedFrom ? `a fork of ${forkedFrom}` : trig ? TRIGGER[trig] ?? trig : run.run.parent ? 'a parent run' : 'unknown'],
        ['Started', `${fmt.date(started)} ${hms(started)}`],
        ['Ended', run.run.ended_at ? `${fmt.date(run.run.ended_at)} ${hms(run.run.ended_at)}` : actions.live ? 'still going' : '—'],
        ['Wall clock', `${fmt.ms(wall)}${m?.human_wait_ms ? ` · ${fmt.ms(m.human_wait_ms)} waiting on a person` : ''}`],
        ['Cost', `${fmt.usd(cost)}${budget != null ? ` of ${fmt.usd(budget, 2)} budget` : ''}${m?.tokens ? ` · ${kfmt(m.tokens.input)} in / ${kfmt(m.tokens.output)} out` : ''}`],
        ['Provider', `${run.run.bridge || '—'}${models.length ? ` · ${models.join(', ')}` : ''}`],
        ['Nodes', `${done} done${skipped ? ` · ${skipped} skipped` : ''}${failed ? ' · 1 failed' : ''}${gates.length ? ` · ${gates.length} waiting` : ''} of ${total}`],
      ]
  const findings = bp ? (run.analysis?.findings ?? []) : []
  const checklist = bp ? (run.analysis?.checklist ?? []) : []
  const inputText = run.run.input == null ? '' : pretty(run.run.input)

  return (
    <div className="tr-ov">
      <div className="tr-ov-head">
        <div className="tr-ov-title">
          <span className="tr-status" style={{ color: st.text }}>
            <Dot color={st.dot} pulse={st.pulse} />
            {st.label}
          </span>
          <h3>{run.run.graph}</h3>
          <span className="tr-run-id" dir="ltr">
            {bp ? run.run.spec_file : run.run.id}
          </span>
        </div>
        <p className="tr-ov-headline">{headline}</p>
        {bp && (graphInfo?.goal || graphInfo?.description || run.run.spec?.goal || run.run.spec?.description) && <p className="tr-ov-goal">{graphInfo?.goal ?? run.run.spec?.goal ?? graphInfo?.description ?? run.run.spec?.description}</p>}
        <div className="tr-actions">
          {bp && (
            <button type="button" className="tr-btn tr-btn--primary-outline" onClick={actions.onRunGraph} disabled={actions.busy}>
              Run this graph…
            </button>
          )}
          {!bp && failed && (
            <button type="button" className="tr-btn tr-btn--primary-outline" onClick={() => actions.onRetry(failed.id)} disabled={actions.busy}>
              Retry from {failed.id}
            </button>
          )}
          {!bp && actions.live && (
            <button type="button" className="tr-btn tr-btn--outline" onClick={actions.onCancel} disabled={actions.busy}>
              Cancel run
            </button>
          )}
          {!bp && gates.length > 0 && (
            <button type="button" className="tr-btn tr-btn--outline" onClick={() => actions.onSelectNode(gates[0])}>
              Open the gate
            </button>
          )}
          {!bp && (
            <button type="button" className="tr-btn tr-btn--outline" onClick={actions.onCopyId}>
              Copy run id
            </button>
          )}
          {forkedFrom && (
            <button type="button" className="tr-btn tr-btn--outline" onClick={() => actions.onSelectRun(forkedFrom)}>
              Open the original run
            </button>
          )}
        </div>
      </div>

      {!bp && failed?.error && (
        <section className="tr-ov-section tr-ov-error" aria-label="Error">
          <div className="tr-eyebrow">Error at {failed.id}</div>
          <pre dir="ltr" className="tr-pre">
            {failed.error}
          </pre>
          <p className="tr-ov-hint">A retry forks this run from {failed.id}: everything before it is kept, {failed.id} and everything after run again.</p>
        </section>
      )}
      {!bp && run.run.warnings && run.run.warnings.length > 0 && (
        <section className="tr-ov-section" aria-label="Warnings">
          <div className="tr-eyebrow">Warnings</div>
          <ul className="tr-ov-list">
            {run.run.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      <dl className="tr-ov-facts">
        {facts.map(([k, v]) => (
          <div key={k} className="tr-ov-fact">
            <dt className="tr-eyebrow">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>

      {!bp && (
        <section className="tr-ov-section" aria-label="What Guardian did">
          <div className="tr-eyebrow">What Guardian did</div>
          {activity.length === 0 ? (
            <p className="tr-ov-hint">{actions.live ? 'Nothing recorded yet; the first feed pull is usually the first line.' : 'No Guardian activity is recorded for this run.'}</p>
          ) : (
            <ol className="tr-story">
              {activity.map((a, i) => (
                <li key={i} className="tr-story-row">
                  <span className="tr-story-time tr-num">{a.time}</span>
                  <span className="tr-src">{a.source}</span>
                  <span className="tr-story-text">
                    <Dot color={toneColor(theme, a.tone)} size={7} />
                    {a.text}
                    {a.result && <span className="tr-story-result">{a.result}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {bp && (findings.length > 0 || checklist.length > 0) && (
        <section className="tr-ov-section" aria-label="Analysis">
          <div className="tr-eyebrow">gren analysis</div>
          {findings.length > 0 && (
            <ul className="tr-ov-list">
              {findings.map((f, i) => (
                <li key={i}>
                  <span className={`tr-ov-level tr-ov-level--${f.level}`}>{f.level}</span> {f.node ? <b>{f.node}: </b> : null}
                  {f.message}
                </li>
              ))}
            </ul>
          )}
          {checklist.length > 0 && (
            <ul className="tr-ov-check">
              {checklist.map((c, i) => (
                <li key={i} className={c.ok ? 'is-ok' : 'is-off'}>
                  <span aria-hidden="true">{c.ok ? '✓' : '·'}</span> {c.item}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!bp && inputText && (
        <section className="tr-ov-section" aria-label="Inputs">
          <div className="tr-eyebrow">Inputs</div>
          <pre dir="ltr" className="tr-pre">
            {ellipsis(inputText, 1200)}
          </pre>
        </section>
      )}
    </div>
  )
}
