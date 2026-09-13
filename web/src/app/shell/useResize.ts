// Pointer + keyboard resizing for the side nav, info panel and split panel separators (role="separator").
// `sign` maps pointer movement to growth: +1 when moving right/down grows the panel, -1 otherwise (RTL flips it).
import { useCallback, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { clamp } from '../format'

export interface ResizeOptions {
  value: number
  min: number
  max: number
  set: (v: number) => void
  axis: 'x' | 'y'
  sign: 1 | -1
  growKey: string
  shrinkKey: string
  step?: number
}

export function useResize(o: ResizeOptions) {
  const ref = useRef(o)
  useLayoutEffect(() => {
    ref.current = o
  })
  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.preventDefault()
    const { value, axis } = ref.current
    const start = axis === 'x' ? e.clientX : e.clientY
    const cls = axis === 'x' ? 'g-dragging-x' : 'g-dragging-y'
    document.body.classList.add(cls)
    const move = (ev: PointerEvent) => {
      const { min, max, sign, set } = ref.current
      const cur = axis === 'x' ? ev.clientX : ev.clientY
      set(clamp(value + (cur - start) * sign, min, max))
    }
    const up = () => {
      document.body.classList.remove(cls)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [])
  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    const { value, min, max, set, growKey, shrinkKey, step = 24 } = ref.current
    if (e.key === growKey) set(clamp(value + step, min, max))
    else if (e.key === shrinkKey) set(clamp(value - step, min, max))
    else if (e.key === 'Home') set(min)
    else if (e.key === 'End') set(max)
    else return
    e.preventDefault()
  }, [])
  return { onPointerDown, onKeyDown }
}
