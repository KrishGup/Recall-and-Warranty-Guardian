// Agent flow (Technical): the gren trace workbench inside the dashboard shell. Runs and graph blueprints, the
// pan/zoom graph, the event log, metrics, decisions, gates, spec and output, and the node inspector with fork.
// The same workbench runs full-screen at /flow/trace.
import { AGENT_STATUS } from '../../theme/tokens'
import { TraceWorkbench, type WorkbenchChrome } from '../../trace/TraceView'

export function Flow() {
  return (
    <div className="g-flowpage">
      <TraceWorkbench embedded chrome={c => <FlowHead c={c} />} />
    </div>
  )
}

function FlowHead({ c }: { c: WorkbenchChrome }) {
  const connected = c.stream === 'open' && !c.apiDown
  const streamLabel = connected ? 'Trace stream connected' : c.apiDown ? 'Trace stream disconnected' : c.stream === 'connecting' ? 'Trace stream connecting' : 'Trace stream reconnecting'
  const fullHref = `/flow/trace${c.runId ? `?run=${encodeURIComponent(c.runId)}` : c.blueprint ? `?graph=${encodeURIComponent(c.blueprint)}` : ''}`
  return (
    <div className="g-page__head g-flowhead">
      <div>
        <div className="g-titlerow">
          <h1 className="g-h1">Agent flow</h1>
          <span className="g-tag">Technical</span>
        </div>
        <p className="g-sub">
          {c.blueprint
            ? `${c.blueprint} exactly as gren will run it; nothing has run yet. Code in grey, agents in blue, verifiers in green, the human in amber.`
            : 'Every run as the Strands graph saw it. Code in grey, agents in blue, verifiers in green, the human in amber.'}
        </p>
      </div>
      <div className="g-flowhead__actions">
        <span className="g-flowhead__stream g-desk" role="status" aria-live="polite">
          <span aria-hidden="true" className={`g-dot${connected ? ' g-dot--pulse' : ''}`} style={{ background: connected ? AGENT_STATUS.working : '#B9C3BD' }} />
          {streamLabel}
        </span>
        {c.live && c.runId && (
          <button type="button" className="g-btn g-btn--outline" onClick={c.cancelRun} disabled={c.busy}>
            Cancel run
          </button>
        )}
        <a className="g-btn g-btn--outline" href={fullHref}>
          Full screen{' '}
          <span aria-hidden="true" className="g-arrow">
            →
          </span>
        </a>
        <button type="button" className="g-btn g-btn--primary" onClick={c.runSweep} disabled={c.sweeping}>
          {c.sweeping ? 'Starting sweep…' : 'Run sweep now'}
        </button>
      </div>
    </div>
  )
}
