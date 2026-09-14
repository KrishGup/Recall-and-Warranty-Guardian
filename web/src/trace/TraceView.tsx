// Agent flow: the gren trace workbench. Runs and blueprints in a sidebar, a pan/zoom graph canvas, a bottom drawer
// (overview, timeline, event log, metrics, decisions, gates, spec, output), and a node inspector with fork. It renders
// in two frames: embedded in the dashboard's Agent flow page (/flow) or full-screen with its own top bar (/flow/trace).
// Live data from /gren/api and the /api/events stream; graph blueprints from /gren/api/graph when nothing has run.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Api } from '../api/client'
import type { GrenEvent, GrenGraphInfo, GuardianEvent } from '../api/types'
import { layoutViewport, readNumber, useNarrow, usePrefs, writeNumber } from '../theme/prefs'
import { BREAKPOINT_TRACE_NARROW, type AgentStatusKey } from '../theme/tokens'
import { DEFAULT_BLUEPRINT, isBlueprint, useBlueprint, useGraphs } from './blueprint'
import { Canvas } from './Canvas'
import { useActivity, useDecisions, useRun, useRunEvents, useRuns } from './data'
import { Drawer, type Tab } from './Drawer'
import type { GateInfo } from './GateCard'
import { Inspector } from './Inspector'
import { buildGraph, copyText, EMPTY_GRAPH, errorMessage, isLiveRun, modelShort, toYaml, waitingGates } from './model'
import type { OverviewActions } from './Overview'
import { RunDialog } from './RunDialog'
import { RunPicker, RunsSidebar } from './RunsSidebar'
import { useTraceStream, type StreamStatus } from './stream'
import { TopBar } from './TopBar'
import { clamp, Toast } from './ui'
import './trace.css'

const KEY_SIDE = 'guardian.trace.sideW'
const KEY_INSP = 'guardian.trace.inspW'
const KEY_DRAWER_H = 'guardian.trace.drawerH'
const KEY_DRAWER_OPEN = 'guardian.trace.drawerOpen'
const HOUSEHOLD_GATE = 'household_decision'

/** What the surrounding chrome (the full-screen top bar or the page header) shows and can trigger. */
export interface WorkbenchChrome {
  logoStatus: AgentStatusKey
  stream: StreamStatus
  apiDown: boolean
  sweeping: boolean
  busy: boolean
  runId: string | null
  /** Path of the graph file on show when no run is selected (nothing has run yet, or the user picked a blueprint). */
  blueprint: string | null
  live: boolean
  gates: number
  runSweep: () => void
  cancelRun: () => void
}

interface Props {
  /** Inside the dashboard page: no skip link, the frame is a bordered container, narrowness follows the container. */
  embedded?: boolean
  chrome?: (c: WorkbenchChrome) => ReactNode
}

export function TraceWorkbench({ embedded = false, chrome }: Props) {
  const { rtl, theme } = usePrefs()
  const windowNarrow = useNarrow(BREAKPOINT_TRACE_NARROW)
  const rootRef = useRef<HTMLDivElement>(null)
  const [rootW, setRootW] = useState(() => layoutViewport().width)
  useEffect(() => {
    const el = rootRef.current
    if (!embedded || !el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) setRootW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [embedded])
  const narrow = embedded ? rootW < BREAKPOINT_TRACE_NARROW : windowNarrow
  const [params, setParams] = useSearchParams()

  // ---- data
  const { runs, error: runsError, refresh: refreshRuns } = useRuns()
  const graphs = useGraphs()
  const graphParam = params.get('graph')
  const runParam = params.get('run')
  // A blueprint shows when asked for, or when nothing has ever run: the graph exactly as gren will execute it.
  const blueprintPath = graphParam ?? (runs && runs.length === 0 && !runParam ? DEFAULT_BLUEPRINT : null)
  const graphInfo: GrenGraphInfo | null = useMemo(() => (blueprintPath ? (graphs.find(g => g.path === blueprintPath) ?? null) : null), [graphs, blueprintPath])
  const runId = blueprintPath ? null : (runParam ?? runs?.[0]?.id ?? null)
  const summary = useMemo(() => runs?.find(r => r.id === runId) ?? null, [runs, runId])
  const onEventRef = useRef<(e: GuardianEvent) => void>(() => {})
  const stream = useTraceStream('/api/events', e => onEventRef.current(e))
  const [runStatusSeen, setRunStatusSeen] = useState<string | null>(null)
  const live = !!runId && (isLiveRun(runStatusSeen ?? summary?.status) || !!summary?.in_process)
  const pollMs = live ? (stream === 'open' ? 6000 : 3000) : null
  const { run: loadedRun, error: loadedError, loading: loadingRun, refresh: refreshRun } = useRun(runId, pollMs)
  const { events, ingest, refresh: refreshEvents } = useRunEvents(runId, pollMs)
  const { rows: activity, refresh: refreshActivity } = useActivity(runId)
  const { blueprint, error: blueprintError } = useBlueprint(blueprintPath)
  const run = blueprintPath ? blueprint : loadedRun
  const loading = blueprintPath ? !blueprint && !blueprintError : loadingRun
  const runError = blueprintPath ? blueprintError : loadedError
  useEffect(() => {
    setRunStatusSeen(loadedRun?.run.status ?? null)
  }, [loadedRun])
  const graph = useMemo(() => (run ? buildGraph(run) : EMPTY_GRAPH), [run])
  const gates = useMemo(() => waitingGates(run), [run])
  const { decisions, refresh: refreshDecisions } = useDecisions(gates.length > 0)

  // ---- selection and view state
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [busy, setBusy] = useState(false)
  const [sweeping, setSweeping] = useState(false)
  const [runDialog, setRunDialog] = useState<GrenGraphInfo | null>(null)
  const [fitKey, setFitKey] = useState(0)
  const refit = useCallback(() => setFitKey(k => k + 1), [])
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | null>(null)
  const say = useCallback((m: string) => {
    setToast(m)
    if (toastTimer.current != null) clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3500)
  }, [])

  const selectRun = useCallback(
    (id: string) => {
      setParams(prev => {
        const next = new URLSearchParams(prev)
        next.set('run', id)
        next.delete('graph')
        return next
      })
      setSel(null)
    },
    [setParams],
  )
  const selectGraph = useCallback(
    (path: string) => {
      setParams(prev => {
        const next = new URLSearchParams(prev)
        next.set('graph', path)
        next.delete('run')
        return next
      })
      setSel(null)
      setTab('overview')
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
  // Open by default unless the person closed it last time or the window is short (the canvas needs its room).
  const [drawerOpen, setDrawerOpen] = useState(() => {
    const stored = readNumber(KEY_DRAWER_OPEN, -1)
    if (stored === 0 || stored === 1) return stored === 1
    return layoutViewport().height >= 700
  })
  const [colH, setColH] = useState(800)
  const mainRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = mainRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height ?? 0
      if (h > 0) setColH(h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const drawerMax = Math.max(120, Math.round(colH * 0.55))
  const drawerDefault = Math.min(340, Math.round(colH * 0.42))
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
        refreshActivity()
      }
      if (/^run\.|^node\.(started|completed|failed|skipped)|^gate\./.test(e.type)) refreshRuns()
      if (/^gate\./.test(e.type)) refreshDecisions()
    } else if (/decision|sweep|answer|intake|remedy/.test(e.type)) {
      refreshDecisions()
      refreshRuns()
      refreshActivity()
      if (runId) {
        refreshRun()
        refreshEvents()
      }
    }
  }

  // ---- gate approval rule
  const decideGate = useCallback(
    async (gateId: string, approve: boolean) => {
      if (!run || isBlueprint(run)) return
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
        refreshActivity()
      } catch (e) {
        say('Could not answer the gate: ' + errorMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [run, decisions, say, refreshRun, refreshRuns, refreshDecisions, refreshEvents, refreshActivity],
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
  const gatesPending = useMemo(() => (run ? (decisions?.pending ?? []).filter(d => d.run_id === run.run.id).length : 0), [run, decisions])

  // ---- actions
  const runSweep = useCallback(async () => {
    setSweeping(true)
    try {
      const r = await Api.sweep()
      refreshRuns()
      if (r.run_id) selectRun(r.run_id)
      setTab('overview')
      say('Sweep started · feeds_refresh is running.')
    } catch (e) {
      say('Could not start a sweep: ' + errorMessage(e))
    } finally {
      setSweeping(false)
    }
  }, [refreshRuns, selectRun, say])

  const cancelRun = useCallback(async () => {
    if (!runId || !live) return
    setBusy(true)
    try {
      await Api.gren.cancel(runId)
      say('Cancel requested · the engine stops at the next node boundary.')
      refreshRuns()
      refreshRun()
    } catch (e) {
      say('Could not cancel: ' + errorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [runId, live, say, refreshRuns, refreshRun])

  const copyPrompt = useCallback(async () => {
    if (!run || !sel) return
    if (isBlueprint(run)) {
      say('A blueprint has no prompts yet; run the graph first.')
      return
    }
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

  const copyRunId = useCallback(async () => {
    if (!run) return
    const ok = await copyText(run.run.id)
    say(ok ? 'Run id copied.' : 'The browser blocked clipboard access.')
  }, [run, say])

  /** Fork from a node: everything before it is kept, the node and everything downstream run again. */
  const forkFrom = useCallback(
    async (node: string) => {
      if (!run) return
      if (isBlueprint(run)) {
        say('A blueprint cannot be forked; run the graph first, then fork from any node.')
        return
      }
      setBusy(true)
      try {
        const r = await Api.gren.fork(run.run.id, [node])
        refreshRuns()
        say(`Forked · ${r.run_id} re-runs ${node} and everything downstream.`)
        selectRun(r.run_id)
        setTab('overview')
      } catch (e) {
        say('Could not fork: ' + errorMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [run, refreshRuns, selectRun, say],
  )

  const openRunDialog = useCallback(() => {
    if (graphInfo) setRunDialog(graphInfo)
    else say('The graph list is still loading.')
  }, [graphInfo, say])

  const overview: OverviewActions = useMemo(
    () => ({
      live,
      busy,
      gatesPending,
      onSelectRun: selectRun,
      onSelectNode: id => setSel(id),
      onRetry: node => void forkFrom(node),
      onCancel: () => void cancelRun(),
      onRunGraph: openRunDialog,
      onCopyId: () => void copyRunId(),
    }),
    [live, busy, gatesPending, selectRun, forkFrom, cancelRun, openRunDialog, copyRunId],
  )

  const logoStatus: AgentStatusKey = gates.length ? 'pending' : live ? 'working' : 'idle'
  const ctx: WorkbenchChrome = { logoStatus, stream, apiDown: !!runsError, sweeping, busy, runId, blueprint: blueprintPath, live, gates: gates.length, runSweep: () => void runSweep(), cancelRun: () => void cancelRun() }

  return (
    <div ref={rootRef} className={embedded ? 'tr-embed' : 'tr-root'}>
      {!embedded && (
        <a href="#canvas" className="tr-skip">
          Skip to graph
        </a>
      )}
      {chrome?.(ctx)}
      <div className="tr-frame">
        <div className="tr-body">
          {!narrow && <RunsSidebar runs={runs} graphs={graphs} error={runsError} selectedId={runId} selectedGraph={blueprintPath} onSelect={selectRun} onSelectGraph={selectGraph} width={sideW} onWidth={setSideW} onCommit={commitSide} theme={theme} rtl={rtl} />}
          <div className="tr-main" ref={mainRef}>
            {narrow && <RunPicker runs={runs} graphs={graphs} selectedId={runId} selectedGraph={blueprintPath} onSelect={selectRun} onSelectGraph={selectGraph} />}
            <Canvas
              run={run}
              runId={run?.run.id ?? runId}
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
              onRetry={node => void forkFrom(node)}
            />
            <Drawer
              run={run}
              graph={graph}
              events={events}
              activity={activity}
              graphInfo={graphInfo}
              overview={overview}
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
              onFork={() => void forkFrom(sel)}
            />
          )}
        </div>
      </div>
      {runDialog && (
        <RunDialog
          graph={runDialog}
          onClose={() => setRunDialog(null)}
          onStarted={(id, note) => {
            refreshRuns()
            selectRun(id)
            setTab('overview')
            say(note)
          }}
        />
      )}
      <Toast message={toast} />
    </div>
  )
}

/** The full-screen surface at /flow/trace: the workbench under Guardian's top bar. */
export function TraceView() {
  const { rtl, dark, toggleScheme, toggleDir, setScheme, setDir } = usePrefs()
  // One-shot appearance overrides for links and screenshots: ?theme=dark|light&dir=ltr|rtl (persisted like the pills).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const t = q.get('theme')
    const d = q.get('dir')
    if (t === 'dark' || t === 'light') setScheme(t)
    if (d === 'ltr' || d === 'rtl') setDir(d)
  }, [setScheme, setDir])
  return <TraceWorkbench chrome={c => <TopBar logoStatus={c.logoStatus} stream={c.stream} apiDown={c.apiDown} dark={dark} rtl={rtl} sweeping={c.sweeping} onToggleScheme={toggleScheme} onToggleDir={toggleDir} onRunSweep={c.runSweep} />} />
}
