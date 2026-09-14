// Data hooks for the trace view: runs list, one run, its event log and Guardian decisions.
// Every refetch goes through a throttle so a burst of engine events refreshes at most ~2×/s.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Api } from '../api/client'
import type { ActivityRow, Decisions, GrenEvent, GrenRun, GrenRunSummary } from '../api/types'
import { errorMessage } from './model'

/** Returns a stable trigger that runs `fn` at most once per `ms`, trailing. */
export function useThrottled(fn: () => void, ms: number): () => void {
  const ref = useRef(fn)
  ref.current = fn
  const last = useRef(0)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current != null) clearTimeout(timer.current)
    },
    [],
  )
  return useCallback(() => {
    if (timer.current != null) return
    const wait = Math.max(0, last.current + ms - Date.now())
    timer.current = window.setTimeout(() => {
      timer.current = null
      last.current = Date.now()
      ref.current()
    }, wait)
  }, [ms])
}

export function useRuns(pollMs = 15000) {
  const [runs, setRuns] = useState<GrenRunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      // all=1 so forked and nested runs show up in the sidebar too.
      const r = await Api.gren.runs(true)
      setRuns(r)
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [])
  useEffect(() => {
    void load()
    const t = window.setInterval(() => void load(), pollMs)
    return () => clearInterval(t)
  }, [load, pollMs])
  const refresh = useThrottled(() => void load(), 1000)
  return { runs, error, refresh }
}

/** The selected run. `pollMs` null disables background polling (completed runs do not change). */
export function useRun(id: string | null, pollMs: number | null) {
  const [run, setRun] = useState<GrenRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const gen = useRef(0)
  const load = useCallback(async () => {
    if (!id) return
    const g = ++gen.current
    try {
      const r = await Api.gren.run(id)
      if (g !== gen.current) return
      setRun(r)
      setError(null)
    } catch (e) {
      if (g !== gen.current) return
      setError(errorMessage(e))
    } finally {
      if (g === gen.current) setLoading(false)
    }
  }, [id])
  useEffect(() => {
    gen.current++
    setRun(null)
    setError(null)
    setLoading(!!id)
    void load()
  }, [id, load])
  useEffect(() => {
    if (!id || pollMs == null) return
    const t = window.setInterval(() => void load(), pollMs)
    return () => clearInterval(t)
  }, [id, pollMs, load])
  // A failed fetch (API restarting, transient proxy error) retries every 4 s until the run loads.
  useEffect(() => {
    if (!id || !error || run) return
    const t = window.setTimeout(() => void load(), 4000)
    return () => clearTimeout(t)
  }, [id, error, run, load])
  const refresh = useThrottled(() => void load(), 500)
  return { run, error, loading, refresh }
}

/** Event log of the selected run: full fetch on change, then contiguous appends from SSE or `after=` polls. */
export function useRunEvents(id: string | null, pollMs: number | null) {
  const [events, setEvents] = useState<GrenEvent[]>([])
  const lastSeq = useRef(0)
  const gen = useRef(0)
  const add = useCallback((list: GrenEvent[]) => {
    const fresh = list.filter(e => typeof e.seq === 'number' && e.seq > lastSeq.current).sort((a, b) => a.seq - b.seq)
    if (!fresh.length) return
    lastSeq.current = fresh[fresh.length - 1].seq
    setEvents(prev => prev.concat(fresh))
  }, [])
  const fetchMore = useCallback(async () => {
    if (!id) return
    const g = gen.current
    try {
      const more = await Api.gren.events(id, lastSeq.current)
      if (g !== gen.current) return
      add(more)
    } catch {
      /* the run refetch surfaces connectivity problems; the log simply lags */
    }
  }, [id, add])
  useEffect(() => {
    gen.current++
    lastSeq.current = 0
    setEvents([])
    void fetchMore()
  }, [id, fetchMore])
  useEffect(() => {
    if (!id || pollMs == null) return
    const t = window.setInterval(() => void fetchMore(), pollMs)
    return () => clearInterval(t)
  }, [id, pollMs, fetchMore])
  const refresh = useThrottled(() => void fetchMore(), 400)
  /** Feed a live engine event: appended when contiguous, otherwise the gap is filled from the API. */
  const ingest = useCallback(
    (ev: GrenEvent) => {
      if (ev.run_id !== id) return
      if (ev.seq === lastSeq.current + 1) add([ev])
      else if (ev.seq > lastSeq.current + 1) refresh()
    },
    [id, add, refresh],
  )
  return { events, ingest, refresh }
}

/** Guardian decision rows, fetched only while a household gate is waiting (see the gate approval rule). */
export function useDecisions(enabled: boolean) {
  const [decisions, setDecisions] = useState<Decisions | null>(null)
  const load = useCallback(async () => {
    if (!enabled) return
    try {
      setDecisions(await Api.decisions())
    } catch {
      /* keep the last rows */
    }
  }, [enabled])
  useEffect(() => {
    void load()
  }, [load])
  const refresh = useThrottled(() => void load(), 800)
  return { decisions, refresh }
}

/** Guardian's own account of a run: its activity rows (feeds pulled, matches, triage, gate, remedy), oldest first. */
export function useActivity(runId: string | null) {
  const [rows, setRows] = useState<ActivityRow[]>([])
  const load = useCallback(async () => {
    if (!runId || runId.startsWith('blueprint:')) {
      setRows([])
      return
    }
    try {
      const r = await Api.activity(60)
      const mine = r.nights.flatMap(n => n.rows).filter(x => x.run_id === runId)
      mine.sort((a, b) => a.at.localeCompare(b.at))
      setRows(mine)
    } catch {
      /* keep the last rows; the run itself reports connectivity */
    }
  }, [runId])
  useEffect(() => {
    void load()
  }, [load])
  const refresh = useThrottled(() => void load(), 1500)
  return { rows, refresh }
}
