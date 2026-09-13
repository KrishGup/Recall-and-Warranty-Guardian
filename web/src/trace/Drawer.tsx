// Bottom drawer of the canvas column: grab bar, tab strip and the Events / Metrics / Decisions / Tasks / Spec / Output panels.
import { useLayoutEffect, useRef, type UIEvent } from 'react'
import { fmt } from '../api/client'
import type { GrenEvent, GrenRun } from '../api/types'
import { kindColors, type Theme } from '../theme/tokens'
import { GateCard, type GateInfo } from './GateCard'
import { eventText, eventTone, hms, kfmt, nodeDuration, nodeStatus, pct, pretty, tokensOf, type Graph } from './model'
import { Resizer } from './ui'

export type Tab = 'events' | 'metrics' | 'decisions' | 'tasks' | 'spec' | 'output'
const TABS: [Tab, string][] = [
  ['events', 'Events'],
  ['metrics', 'Metrics'],
  ['decisions', 'Decisions'],
  ['tasks', 'Tasks'],
  ['spec', 'Spec'],
  ['output', 'Output'],
]

interface Props {
  run: GrenRun | null
  graph: Graph
  events: GrenEvent[]
  tab: Tab
  onTab: (t: Tab) => void
  open: boolean
  onToggle: () => void
  height: number
  maxH: number
  onHeight: (h: number) => void
  onCommit: () => void
  sel: string | null
  onSelect: (id: string) => void
  gate: GateInfo | null
  theme: Theme
  now: number
}

export function Drawer({ run, graph, events, tab, onTab, open, onToggle, height, maxH, onHeight, onCommit, sel, onSelect, gate, theme, now }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  // Follow the log: stick to the bottom while the reader was already there.
  useLayoutEffect(() => {
    if (tab !== 'events') return
    const el = panelRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [events.length, tab, open])
  useLayoutEffect(() => {
    atBottom.current = true
    const el = panelRef.current
    if (el && tab !== 'events') el.scrollTop = 0
  }, [tab, run?.run.id])

  const tasksCount = gate ? 1 : 0
  return (
    <section aria-label="Run details" className="tr-drawer" style={{ height: open ? height : 52 }}>
      <Resizer
        label="Resize details drawer"
        orientation="horizontal"
        min={120}
        max={maxH}
        value={open ? height : 52}
        toDelta={(_dx, dy) => -dy}
        grow="ArrowUp"
        shrink="ArrowDown"
        onChange={onHeight}
        onCommit={onCommit}
      />
      <div role="tablist" aria-label="Details" className="tr-tabs">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`tr-tab-${id}`} aria-selected={tab === id} aria-controls="tr-panel" className="tr-tab" onClick={() => onTab(id)}>
            {label}
            {id === 'tasks' && tasksCount > 0 && <span className="tr-count">{tasksCount}</span>}
          </button>
        ))}
        <div className="tr-spacer" />
        <button type="button" className="tr-chev" onClick={onToggle} aria-label={open ? 'Collapse details' : 'Expand details'} aria-expanded={open}>
          {open ? '▾' : '▴'}
        </button>
      </div>
      <div id="tr-panel" role="tabpanel" aria-labelledby={`tr-tab-${tab}`} className="tr-panel" ref={panelRef} onScroll={onScroll} hidden={!open}>
        {tab === 'events' && <EventsPanel events={events} run={run} />}
        {tab === 'metrics' && <MetricsPanel run={run} graph={graph} sel={sel} onSelect={onSelect} theme={theme} now={now} />}
        {tab === 'decisions' && <DecisionsPanel run={run} />}
        {tab === 'tasks' && <TasksPanel run={run} gate={gate} now={now} />}
        {tab === 'spec' && (run?.spec_yaml ? <pre dir="ltr" className="tr-pre tr-pre--spec">{run.spec_yaml}</pre> : <p className="tr-empty">No spec loaded.</p>)}
        {tab === 'output' && <OutputPanel run={run} />}
      </div>
    </section>
  )
}

function EventsPanel({ events, run }: { events: GrenEvent[]; run: GrenRun | null }) {
  if (!events.length) return <p className="tr-empty">{run ? 'No events recorded yet.' : 'Select a run to see its event log.'}</p>
  return (
    <ol className="tr-events" dir="ltr">
      {events.map(ev => (
        <li key={ev.seq} className="tr-ev">
          <span className="tr-ev-t">{hms(ev.ts)}</span>
          <span className={`tr-ev-type tone-${eventTone(ev.type)}`}>{ev.type}</span>
          <span className="tr-ev-node">{ev.node ? ev.node + (ev.item != null ? `[${ev.item}]` : '') : '—'}</span>
          <span className="tr-ev-text">{eventText(ev)}</span>
        </li>
      ))}
    </ol>
  )
}

function MetricsPanel({ run, graph, sel, onSelect, theme, now }: { run: GrenRun | null; graph: Graph; sel: string | null; onSelect: (id: string) => void; theme: Theme; now: number }) {
  const m = run?.metrics
  if (!run || !m) return <p className="tr-empty">No metrics yet.</p>
  const kinds = kindColors(theme)
  const human = m.human ?? { gates: 0, approved: 0, rejected: 0, auto: 0 }
  const waitingGate = Object.values(run.nodes).some(r => r.status === 'waiting_approval')
  const cards: { label: string; value: string; sub: string }[] = [
    { label: 'wall clock', value: fmt.ms(m.wall_ms), sub: `critical path ${fmt.ms(m.critical_path?.ms)}` },
    { label: 'parallel speedup', value: m.parallel_speedup != null ? `${m.parallel_speedup.toFixed(1)}×` : '—', sub: `sum of work ${fmt.ms(m.sum_of_node_ms)}` },
    { label: 'cost', value: fmt.usd(m.cost_usd), sub: `${m.agent_calls ?? 0} agent call${m.agent_calls === 1 ? '' : 's'}` },
    { label: 'peak width', value: `${m.width?.peak ?? '—'} / ${m.width?.budget ?? '∞'}`, sub: `${Math.round(m.width?.agent_seconds ?? 0)} s agent time` },
    { label: 'node failure rate', value: pct(m.node_failure_rate), sub: `retry rate ${pct(m.retry_rate)}` },
    {
      label: 'verifier kill rate',
      value: m.verifier?.candidates ? pct(m.verifier.kill_rate) : '—',
      sub: m.verifier?.candidates ? `${m.verifier.killed} / ${m.verifier.candidates} killed` : 'no verifications',
    },
    {
      label: 'human',
      value: `${human.gates} gate${human.gates === 1 ? '' : 's'}${human.approved ? ` · ${human.approved} approved` : human.rejected ? ` · ${human.rejected} rejected` : waitingGate ? ' · waiting' : ''}`,
      sub: m.human_wait_ms ? `wait ${fmt.ms(m.human_wait_ms)} · separated from execution` : 'approval latency is separated from execution',
    },
    { label: 'tokens', value: `${kfmt(m.tokens?.input)} in`, sub: `${kfmt(m.tokens?.output)} out · ${kfmt(m.tokens?.cache_read)} cached` },
  ]
  return (
    <>
      <div className="tr-cards">
        {cards.map(c => (
          <div key={c.label} className="tr-card">
            <div className="tr-eyebrow">{c.label}</div>
            <div className="tr-card-val">{c.value}</div>
            <div className="tr-card-sub">{c.sub}</div>
          </div>
        ))}
      </div>
      <table className="tr-table">
        <thead>
          <tr>
            <th scope="col">Node</th>
            <th scope="col">Kind</th>
            <th scope="col">Status</th>
            <th scope="col">Duration</th>
            <th scope="col">Tokens</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          {graph.nodes.map(n => {
            const rec = run.nodes[n.id]
            const st = nodeStatus(theme, rec?.status)
            return (
              <tr key={n.id} aria-selected={sel === n.id} tabIndex={0} onClick={() => onSelect(n.id)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(n.id))}>
                <td className="tr-num" style={{ fontWeight: 500 }}>
                  {n.id}
                </td>
                <td>{kinds[n.kind]?.label ?? n.kind}</td>
                <td style={{ color: st.text, fontFamily: 'var(--font-ui)' }}>{st.label}</td>
                <td className="tr-num">{nodeDuration(rec, now)}</td>
                <td className="tr-num">{rec && tokensOf(rec) ? fmt.int(tokensOf(rec)) : '—'}</td>
                <td className="tr-num">{fmt.usd(rec?.cost_usd ?? 0)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {m.hints?.length > 0 && (
        <ul className="tr-hints">
          {m.hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}
    </>
  )
}

function DecisionsPanel({ run }: { run: GrenRun | null }) {
  const list = run?.run.decisions ?? []
  if (!list.length) return <p className="tr-empty">No routes or gates were reached in this run.</p>
  return (
    <>
      {list.map((d, i) => (
        <div key={i} className="tr-decision">
          <div className="tr-decision-head">
            <b>{d.node}</b>
            <span>
              {d.kind} · <span className="tr-num">{hms(d.at)}</span>
            </span>
          </div>
          <p>{d.detail}</p>
          {d.state != null && (
            <pre dir="ltr" className="tr-pre">
              {pretty(d.state)}
            </pre>
          )}
        </div>
      ))}
    </>
  )
}

function TasksPanel({ run, gate, now }: { run: GrenRun | null; gate: GateInfo | null; now: number }) {
  const tasks = run?.tasks ?? []
  if (!gate && !tasks.length) return <p className="tr-empty">No open tasks. Gates and inbox tasks appear here while the graph is paused on them.</p>
  return (
    <>
      {gate && <GateCard gate={gate} now={now} variant="task" />}
      {tasks.map((t, i) => (
        <pre key={i} dir="ltr" className="tr-pre" style={{ marginTop: 10, maxWidth: 720 }}>
          {pretty(t)}
        </pre>
      ))}
    </>
  )
}

function OutputPanel({ run }: { run: GrenRun | null }) {
  if (!run) return <p className="tr-empty">Select a run to see its output.</p>
  const out = run.run.output
  const text = out != null ? pretty(out) : `(run ${run.run.status} · no output yet)`
  return (
    <>
      {run.run.error && (
        <p className="tr-empty" style={{ color: 'var(--critical)' }}>
          {run.run.error}
        </p>
      )}
      <pre dir="ltr" className="tr-pre tr-pre--spec">
        {text}
      </pre>
    </>
  )
}
