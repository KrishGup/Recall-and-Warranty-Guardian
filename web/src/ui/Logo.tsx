// Guardian mark, option 1d "Night watch". The geometry is the one in design/avatars (the 1024 px renders) and
// public/favicon.svg, in a 48-unit box: the ink disc, a paper lid (the same circle) that rests at (38, 16) when open
// and at (29.8, 24) when closed (a thin crescent), and the status dot at (12, 34). A 1 px paper hairline separates
// the mark from the dark top bar. The lid swings aside 400 ms after load and stays open while the agent is not idle;
// the dot takes the agent status colour and pulses while a sweep runs (styles: .g-logo* in app/app.css).
import { useId } from 'react'
import { AGENT_STATUS, type AgentStatusKey } from '../theme/tokens'

export const LOGO_INK = '#000F08'
export const LOGO_PAPER = '#F7F4F3'

export function Logo({ status, open, size = 28, outline = true }: { status: AgentStatusKey; open?: boolean; size?: number; outline?: boolean }) {
  const clipId = 'g-logo-' + useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const isOpen = open ?? status !== 'idle'
  const cls = ['g-logo', isOpen ? 'is-open' : '', status === 'working' ? 'is-working' : '', outline ? 'g-logo--outlined' : ''].filter(Boolean).join(' ')
  return (
    <svg aria-hidden="true" focusable="false" className={cls} width={size} height={size} viewBox="0 0 48 48">
      <clipPath id={clipId}>
        <circle cx="24" cy="24" r="24" />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <circle cx="24" cy="24" r="24" fill={LOGO_INK} />
        <circle className="g-logo__dot" cx="12" cy="34" r="5" fill={AGENT_STATUS[status]} />
        <circle className="g-logo__lid" cx="24" cy="24" r="24" fill={LOGO_PAPER} />
      </g>
    </svg>
  )
}
