// Guardian API client. Same-origin: in dev, Vite proxies /api and /gren to the FastAPI server on 8787;
// in production FastAPI serves the built app and both APIs from one origin.
import { useEffect, useRef } from 'react'
import type { ActivityNight, AnswerResult, Decision, DecisionChoice, Decisions, GrenArtifact, GrenEvent, GrenGraphFile, GrenGraphInfo, GrenRun, GrenRunSummary, GuardianEvent, IntakeResult, Item, ItemDetail, ItemsPage, ItemsQuery, NewItem, Preferences, Summary, SweepOptions } from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`
    try {
      const b = (await res.json()) as { error?: string; detail?: unknown }
      msg = b.error || (typeof b.detail === 'string' ? b.detail : msg)
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg)
  }
  return (await res.json()) as T
}

const enc = encodeURIComponent
function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export async function get<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { headers: { accept: 'application/json' } }))
}
export async function send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return parse<T>(await fetch(path, { method, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))
}

export interface ApiShape {
  summary(): Promise<Summary>
  items(q?: ItemsQuery): Promise<ItemsPage>
  item(id: string): Promise<ItemDetail>
  createItem(body: NewItem): Promise<Item>
  importItems(items: NewItem[]): Promise<{ created: number; items: Item[] }>
  intake(text: string, source?: 'paste' | 'email'): Promise<IntakeResult>
  reportProblem(itemId: string, text: string): Promise<{ ok: boolean; decision: Decision | null; message: string }>
  decisions(): Promise<Decisions>
  answer(id: string, choice: DecisionChoice, by?: string, comment?: string): Promise<AnswerResult>
  activity(days?: number): Promise<{ nights: ActivityNight[] }>
  preferences(): Promise<Preferences>
  savePreferences(p: Preferences): Promise<Preferences>
  sweep(opts?: SweepOptions): Promise<{ run_id: string }>
  gren: {
    runs(all?: boolean): Promise<GrenRunSummary[]>
    run(id: string): Promise<GrenRun>
    events(id: string, after?: number): Promise<GrenEvent[]>
    artifact(id: string, path: string): Promise<GrenArtifact | null>
    approve(id: string, gate: string, decision: 'approved' | 'rejected', by?: string, comment?: string): Promise<{ ok: boolean }>
    fork(id: string, from: string[]): Promise<{ run_id: string }>
    resume(id: string): Promise<{ run_id: string }>
    cancel(id: string): Promise<{ ok: boolean }>
    graphs(): Promise<GrenGraphInfo[]>
    graph(path: string): Promise<GrenGraphFile>
    start(graph: string, input?: Record<string, unknown>): Promise<{ run_id: string }>
  }
}

const real: ApiShape = {
  summary: () => get('/api/summary'),
  items: (q = {}) => get(`/api/items${qs(q as Record<string, unknown>)}`),
  item: id => get(`/api/items/${enc(id)}`),
  createItem: body => send('POST', '/api/items', body),
  importItems: items => send('POST', '/api/items/import', { items }),
  intake: (text, source = 'paste') => send('POST', '/api/intake', { text, source }),
  reportProblem: (itemId, text) => send('POST', `/api/items/${enc(itemId)}/problem`, { text }),
  decisions: () => get('/api/decisions'),
  answer: (id, choice, by = 'dashboard', comment) => send('POST', `/api/decisions/${enc(id)}/answer`, { choice, by, comment }),
  activity: (days = 7) => get(`/api/activity?days=${days}`),
  preferences: () => get('/api/preferences'),
  savePreferences: p => send('PUT', '/api/preferences', p),
  sweep: (opts = {}) => send('POST', '/api/sweep', opts),
  gren: {
    runs: (all = false) => get(`/gren/api/runs${all ? '?all=1' : ''}`),
    run: id => get(`/gren/api/run?id=${enc(id)}`),
    events: (id, after = 0) => get(`/gren/api/run/events?id=${enc(id)}&after=${after}`),
    artifact: (id, path) => get(`/gren/api/run/artifact?id=${enc(id)}&path=${enc(path)}`),
    approve: (id, gate, decision, by = 'dashboard', comment) => send('POST', '/gren/api/run/approve', { id, gate, decision, by, comment }),
    fork: (id, from) => send('POST', '/gren/api/run/fork', { id, from }),
    resume: id => send('POST', '/gren/api/run/resume', { id }),
    cancel: id => send('POST', '/gren/api/run/cancel', { id }),
    graphs: () => get('/gren/api/graphs'),
    graph: path => get(`/gren/api/graph?path=${enc(path)}`),
    start: (graph, input = {}) => send('POST', '/gren/api/runs', { graph, input }),
  },
}

/** The API in use. `installApi` swaps in another implementation (the in-browser mock used by `VITE_MOCK=1`). */
export const Api: ApiShape = { ...real, gren: { ...real.gren } }
export function installApi(impl: Partial<ApiShape>) {
  Object.assign(Api, impl, impl.gren ? { gren: { ...Api.gren, ...impl.gren } } : {})
}

/** Subscribe to a server-sent event stream. Reconnects automatically; `onEvent` receives parsed JSON. */
export function useEventSource(url: string | null, onEvent: (e: GuardianEvent) => void, enabled = true) {
  const handler = useRef(onEvent)
  handler.current = onEvent
  useEffect(() => {
    if (!url || !enabled || typeof EventSource === 'undefined') return
    let es: EventSource | null = null
    let closed = false
    let retry = 1000
    const open = () => {
      if (closed) return
      es = new EventSource(url)
      es.onmessage = ev => {
        try {
          handler.current(JSON.parse(ev.data) as GuardianEvent)
          retry = 1000
        } catch {
          /* ignore malformed */
        }
      }
      es.onerror = () => {
        es?.close()
        if (!closed) setTimeout(open, retry)
        retry = Math.min(retry * 2, 15000)
      }
    }
    open()
    return () => {
      closed = true
      es?.close()
    }
  }, [url, enabled])
}

/** Small formatting helpers shared by the views. */
export const fmt = {
  ms(ms: number | null | undefined): string {
    if (ms == null) return '—'
    if (ms < 1000) return `${Math.round(ms)} ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
    if (ms < 3600000) return `${Math.floor(ms / 60000)} m ${Math.round((ms % 60000) / 1000)} s`
    return `${Math.floor(ms / 3600000)} h ${Math.round((ms % 3600000) / 60000)} m`
  },
  usd(v: number | null | undefined, digits = 3): string {
    return v == null ? '—' : `$${Number(v).toFixed(digits)}`
  },
  int(v: number | null | undefined): string {
    return v == null ? '—' : Number(v).toLocaleString()
  },
  time(iso: string | null | undefined): string {
    if (!iso) return '—'
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  },
  date(iso: string | null | undefined): string {
    if (!iso) return '—'
    const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  },
}
