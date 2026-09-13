// Guardian mark, option 1d "Night watch" (design/Guardian Logos.dc.html): a crescent that swings aside like a
// manhole lid to reveal the status dot. Open whenever status is not idle; the shell also opens it 400 ms after load.
import type { CSSProperties } from 'react'
import { AGENT_STATUS, type AgentStatusKey } from '../theme/tokens'

export function Logo({ status, open, size = 28 }: { status: AgentStatusKey; open?: boolean; size?: number }) {
  const col = AGENT_STATUS[status]
  const isOpen = open ?? status !== 'idle'
  const dot = Math.round((size * 9) / 28)
  const off = (size - dot) / 2
  const base: CSSProperties = { position: 'absolute', inset: 0, borderRadius: '50%' }
  return (
    <span aria-hidden="true" style={{ position: 'relative', width: size, height: size, borderRadius: '50%', background: '#F7F4F3', display: 'inline-block', overflow: 'hidden', flex: '0 0 auto' }}>
      <span style={{ ...base, background: '#000F08' }} />
      <span
        style={{
          position: 'absolute', width: dot, height: dot, borderRadius: '50%', background: col, left: off, top: off, transition: 'background-color .4s',
          animation: status === 'working' ? 'gPulse 1.1s ease-in-out infinite' : 'none', boxShadow: '0 0 0 2px #000F08',
        }}
      />
      <span style={{ ...base, background: '#F7F4F3', transformOrigin: '100% 50%', transform: isOpen ? 'translateX(58%) rotate(28deg)' : 'translateX(30%) rotate(0deg)', transition: 'transform .8s cubic-bezier(.2,.8,.2,1)' }} />
    </span>
  )
}
