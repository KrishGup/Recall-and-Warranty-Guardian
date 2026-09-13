// Guardian top bar for the trace view: logo (back to the dashboard), breadcrumb, TECHNICAL tag,
// live stream indicator, Dark/RTL pills and the primary "Run sweep now" action.
import { Link } from 'react-router-dom'
import { AGENT_STATUS, type AgentStatusKey } from '../theme/tokens'
import { Logo } from '../ui/Logo'
import type { StreamStatus } from './stream'

interface Props {
  logoStatus: AgentStatusKey
  stream: StreamStatus
  apiDown: boolean
  dark: boolean
  rtl: boolean
  sweeping: boolean
  onToggleScheme: () => void
  onToggleDir: () => void
  onRunSweep: () => void
}

export function TopBar({ logoStatus, stream, apiDown, dark, rtl, sweeping, onToggleScheme, onToggleDir, onRunSweep }: Props) {
  const connected = stream === 'open' && !apiDown
  const label = connected ? 'Trace stream connected' : apiDown ? 'Trace stream disconnected' : stream === 'connecting' ? 'Trace stream connecting' : 'Trace stream reconnecting'
  return (
    <header role="banner" className="tr-topbar">
      <Link to="/" className="tr-brand" aria-label="Back to Guardian dashboard">
        <Logo status={logoStatus} open />
        <span className="tr-wordmark">Guardian</span>
      </Link>
      <span aria-hidden="true" className="tr-slash">
        /
      </span>
      <span className="tr-crumb">Agent flow</span>
      <span className="tr-tag tr-desk">Technical</span>
      <div className="tr-spacer" />
      <span className="tr-stream tr-desk" role="status" aria-live="polite">
        <span aria-hidden="true" className={`tr-dot ${connected ? 'tr-pulse' : ''}`} style={{ background: connected ? AGENT_STATUS.working : '#B9C3BD' }} />
        {label}
      </span>
      <button type="button" className="tr-pill tr-desk" onClick={onToggleScheme} aria-pressed={dark}>
        {dark ? 'Light' : 'Dark'}
      </button>
      <button type="button" className="tr-pill tr-desk" onClick={onToggleDir} aria-label="Toggle text direction" aria-pressed={rtl}>
        {rtl ? 'LTR' : 'RTL'}
      </button>
      <button type="button" className="tr-pill tr-pill--primary" onClick={onRunSweep} disabled={sweeping}>
        {sweeping ? 'Starting sweep…' : 'Run sweep now'}
      </button>
    </header>
  )
}
