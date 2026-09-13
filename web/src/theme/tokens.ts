// Guardian design tokens. Source of truth: design/README.md ("Hard rules: fonts and colors").
// The five brand hexes are the only source of color; everything else below is a listed derivative.
export const PALETTE = {
  ink: '#000F08', // top nav background, text
  critical: '#960200', // critical buttons, flashbar, badges
  primary: '#2274A5', // primary action, links, selection, focus ring
  paper: '#F7F4F3', // page background (light), text on dark
  accent: '#FCBA04', // agent-quiet status, top-bar focus ring, technical tag
} as const

export interface Theme {
  bg: string
  surface: string
  ink: string
  ink2: string
  line: string
  primary: string
  primaryInk: string
  critical: string
  criticalBg: string
  ok: string
  tint: string
  faint: string
  warn: string // warranty 70-89 % elapsed
  amberLine: string // gate edges and "waiting" status text
}

export const LIGHT: Theme = {
  bg: '#F7F4F3', surface: '#FFFFFF', ink: '#000F08', ink2: '#4A5551', line: '#DDD7D4', primary: '#2274A5', primaryInk: '#FFFFFF',
  critical: '#960200', criticalBg: '#F8E6E4', ok: '#2E7D4F', tint: '#EFEBE9', faint: '#B9B3B0', warn: '#B8860B', amberLine: '#D9A004',
}

export const DARK: Theme = {
  bg: '#0A130E', surface: '#131F18', ink: '#F7F4F3', ink2: '#B9C3BD', line: '#2C3B33', primary: '#6FB3E3', primaryInk: '#000F08',
  critical: '#E4746A', criticalBg: '#3A1512', ok: '#5DBB86', tint: '#1C2A22', faint: '#4A5A52', warn: '#D9A004', amberLine: '#FCBA04',
}

/** Agent status colors (logo dot, header dot). */
export const AGENT_STATUS = { idle: '#FCBA04', pending: '#E0463A', working: '#3FBF7F' } as const
export type AgentStatusKey = keyof typeof AGENT_STATUS

/** Exactly three fonts, plus monospace for the forwarding address, code and structured output. */
export const FONTS = {
  heading: "'Roboto Slab', Georgia, serif", // headings, titles, numbers, timestamps, badge counts, wordmark
  body: 'Lora, Georgia, serif', // body, descriptions, table cells
  ui: 'Habibi, serif', // UI labels: nav, tabs, buttons, chips, pills, eyebrows, breadcrumbs, form labels, status text
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const

/** Node kind colors in the agent flow views. */
export function kindColors(t: Theme) {
  return {
    code: { c: t.ink2, ink: t.surface, label: 'Code' },
    agent: { c: t.primary, ink: t.primaryInk, label: 'Agent' },
    verify: { c: t.ok, ink: '#FFFFFF', label: 'Verify' },
    gate: { c: PALETTE.accent, ink: PALETTE.ink, label: 'Gate · human' },
    router: { c: t.ink, ink: t.surface, label: 'Router' },
    loop: { c: t.ink2, ink: t.surface, label: 'Loop' },
    subgraph: { c: t.ink2, ink: t.surface, label: 'Subgraph' },
  } as const
}

export const BREAKPOINT_NARROW = 860 // dashboard shell
export const BREAKPOINT_TRACE_NARROW = 900 // full trace view

/** Warranty bar color by elapsed share: ok below 70 %, amber 70-89 %, critical at 90 % and above. */
export function warrantyColor(t: Theme, pct: number): string {
  return pct >= 90 ? t.critical : pct >= 70 ? t.warn : t.ok
}
