// Small shared pieces for the trace view: pointer drag helper, resize separators, toast.
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'

/** Window-level pointer drag. `onMove` gets the delta from the pointer-down point; `onUp` whether it moved > 3 px. */
export function startDrag(e: ReactPointerEvent, onMove: (dx: number, dy: number) => void, onUp?: (moved: boolean) => void) {
  e.preventDefault()
  const sx = e.clientX
  const sy = e.clientY
  let moved = false
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - sx
    const dy = ev.clientY - sy
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
    onMove(dx, dy)
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    onUp?.(moved)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

interface ResizerProps {
  label: string
  orientation: 'vertical' | 'horizontal'
  min: number
  max: number
  value: number
  /** Convert a pointer delta into a size delta (sign handles RTL and which edge the handle sits on). */
  toDelta: (dx: number, dy: number) => number
  /** Keys that grow / shrink the panel by 24 px. */
  grow: string
  shrink: string
  onChange: (next: number) => void
  onCommit?: () => void
  className?: string
  style?: CSSProperties
}

/** role=separator handle: pointer drag and arrow-key resize (24 px steps), announced with aria-value*. */
export function Resizer({ label, orientation, min, max, value, toDelta, grow, shrink, onChange, onCommit, className, style }: ResizerProps) {
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    const start = value
    startDrag(
      e,
      (dx, dy) => onChange(clamp(start + toDelta(dx, dy), min, max)),
      () => onCommit?.(),
    )
  }
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== grow && e.key !== shrink) return
    e.preventDefault()
    onChange(clamp(value + (e.key === grow ? 24 : -24), min, max))
    onCommit?.()
  }
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      className={`tr-sep ${orientation === 'horizontal' ? 'tr-sep--h' : ''} ${className ?? ''}`}
      style={style}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      <span aria-hidden="true" className="tr-grip" />
    </div>
  )
}

export function Toast({ message }: { message: string }) {
  return (
    <div role="status" aria-live="polite" className="tr-toast" hidden={!message}>
      {message}
    </div>
  )
}

export function Dot({ color, pulse, size = 8 }: { color: string; pulse?: boolean; size?: number }) {
  return <span aria-hidden="true" className={`tr-dot ${pulse ? 'tr-fade' : ''}`} style={{ background: color, width: size, height: size }} />
}
