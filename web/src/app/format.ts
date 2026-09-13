// Small presentation helpers shared by the shell and pages. Colors are returned as CSS variable references so they
// follow the active theme; the values live in theme/global.css and mirror theme/tokens.ts.
import type { Decision, RecallState, Tone } from '../api/types'

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || 'Request failed'
  return typeof e === 'string' && e ? e : 'Request failed'
}

/** Activity/decision tone → text and dot color. */
export function toneVar(t: Tone | string | null | undefined): string {
  switch (t) {
    case 'ok':
      return 'var(--ok)'
    case 'critical':
      return 'var(--critical)'
    case 'warn':
      return 'var(--warn)'
    default:
      return 'var(--ink2)'
  }
}

/** Recall state → status color. Never used alone: every dot is paired with the recall label. */
export function recallVar(state: RecallState | string): string {
  switch (state) {
    case 'critical_match':
      return 'var(--critical)'
    case 'standard_match':
    case 'candidate':
      return 'var(--warn)'
    case 'clear':
    case 'resolved':
      return 'var(--ok)'
    default:
      return 'var(--ink2)'
  }
}

/** Past-decision outcome color from the label the API builds (see guardian/service.py decision_view). */
export function pastVar(d: Decision): string {
  const label = (d.past_label ?? '').toLowerCase()
  if (label.startsWith('snoozed') || d.state === 'expired' || d.state === 'snoozed') return 'var(--ink2)'
  if (/^(closed|remedy|checked|done|claim)/.test(label)) return 'var(--ok)'
  return d.severity === 'critical' ? 'var(--critical)' : 'var(--ink2)'
}

export function money(v: number | null | undefined, currency = 'USD'): string {
  if (v == null) return '—'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(v)
  } catch {
    return `$${v.toFixed(2)}`
  }
}

export function excerpt(s: string | null | undefined, n: number): string {
  if (!s) return ''
  const t = s.trim()
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** "opus" → "Claude Opus"; unknown ids pass through. */
export function modelLabel(model: string | null | undefined): string {
  if (!model) return 'deterministic'
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'Claude Opus'
  if (m.includes('sonnet')) return 'Claude Sonnet'
  if (m.includes('haiku')) return 'Claude Haiku'
  return model
}
