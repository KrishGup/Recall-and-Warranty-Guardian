// Per-user appearance preferences shared by the dashboard shell and the full trace view.
// Persisted in localStorage and applied as attributes on <html>, so the CSS variables and direction switch globally.
import { useCallback, useEffect, useState } from 'react'
import { DARK, LIGHT, type Theme } from './tokens'

export type Scheme = 'light' | 'dark'
export type Dir = 'ltr' | 'rtl'
const KEY_SCHEME = 'guardian.scheme'
const KEY_DIR = 'guardian.dir'

function read<T extends string>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return (v as T) || fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

export function readNumber(key: string, fallback: number): number {
  const v = Number(read(key, String(fallback)))
  return Number.isFinite(v) ? v : fallback
}
export function writeNumber(key: string, value: number) {
  write(key, String(value))
}

export function applyPrefs(scheme: Scheme, dir: Dir) {
  const el = document.documentElement
  el.dataset.theme = scheme
  el.setAttribute('dir', dir)
  el.setAttribute('lang', 'en')
}

/** Theme and direction with localStorage persistence. Returns the active Theme object for inline styles. */
export function usePrefs() {
  const [scheme, setScheme] = useState<Scheme>(() => read<Scheme>(KEY_SCHEME, 'light'))
  const [dir, setDir] = useState<Dir>(() => read<Dir>(KEY_DIR, 'ltr'))
  useEffect(() => {
    applyPrefs(scheme, dir)
    write(KEY_SCHEME, scheme)
    write(KEY_DIR, dir)
  }, [scheme, dir])
  const toggleScheme = useCallback(() => setScheme(s => (s === 'dark' ? 'light' : 'dark')), [])
  const toggleDir = useCallback(() => setDir(d => (d === 'rtl' ? 'ltr' : 'rtl')), [])
  const theme: Theme = scheme === 'dark' ? DARK : LIGHT
  return { scheme, dir, rtl: dir === 'rtl', dark: scheme === 'dark', theme, toggleScheme, toggleDir, setScheme, setDir }
}

/** matchMedia(max-width) as state. */
export function useNarrow(maxWidth: number): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(`(max-width: ${maxWidth}px)`).matches : false))
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`)
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [maxWidth])
  return narrow
}
