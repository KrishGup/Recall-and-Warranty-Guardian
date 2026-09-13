// Small presentational pieces shared by the shell and pages. Status is always a dot plus text.
import type { CSSProperties, ReactNode } from 'react'

export function Dot({ color, size = 8, pulse = false }: { color: string; size?: number; pulse?: boolean }) {
  return <span aria-hidden="true" className={`g-dot${pulse ? ' g-dot--pulse' : ''}`} style={{ width: size, height: size, background: color }} />
}

/** Colored dot + label in Habibi. */
export function Status({ color, children, size = 8, pulse = false, style }: { color: string; children: ReactNode; size?: number; pulse?: boolean; style?: CSSProperties }) {
  return (
    <span className="g-status" style={{ color, ...style }}>
      <Dot color={color} size={size} pulse={pulse} />
      {children}
    </span>
  )
}

/** Warranty progress bar. `pct` null means there is no warranty term; the bar stays empty and says so. */
export function Bar({ pct, color, height = 6, label = 'Warranty elapsed', maxWidth, style }: { pct: number | null | undefined; color: string; height?: number; label?: string; maxWidth?: number; style?: CSSProperties }) {
  const v = pct == null ? 0 : Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct == null ? undefined : v} aria-valuetext={pct == null ? 'no warranty term' : `${v}% elapsed`} className="g-bar" style={{ height, borderRadius: height / 2, maxWidth, ...style }}>
      <span style={{ width: `${v}%`, background: color, borderRadius: height / 2 }} />
    </div>
  )
}

export function Skeleton({ w = '100%', h = 14, style }: { w?: number | string; h?: number | string; style?: CSSProperties }) {
  return <span className="g-skel" aria-hidden="true" style={{ width: w, height: h, ...style }} />
}

export function ErrorNote({ message, onRetry, style }: { message: string; onRetry?: () => void; style?: CSSProperties }) {
  return (
    <div className="g-error" role="alert" style={style}>
      Could not load: {message}.{' '}
      {onRetry && (
        <button type="button" className="g-linkbtn g-ui" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

/** Muted "working" line with a pulsing accent dot, announced politely. */
export function Working({ children }: { children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="g-working">
      <Dot color="var(--accent)" pulse />
      {children}
    </div>
  )
}
