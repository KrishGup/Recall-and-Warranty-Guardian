// Agent flow — full trace view. The gren runs dashboard rebuilt in Guardian's shell: runs sidebar,
// pan/zoom graph canvas, bottom drawer with tabs, node inspector. Live data from /gren/api and /api/events.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Api } from '../api/client'
import type { GrenEvent, GuardianEvent } from '../api/types'
import { readNumber, useNarrow, usePrefs, writeNumber } from '../theme/prefs'
import { BREAKPOINT_TRACE_NARROW, type AgentStatusKey } from '../theme/tokens'
import { Canvas } from './Canvas'
import { useDecisions, useRun, useRunEvents, useRuns } from './data'
import { Drawer, type Tab } from './Drawer'
import type { GateInfo } from './GateCard'
import { Inspector } from './Inspector'
import { buildGraph, copyText, EMPTY_GRAPH, errorMessage, isLiveRun, modelShort, toYaml, waitingGates } from './model'
import { RunPicker, RunsSidebar } from './RunsSidebar'
import { useTraceStream } from './stream'
import { TopBar } from './TopBar'
import { clamp, Toast } from './ui'
import './trace.css'

const KEY_SIDE = 'guardian.trace.sideW'
const KEY_INSP = 'guardian.trace.inspW'
const KEY_DRAWER_H = 'guardian.trace.drawerH'
const KEY_DRAWER_OPEN = 'guardian.trace.drawerOpen'
const HOUSEHOLD_GATE = 'household_decision'

export function TraceView() {
  const { rtl, dark, theme, toggleScheme, toggleDir, setScheme, setDir } = usePrefs()
  const narrow = useNarrow(BREAKPOINT_TRACE_NARROW)
  const [params, setParams] = useSearchParams()
  // One-shot appearance overrides for links and screenshots: ?theme=dark|light&dir=ltr|rtl (persisted like the pills).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const t = q.get('theme')
    const d = q.get('dir')
    if (t === 'dark' || t === 'light') setScheme(t)
    if (d === 'ltr' || d === 'rtl') setDir(d)
  }, [setScheme, setDir])

  // ---- data
  const { runs, error: runsError, refresh: refreshRuns } = useRuns()
  const runId = params.get('run') ?? runs?.[0]?.id ?? null
  const summary = useMemo(() => runs?.find(r => r.id === runId) ?? null, [runs, runId])
  const onEventRef = useRef<(e: GuardianEvent) => void>(() => {})
  const stream = useTraceStream('/api/events', e => onEventRef.current(e))
  const [runStatusSeen, setRunStatusSeen] = useState<string | null>(null)
  const live = isLiveRun(runStatusSeen ?? summary?.status) || !!summary?.in_process
  const pollMs = live ? (stream === 'open' ? 6000 : 3000) : null
  const { run, error: runError, loading, refresh: refreshRun } = useRun(runId, pollMs)
  const { events, ingest, refresh: refreshEvents } = useRunEvents(runId, pollMs)
  useEffect(() => {
    setRunStatusSeen(run?.run.status ?? null)
  }, [run])
  const graph = useMemo(() => (run ? buildGraph(run) : EMPTY_GRAPH), [run])
  const gates = useMemo(() => waitingGates(run), [run])
  const { decisions, refresh: refreshDecisions } = useDecisions(gates.length > 0)

  // ---- selection and view state
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('events')
  const [busy, setBusy] = useState(false)
  const [sweeping, setSweeping] = useState(false)
  const [fitKey, setFitKey] = useState(0)
  const refit = useCallback(() => setFitKey(k => k + 1), [])
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | null>(null)
  const say = useCallback((m: string) => {
    setToast(m)
    if (toastTimer.current != null) clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3000)
  }, [])

  const selectRun = useCallback(
    (id: string) => {
      setParams(prev => {
        const next = new URLSearchParams(prev)
        next.set('run', id)
        return next
      })
      setSel(null)
    },
    [setParams],
  )
  const onSelect = useCallback((id: string | null) => setSel(id), [])
  // Drop a selection that no longer exists in the loaded graph.
  useEffect(() => {
    if (sel && run && !graph.byId[sel]) setSel(null)
  }, [sel, run, graph])
  // Re-fit when the inspector opens or closes, or the breakpoint flips.
  const inspectorOpen = !!sel && !!run
  useEffect(() => {
    refit()
  }, [inspectorOpen, narrow, refit])

  // ---- panel sizes (persisted)
  const [sideW, setSideW] = useState(() => clamp(readNumber(KEY_SIDE, 280), 220, 420))
  const [inspW, setInspW] = useState(() => clamp(readNumber(KEY_INSP, 380), 280, 600))
  const [drawerStored, setDrawerStored] = useState<number | null>(() => {
    const v = readNumber(KEY_DRAWER_H, 0)
    return v > 0 ? v : null
  })
  const [drawerOpen, setDrawerOpen] = useState(() => readNumber(KEY_DRAWER_OPEN, 1) !== 0)
  const [colH, setColH] = useState(800)
  const mainRef = useRef<HTMLDivElement>(null)
  const measuredOnce = useRef(false)
  useEffect(() => {
    const el = mainRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height ?? 0
      if (h > 0) setColH(h)
      if (!measuredOnce.current && h > 0) {
        measuredOnce.current = true
        if (h < 600) setDrawerOpen(false)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const drawerMax = Math.max(120, Math.round(colH * 0.45))
  const drawerDefault = Math.min(260, Math.round(colH * 0.32))
  const drawerH = clamp(drawerStored ?? drawerDefault, 120, drawerMax)
  const toggleDrawer = useCallback(() => {
    setDrawerOpen(o => {
      writeNumber(KEY_DRAWER_OPEN, o ? 0 : 1)
      return !o
    })
    refit()
  }, [refit])
  const onDrawerHeight = useCallback((h: number) => {
    setDrawerStored(h)
    setDrawerOpen(true)
  }, [])
  const commitDrawer = useCallback(() => {
    setDrawerStored(h => {
      if (h != null) writeNumber(KEY_DRAWER_H, h)
      return h
    })
    writeNumber(KEY_DRAWER_OPEN, 1)
    refit()
  }, [refit])
  const commitSide = useCallback(() => {
    setSideW(w => {
      writeNumber(KEY_SIDE, w)
      return w
    })
    refit()
  }, [refit])
  const commitInsp = useCallback(() => {
    setInspW(w => {
      writeNumber(KEY_INSP, w)
      return w
    })
    refit()
  }, [refit])

  // ---- clock for live durations (only ticks while something is running or waiting)
  const [now, setNow] = useState(() => Date.now())
  const ticking = live || gates.length > 0
  useEffect(() => {
    if (!ticking) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ticking])
  useEffect(() => {
    setNow(Date.now())
  }, [run])

  // ---- live stream → refetches (throttled inside the hooks)
  onEventRef.current = (e: GuardianEvent) => {
    if (e.run_id) {
      if (e.run_id === runId) {
        if (typeof e.seq === 'number') ingest(e as GrenEvent)
        refreshRun()
      }
      if (/^run\.|^node\.(started|completed|failed|skipped)|^gate\./.test(e.type)) refreshRuns()
      if (/^gate\./.test(e.type)) refreshDecisions()
    } else if (/decision|sweep|answer|intake|remedy/.test(e.type)) {
      refreshDecisions()
      refreshRuns()
      if (runId) {
        refreshRun()
        refreshEvents()
      }
    }
  }

  // ---- gate approval rule
  const decideGate = useCallback(
    async (gateId: string, approve: boolean) => {
      if (!run) return
      setBusy(true)
      try {
        const pending = (decisions?.pending ?? []).filter(d => d.run_id === run.run.id)
        if (gateId === HOUSEHOLD_GATE && pending.length) {
          for (const d of pending) await Api.answer(d.id, approve ? 'request_remedy' : 'not_mine', 'dashboard')
          say(approve ? `Approved ${pending.length} decision${pending.length === 1 ? '' : 's'} as dashboard · graph resumes into answers.` : `Rejected ${pending.length} decision${pending.length === 1 ? '' : 's'} · nothing is sent.`)
        } else {
          await Api.gren.approve(run.run.id, gateId, approve ? 'approved' : 'rejected', 'dashboard')
          say(approve ? 'Approval written · graph resumed.' : 'Rejected · downstream nodes are skipped.')
        }
        refreshRun()
        refreshRuns()
        refreshDecisions()
        refreshEvents()
      } catch (e) {
        say('Could not answer the gate: ' + errorMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [run, decisions, say, refreshRun, refreshRuns, refreshDecisions, refreshEvents],
  )
  const gateInfoFor = useCallback(
    (id: string | null): GateInfo | null => {
      if (!run || !id) return null
      const rec = run.nodes[id]
      if (!rec || (rec.status !== 'waiting_approval' && rec.status !== 'waiting_task')) return null
      return {
        gateId: id,
        rec,
        spec: graph.byId[id]?.spec ?? null,
        pending: (decisions?.pending ?? []).filter(d => d.run_id === run.run.id),
        household: id === HOUSEHOLD_GATE,
        busy,
        onDecide: decideGate,
      }
    },
    [run, graph, decisions, busy, decideGate],
  )
  const taskGate = useMemo(() => gateInfoFor(gates[0] ?? null), [gateInfoFor, gates])
  const selGate = useMemo(() => gateInfoFor(sel), [gateInfoFor, sel])

  // ---- actions
  const runSweep = useCallback(async () => {
    setSweeping(true)
    try {
      const r = await Api.sweep()
      refreshRuns()
      if (r.run_id) selectRun(r.run_id)
      say('Manual sweep started · feeds_refresh running.')
    } catch (e) {
      say('Could not start a sweep: ' + errorMessage(e))
    } finally {
      setSweeping(false)
    }
  }, [refreshRuns, selectRun, say])

  const copyPrompt = useCallback(async () => {
    if (!run || !sel) return
    const rec = run.nodes[sel]
    const att = [...(rec?.attempts ?? [])].reverse().find(a => a.artifact)
    const path = att?.artifact ?? rec?.artifact ?? null
    if (!path) {
      say('No prompt artifact recorded for this node.')
      return
    }
    setBusy(true)
    try {
      const art = await Api.gren.artifact(run.run.id, path)
      const prompt = art?.request?.prompt ?? art?.prompt ?? null
      if (!prompt) {
        say('This artifact has no prompt (deterministic node).')
        return
      }
      const ok = await copyText(prompt)
      say(ok ? `Last prompt copied · ${prompt.length.toLocaleString()} chars · ${modelShort(att?.model ?? art?.model) || 'artifact'}.` : 'The browser blocked clipboard access.')
    } catch (e) {
      say('Could not load the artifact: ' + errorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [run, sel, say])

  const copySpec = useCallback(async () => {
    if (!sel) return
    const spec = graph.byId[sel]?.spec
    if (!spec) {
      say('No spec entry for this node.')
      return
    }
    const ok = await copyText(toYaml(spec))
    say(ok ? 'Node spec copied as YAML.' : 'The browser blocked clipboard access.')
  }, [graph, sel, say])

  const fork = useCallback(async () => {
    if (!run || !sel) return
    setBusy(true)
    try {
      const r = await Api.gren.fork(run.run.id, [sel])
      refreshRuns()
      say(`Forked · ${r.run_id} resets ${sel} and everything downstream.`)
      selectRun(r.run_id)
    } catch (e) {
      say('Could not fork: ' + errorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [run, sel, refreshRuns, selectRun, say])

  const logoStatus: AgentStatusKey = gates.length ? 'pending' : live ? 'working' : 'idle'

  return (
    <div className="tr-root">
      <a href="#canvas" className="tr-skip">
        Skip to graph
      </a>
      <TopBar logoStatus={logoStatus} stream={stream} apiDown={!!runsError} dark={dark} rtl={rtl} sweeping={sweeping} onToggleScheme={toggleScheme} onToggleDir={toggleDir} onRunSweep={runSweep} />
      <div className="tr-body">
        {!narrow && <RunsSidebar runs={runs} error={runsError} selectedId={runId} onSelect={selectRun} width={sideW} onWidth={setSideW} onCommit={commitSide} theme={theme} rtl={rtl} />}
        <div className="tr-main" ref={mainRef}>
          {narrow && <RunPicker runs={runs} selectedId={runId} onSelect={selectRun} />}
          <Canvas
            run={run}
            runId={runId}
            graph={graph}
            rtl={rtl}
            theme={theme}
            narrow={narrow}
            sel={sel}
            onSelect={onSelect}
            fitKey={fitKey}
            now={now}
            loading={loading}
            error={runError ?? runsError}
            apiDown={!!runsError}
            hasRuns={!!runs?.length}
          />
          <Drawer
            run={run}
            graph={graph}
            events={events}
            tab={tab}
            onTab={t => {
              setTab(t)
              if (!drawerOpen) toggleDrawer()
            }}
            open={drawerOpen}
            onToggle={toggleDrawer}
            height={drawerH}
            maxH={drawerMax}
            onHeight={onDrawerHeight}
            onCommit={commitDrawer}
            sel={sel}
            onSelect={id => setSel(id)}
            gate={taskGate}
            theme={theme}
            now={now}
          />
        </div>
        {inspectorOpen && sel && run && graph.byId[sel] && (
          <Inspector
            run={run}
            graph={graph}
            sel={sel}
            onClose={() => setSel(null)}
            narrow={narrow}
            width={inspW}
            onWidth={setInspW}
            onCommit={commitInsp}
            rtl={rtl}
            theme={theme}
            now={now}
            gate={selGate}
            busy={busy}
            onCopyPrompt={() => void copyPrompt()}
            onCopySpec={() => void copySpec()}
            onFork={() => void fork()}
          />
        )}
      </div>
      <Toast message={toast} />
    </div>
  )
}
