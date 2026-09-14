// Node inspector: kind + status, id, description, key facts, gate box, inputs, structured output, attempts, actions.
// Desktop: resizable column on the inline end. Mobile: fixed bottom sheet (70 vh).
import { fmt } from '../api/client'
import type { GrenRun } from '../api/types'
import { kindColors, type Theme } from '../theme/tokens'
import { GateCard, type GateInfo } from './GateCard'
import { criticalNodes, ellipsis, hms, inspectorSub, isWaiting, modelShort, nodeDuration, nodeOutputText, nodeStatus, pretty, tokensOf, type Graph } from './model'
import { Dot, Resizer } from './ui'

interface Props {
  run: GrenRun
  graph: Graph
  sel: string
  onClose: () => void
  narrow: boolean
  width: number
  onWidth: (w: number) => void
  onCommit: () => void
  rtl: boolean
  theme: Theme
  now: number
  gate: GateInfo | null
  busy: boolean
  onCopyPrompt: () => void
  onCopySpec: () => void
  onFork: () => void
}

export function Inspector({ run, graph, sel, onClose, narrow, width, onWidth, onCommit, rtl, theme, now, gate, busy, onCopyPrompt, onCopySpec, onFork }: Props) {
  const n = graph.byId[sel]
  const rec = run.nodes[sel]
  const kind = kindColors(theme)[n.kind] ?? { c: theme.ink2, ink: theme.surface, label: n.kind }
  const st = nodeStatus(theme, rec?.status)
  const inputs = graph.edges.filter(e => e.to === sel && !e.repair)
  const usage = rec?.usage ?? {}
  const cached = usage.cacheReadInputTokens ?? 0
  const kv: [string, string][] = [
    ['Duration', nodeDuration(rec, now)],
    ['Started', rec?.started_at ? hms(rec.started_at) : '—'],
    ['Ended', rec?.ended_at ? hms(rec.ended_at) : rec?.status === 'running' || isWaiting(rec?.status) ? 'still going' : '—'],
    ['Tokens', rec && tokensOf(rec) ? fmt.int(tokensOf(rec)) + (cached ? ` · ${fmt.int(cached)} cached` : '') : '0'],
    ['Cost', fmt.usd(rec?.cost_usd ?? 0)],
    ['Attempts', String(rec?.attempts?.length ?? 0) + (rec?.repairs ? ` · ${rec.repairs} repair round${rec.repairs === 1 ? '' : 's'}` : '')],
    ['On critical path', criticalNodes(run).includes(sel) ? 'yes' : 'no'],
  ]
  if (rec?.gate?.decision) kv.push(['Gate', `${rec.gate.decision}${rec.gate.by ? ` by ${rec.gate.by}` : ''}${rec.gate.at ? ` at ${hms(rec.gate.at)}` : ''}`])
  if (rec?.route) kv.push(['Route', `${rec.route}${rec.route_reason ? ` · ${ellipsis(rec.route_reason, 80)}` : ''}`])
  const items = rec?.items ?? []
  const desc = n.spec?.description ?? (n.kind === 'gate' ? 'Human gate. The run pauses here until an approval record exists.' : '')
  return (
    <aside aria-label="Inspector" className={`tr-insp ${narrow ? 'tr-insp--sheet' : ''}`} style={narrow ? undefined : { width }}>
      {!narrow && (
        <Resizer
          label="Resize inspector"
          orientation="vertical"
          min={280}
          max={600}
          value={width}
          toDelta={dx => (rtl ? dx : -dx)}
          grow={rtl ? 'ArrowRight' : 'ArrowLeft'}
          shrink={rtl ? 'ArrowLeft' : 'ArrowRight'}
          onChange={onWidth}
          onCommit={onCommit}
          className="tr-sep--insp"
        />
      )}
      <div className="tr-insp-head">
        <div>
          <div className="tr-insp-row">
            <span className="tr-kindpill" style={{ background: kind.c, color: kind.ink }}>
              {kind.label}
            </span>
            <span className="tr-status" style={{ color: st.text }}>
              <Dot color={st.dot} pulse={st.pulse} />
              {st.label}
            </span>
          </div>
          <h2>{sel}</h2>
          <div className="tr-sub">{inspectorSub(n)}</div>
        </div>
        <button type="button" className="tr-close" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </div>
      <div className="tr-insp-body">
        {desc && <p>{desc}</p>}
        <dl className="tr-kv">
          {kv.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt className="tr-eyebrow">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {gate && <GateCard gate={gate} now={now} variant="box" />}
        {rec?.error && rec.status === 'failed' && (
          <div>
            <div className="tr-eyebrow tr-section-title">Error</div>
            <pre dir="ltr" className="tr-pre" style={{ color: 'var(--critical)' }}>
              {rec.error}
            </pre>
          </div>
        )}
        <div>
          <div className="tr-eyebrow tr-section-title">Inputs crossing into this node</div>
          {inputs.map((e, i) => (
            <div key={i} className="tr-input">
              <b>{e.from}</b>
              <code dir="ltr">{e.data.length ? e.data.join(' · ') : e.kind}</code>
            </div>
          ))}
          {!inputs.length && <div className="tr-sub">Entry node. Reads the run input directly.</div>}
        </div>
        {items.length > 0 && (
          <div>
            <div className="tr-eyebrow tr-section-title">
              Fan-out · {items.filter(i => i.status === 'completed').length} of {items.length} items completed
            </div>
            <div className="tr-items-wrap">
              <table className="tr-table tr-table--items">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Status</th>
                    <th scope="col">Tries</th>
                    <th scope="col">Took</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(it => {
                    const s = nodeStatus(theme, it.status)
                    const text = it.error ? it.error : it.output != null ? pretty(it.output) : ''
                    return (
                      <tr key={it.index}>
                        <td className="tr-num">{it.index}</td>
                        <td style={{ color: s.text, fontFamily: 'var(--font-ui)' }}>{it.status}</td>
                        <td className="tr-num">{it.attempts ?? 1}</td>
                        <td className="tr-num">{it.duration_ms != null ? fmt.ms(it.duration_ms) : '—'}</td>
                        <td className="tr-items-out" dir="auto" style={it.error ? { color: 'var(--critical)' } : undefined}>
                          {ellipsis(text, 110)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <div>
          <div className="tr-eyebrow tr-section-title">Structured output</div>
          <pre dir="ltr" className="tr-pre tr-pre--out">
            {nodeOutputText(rec, n)}
          </pre>
        </div>
        {rec?.attempts && rec.attempts.length > 0 && (
          <div>
            <div className="tr-eyebrow tr-section-title">Attempts</div>
            {rec.attempts.map((a, i) => {
              const ok = a.status === 'ok'
              const what = ok
                ? [modelShort(a.model) || a.bridge || 'ok', a.validation_errors?.length ? `${a.validation_errors.length} validation issue(s)` : null].filter(Boolean).join(' · ')
                : `${a.status}${a.error ? ' · ' + ellipsis(a.error, 90) : ''}`
              return (
                <div key={i} className="tr-attempt">
                  <Dot color={ok ? theme.ok : theme.critical} />
                  <span className="tr-num">
                    #{i + 1}
                    {a.item != null ? ` · item ${a.item}` : ''}
                  </span>
                  <span>{what}</span>
                  <span className="tr-dur">{a.duration_ms != null ? fmt.ms(a.duration_ms) : '—'}</span>
                </div>
              )
            })}
          </div>
        )}
        {rec?.verify && rec.verify.killed && rec.verify.killed.length > 0 && (
          <div>
            <div className="tr-eyebrow tr-section-title">Killed candidates</div>
            {rec.verify.killed.map((k, i) => (
              <div key={i} className="tr-kill">
                <b>
                  #{k.index}
                  {k.confidence != null ? ` · confidence ${k.confidence}` : ''}
                </b>
                <ul>
                  {(k.reasons ?? []).map((r, j) => (
                    <li key={j}>{r}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        <div className="tr-footer">
          <button type="button" className="tr-btn tr-btn--outline" onClick={onCopyPrompt} disabled={busy}>
            Copy last prompt
          </button>
          <button type="button" className="tr-btn tr-btn--outline" onClick={onCopySpec}>
            Copy node spec
          </button>
          <button type="button" className="tr-btn tr-btn--primary-outline" onClick={onFork} disabled={busy}>
            Fork run from here
          </button>
        </div>
      </div>
    </aside>
  )
}
