// Pan/zoom SVG canvas of the run graph: node cards, edges with markers, toolbar, run strip, legend, edge tooltip.
// Owns the viewport (view transform, dragged positions, critical-path toggle); selection lives in TraceView.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { fmt } from '../api/client'
import { isBlueprint } from './blueprint'
import { waitingFor } from './GateCard'
import type { GrenNodeRecord, GrenRun } from '../api/types'
import { FONTS, kindColors, type Theme } from '../theme/tokens'
import {
  criticalNodes, edgePath, ellipsis, isWaiting, layout, nodeBadge, nodeRight, nodeStatus, nodeSub, relatedSet, runStatus, waitingGates, type Box, type GEdge, type Graph, type PosMap,
} from './model'
import { startDrag } from './ui'

interface View {
  x: number
  y: number
  k: number
}

interface Props {
  run: GrenRun | null
  runId: string | null
  graph: Graph
  rtl: boolean
  theme: Theme
  narrow: boolean
  sel: string | null
  onSelect: (id: string | null) => void
  /** Bump to re-fit the viewport (panel resize, drawer toggle, inspector open/close, run change). */
  fitKey: number
  now: number
  loading: boolean
  error: string | null
  /** The runs list itself failed: the API is unreachable rather than one run missing. */
  apiDown: boolean
  hasRuns: boolean
  /** Fork the run from a node (the banner's "Retry from …" on a failed run). */
  onRetry?: (node: string) => void
}

const MARKERS = { faint: 'gArrow', primary: 'gArrowC', amber: 'gArrowG', critical: 'gArrowR', ink: 'gArrowK', ok: 'gArrowOk' } as const

/** The node the camera should centre on: the gate that waits, else the running node furthest along the graph, else
 *  the middle of the graph (triage in the sweep). Returns '' when there is nothing to focus. */
function focusNode(run: Props['run'], graph: Props['graph'], pos: PosMap): string {
  const recs = run?.nodes ?? {}
  const ids = Object.keys(recs)
  const waiting = ids.find(id => isWaiting(recs[id].status))
  if (waiting) return waiting
  const running = ids.filter(id => recs[id].status === 'running' && pos[id])
  if (running.length) return running.reduce((a, b) => (pos[b].x > pos[a].x ? b : a))
  return pos.triage ? 'triage' : graph.nodes[Math.floor(graph.nodes.length / 2)]?.id ?? ''
}

export function Canvas({ run, runId, graph, rtl, theme, narrow, sel, onSelect, fitKey, now, loading, error, apiDown, hasRuns, onRetry }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const [override, setOverride] = useState<PosMap>({})
  // True once the user panned or zoomed this run; the camera then stops following the run until Fit or a new run.
  const userMovedRef = useRef(false)
  const animRef = useRef<number | null>(null)
  const hasLayoutRef = useRef(false)
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null)
  const [showCritical, setShowCritical] = useState(true)
  const [panning, setPanning] = useState(false)
  const [size, setSize] = useState({ w: 1200, h: 600 })

  const levelsKey = JSON.stringify(graph.levels)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const basePos = useMemo(() => layout(graph.levels, rtl), [levelsKey, rtl])
  const pos = useMemo<PosMap>(() => ({ ...basePos, ...override }), [basePos, override])
  const posRef = useRef(pos)
  posRef.current = pos
  const runRef = useRef(run)
  runRef.current = run
  const graphRef = useRef(graph)
  graphRef.current = graph

  const cpSet = useMemo(() => new Set(showCritical ? criticalNodes(run) : []), [run, showCritical])
  const relSet = useMemo(() => relatedSet(sel, graph.edges), [sel, graph.edges])
  const paths = useMemo(() => graph.edges.map(e => (pos[e.from] && pos[e.to] ? edgePath(pos[e.from], pos[e.to], e.repair, rtl) : '')), [graph.edges, pos, rtl])

  // Reset dragged positions and follow mode when the run changes.
  useEffect(() => {
    setOverride({})
    userMovedRef.current = false
  }, [runId])

  // Animate the view to a target over ~400 ms (programmatic moves only; user pans stay direct).
  const moveTo = useCallback((target: View, animate: boolean) => {
    if (animRef.current != null) cancelAnimationFrame(animRef.current)
    if (!animate) {
      setView(target)
      return
    }
    const from = viewRef.current
    const t0 = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / 420)
      const e = 1 - Math.pow(1 - p, 3)
      setView({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e })
      animRef.current = p < 1 ? requestAnimationFrame(step) : null
    }
    animRef.current = requestAnimationFrame(step)
  }, [])

  const fit = useCallback(
    (animate = false) => {
      const svg = svgRef.current
      if (!svg) return
      const r = svg.getBoundingClientRect()
      if (r.width < 10 || r.height < 10) return
      const ps = Object.values(posRef.current)
      if (!ps.length) return
      const minX = Math.min(...ps.map(p => p.x))
      const minY = Math.min(...ps.map(p => p.y))
      const maxX = Math.max(...ps.map(p => p.x + p.w))
      const maxY = Math.max(...ps.map(p => p.y + p.h))
      const bw = Math.max(1, maxX - minX)
      const bh = Math.max(1, maxY - minY)
      const raw = Math.min((r.width - 60) / bw, (r.height - 120) / bh)
      const k = Math.min(1.2, Math.max(0.6, raw))
      if (raw >= 0.6) {
        moveTo({ k, x: (r.width - bw * k) / 2 - minX * k, y: (r.height - bh * k) / 2 - minY * k + 20 }, animate)
        return
      }
      // The graph does not fit at a readable zoom: centre on the front of the run (the gate that waits, else the
      // running node furthest along, else the middle of the graph) and keep the graph's edges inside the canvas.
      const f = posRef.current[focusNode(runRef.current, graphRef.current, posRef.current)] || ps[0]
      let x = r.width / 2 - (f.x + f.w / 2) * k
      let y = r.height / 2 - (f.y + f.h / 2) * k + 20
      const m = 30
      if (bw * k > r.width - 2 * m) x = Math.max(r.width - m - maxX * k, Math.min(m - minX * k, x))
      if (bh * k > r.height - 2 * m) y = Math.max(r.height - m - maxY * k, Math.min(m - minY * k, y))
      else y = (r.height - bh * k) / 2 - minY * k + 20
      moveTo({ k, x, y }, animate)
    },
    [moveTo],
  )

  // The camera follows a live run until the user takes over (pan, zoom, drag); Fit hands it back.
  const focusId = focusNode(run, graph, pos)
  useEffect(() => {
    if (!hasLayoutRef.current || userMovedRef.current) return
    const id = requestAnimationFrame(() => fit(true))
    return () => cancelAnimationFrame(id)
  }, [focusId, fit])

  // Re-fit on request (panels, drawer, inspector, run change, direction) once the layout exists,
  // and again whenever the layout changes shape: a live run reveals its nodes level by level.
  const hasLayout = graph.nodes.length > 0
  hasLayoutRef.current = hasLayout
  useEffect(() => {
    if (!hasLayout) return
    const id = requestAnimationFrame(() => fit())
    return () => cancelAnimationFrame(id)
  }, [fitKey, runId, rtl, hasLayout, levelsKey, fit])

  // Size of the canvas (legend visibility) and a debounced re-fit on resize. The svg is observed
  // too: a banner above it (waiting, failed, cancelled) changes its height without touching the section.
  useEffect(() => {
    const el = sectionRef.current
    const svg = svgRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let timer: number | null = null
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.target === el) setSize({ w: entry.contentRect.width, h: entry.contentRect.height })
      }
      if (timer != null) clearTimeout(timer)
      timer = window.setTimeout(() => fit(), 120)
    })
    ro.observe(el)
    if (svg) ro.observe(svg)
    return () => {
      ro.disconnect()
      if (timer != null) clearTimeout(timer)
    }
  }, [fit])

  // Wheel zoom around the cursor (non-passive so the page never scrolls).
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      const v = viewRef.current
      const k2 = Math.min(3, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0015)))
      userMovedRef.current = true
      if (animRef.current != null) cancelAnimationFrame(animRef.current)
      setView({ x: mx - (mx - v.x) * (k2 / v.k), y: my - (my - v.y) * (k2 / v.k), k: k2 })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const zoom = useCallback((f: number) => {
    const svg = svgRef.current
    const r = svg ? svg.getBoundingClientRect() : { width: 800, height: 400 }
    const v = viewRef.current
    const mx = r.width / 2
    const my = r.height / 2
    const k2 = Math.min(3, Math.max(0.2, v.k * f))
    userMovedRef.current = true
    if (animRef.current != null) cancelAnimationFrame(animRef.current)
    setView({ x: mx - (mx - v.x) * (k2 / v.k), y: my - (my - v.y) * (k2 / v.k), k: k2 })
  }, [])

  const onCanvasPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    const t = e.target as Element
    if (t.closest('.tr-node') || t.closest('.tr-edge-hit')) return
    const v0 = viewRef.current
    userMovedRef.current = true
    if (animRef.current != null) cancelAnimationFrame(animRef.current)
    setPanning(true)
    startDrag(
      e,
      (dx, dy) => setView({ x: v0.x + dx, y: v0.y + dy, k: v0.k }),
      () => setPanning(false),
    )
  }

  const onNodePointerDown = useCallback(
    (id: string, e: ReactPointerEvent<SVGGElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      const start = posRef.current[id]
      if (!start) return
      const k = viewRef.current.k
      startDrag(
        e,
        (dx, dy) => setOverride(o => ({ ...o, [id]: { ...start, x: start.x + dx / k, y: start.y + dy / k } })),
        moved => {
          if (!moved) onSelect(id)
        },
      )
    },
    [onSelect],
  )
  const onNodeKeyDown = useCallback(
    (id: string, e: ReactKeyboardEvent<SVGGElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onSelect(id)
      }
    },
    [onSelect],
  )

  const autoLayout = () => {
    setOverride({})
    requestAnimationFrame(() => fit())
  }

  const edgeHover = (i: number, e: ReactPointerEvent) => {
    const r = svgRef.current?.getBoundingClientRect()
    if (!r) return
    setHover({ i, x: e.clientX - r.left + 14, y: e.clientY - r.top + 14 })
  }

  const kinds = kindColors(theme)
  const recs = run?.nodes ?? {}
  const st = isBlueprint(run) ? { ...runStatus(theme, 'created'), label: 'Blueprint · not run yet', pulse: false } : runStatus(theme, run?.run.status)
  const gates = waitingGates(run)
  const legendVisible = !narrow && size.h >= 300 && size.w >= 760
  const hoverEdge: GEdge | null = hover && graph.edges[hover.i] ? graph.edges[hover.i] : null
  // One line that says what this run needs from the reader, with the one action that answers it.
  const failedRec = Object.values(recs).find(r => r.status === 'failed')
  const banner: { kind: 'failed' | 'waiting' | 'muted'; title: string; text: string; action: { label: string; fn: () => void } | null } | null =
    !run || isBlueprint(run)
      ? null
      : run.run.status === 'failed' && failedRec
        ? { kind: 'failed', title: `Failed at ${failedRec.id}.`, text: ellipsis(failedRec.error ?? run.run.error ?? '', 160), action: onRetry ? { label: `Retry from ${failedRec.id}`, fn: () => onRetry(failedRec.id) } : null }
        : gates.length
          ? { kind: 'waiting', title: `Waiting on you at ${gates[0]}`, text: `for ${waitingFor(recs[gates[0]], now)}. Nothing downstream runs until it is answered.`, action: { label: 'Open the gate', fn: () => onSelect(gates[0]) } }
          : run.run.status === 'cancelled'
            ? { kind: 'muted', title: 'Cancelled.', text: 'Nodes after the cancel point did not run.', action: null }
            : null

  return (
    <section id="canvas" ref={sectionRef} tabIndex={-1} aria-label="Run graph" className="tr-canvas" onKeyDown={e => e.key === 'Escape' && onSelect(null)}>
      <svg
        ref={svgRef}
        role="img"
        aria-label={run ? `Graph of the ${run.run.graph} run` : 'Run graph'}
        className={`tr-svg ${panning ? 'is-panning' : ''}`}
        onPointerDown={onCanvasPointerDown}
      >
        <defs>
          <Marker id={MARKERS.faint} color={theme.faint} />
          <Marker id={MARKERS.primary} color={theme.primary} />
          <Marker id={MARKERS.amber} color={theme.amberLine} />
          <Marker id={MARKERS.critical} color={theme.critical} />
          <Marker id={MARKERS.ink} color={theme.ink} />
          <Marker id={MARKERS.ok} color={theme.ok} />
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {graph.edges.map((e, i) => {
            const d = paths[i]
            if (!d) return null
            const s1 = recs[e.from]?.status
            const s2 = recs[e.to]?.status
            const active = s1 === 'completed' && (s2 === 'completed' || s2 === 'running' || isWaiting(s2))
            const crit = !e.repair && cpSet.has(e.from) && cpSet.has(e.to)
            const hi = !!sel && (e.from === sel || e.to === sel)
            const dim = !!sel && !hi && !(relSet.has(e.from) && relSet.has(e.to))
            let stroke = theme.faint
            let dash: string | undefined
            let width = 1.6
            let mk: string = MARKERS.faint
            if (e.kind === 'gate') {
              stroke = theme.amberLine
              dash = '7 4'
              mk = MARKERS.amber
            } else if (e.repair) {
              stroke = theme.critical
              dash = '4 3'
              mk = MARKERS.critical
            } else if (e.kind === 'route' || e.kind === 'order' || e.kind === 'status') {
              stroke = theme.ink
              mk = MARKERS.ink
            } else if (active) {
              stroke = theme.ok
              mk = MARKERS.ok
            }
            if (crit) {
              stroke = theme.primary
              width = 2.6
              mk = MARKERS.primary
            }
            if (hi) {
              stroke = theme.primary
              width = 2.8
              mk = MARKERS.primary
            }
            return (
              <g key={`${e.from}>${e.to}:${e.kind}`}>
                <path
                  d={d}
                  className="tr-edge-hit"
                  fill="none"
                  stroke="transparent"
                  strokeWidth={14}
                  style={{ cursor: 'pointer' }}
                  onPointerEnter={ev => edgeHover(i, ev)}
                  onPointerMove={ev => edgeHover(i, ev)}
                  onPointerLeave={() => setHover(null)}
                />
                <path d={d} fill="none" stroke={stroke} strokeWidth={width} strokeDasharray={dash} markerEnd={`url(#${mk})`} opacity={dim ? 0.18 : 1} style={{ pointerEvents: 'none', transition: 'stroke .15s, opacity .15s' }} />
              </g>
            )
          })}
          {graph.nodes.map(n => {
            const P = pos[n.id]
            if (!P) return null
            const rec = recs[n.id]
            const ss = nodeStatus(theme, rec?.status)
            return (
              <NodeCard
                key={n.id}
                id={n.id}
                box={P}
                kindColor={kinds[n.kind]?.c ?? theme.ink2}
                kindLabel={(kinds[n.kind]?.label ?? n.kind).split(' · ')[0].toUpperCase()}
                status={rec?.status ?? 'pending'}
                dot={ss.dot}
                pulse={ss.pulse}
                statusLabel={ss.label}
                sub={ellipsis(nodeSub(n), 34)}
                badge={nodeBadge(rec, n)}
                right={nodeRight(rec, now)}
                isSel={sel === n.id}
                dim={!!sel && sel !== n.id && !relSet.has(n.id)}
                onCp={cpSet.has(n.id)}
                rtl={rtl}
                theme={theme}
                onDown={onNodePointerDown}
                onKey={onNodeKeyDown}
              />
            )
          })}
        </g>
      </svg>

      <div className="tr-toolbar">
        <div role="group" aria-label="View" className="tr-group">
          <button
            type="button"
            className="tr-btn"
            onClick={() => {
              userMovedRef.current = false
              fit(true)
            }}
          >
            Fit
          </button>
          <button type="button" className="tr-btn tr-btn--icon" aria-label="Zoom in" onClick={() => zoom(1.25)}>
            +
          </button>
          <button type="button" className="tr-btn tr-btn--icon" aria-label="Zoom out" onClick={() => zoom(0.8)}>
            −
          </button>
        </div>
        <button type="button" className="tr-btn" aria-pressed={showCritical} onClick={() => setShowCritical(v => !v)}>
          Critical path
        </button>
        <button type="button" className="tr-btn" onClick={autoLayout}>
          Auto-layout
        </button>
      </div>

      {banner && (
        <div className={`tr-runbanner tr-runbanner--${banner.kind}`} role={banner.kind === 'failed' ? 'alert' : 'status'}>
          <span className="tr-runbanner-text">
            <b>{banner.title}</b> {banner.text}
          </span>
          {banner.action && (
            <button type="button" className="tr-btn tr-btn--sm" onClick={banner.action.fn}>
              {banner.action.label}
            </button>
          )}
        </div>
      )}

      {run && (
        <div className="tr-strip tr-desk">
          <span className="tr-status" style={{ color: st.text }}>
            <span aria-hidden="true" className={`tr-dot ${st.pulse ? 'tr-fade' : ''}`} style={{ background: st.dot }} />
            {st.label}
          </span>
          <span aria-hidden="true" className="tr-strip-sep">
            |
          </span>
          <span className="tr-num">{fmt.usd(run.metrics?.cost_usd ?? run.run.totals?.cost_usd)}</span>
          <span aria-hidden="true" className="tr-strip-sep">
            |
          </span>
          <span className="tr-num">{fmt.ms(run.metrics?.wall_ms ?? run.run.totals?.wall_ms)}</span>
          {gates.length > 0 && (
            <button type="button" className="tr-gatebtn" onClick={() => onSelect(gates[0])}>
              {gates.length} gate{gates.length === 1 ? '' : 's'} waiting
            </button>
          )}
        </div>
      )}

      {legendVisible && (
        <div className="tr-legend">
          <span>
            <span aria-hidden="true" className="tr-swatch" style={{ borderTop: `3px solid ${theme.primary}` }} />
            critical path
          </span>
          <span>
            <span aria-hidden="true" className="tr-swatch" style={{ borderTop: `2px solid ${theme.ink2}` }} />
            data
          </span>
          <span>
            <span aria-hidden="true" className="tr-swatch" style={{ borderTop: `2px dashed ${theme.amberLine}` }} />
            gate
          </span>
          <span>
            <span aria-hidden="true" className="tr-swatch" style={{ borderTop: `2px dashed ${theme.critical}` }} />
            repair
          </span>
          <span>
            <span aria-hidden="true" className="tr-swatch" style={{ borderTop: `2px solid ${theme.ink}` }} />
            route
          </span>
          <span className="tr-legend-sep" aria-hidden="true" />
          <span>
            <span aria-hidden="true" className="tr-dot" style={{ background: theme.ok }} />
            done
          </span>
          <span>
            <span aria-hidden="true" className="tr-dot" style={{ background: theme.primary }} />
            running
          </span>
          <span>
            <span aria-hidden="true" className="tr-dot" style={{ background: theme.amberLine }} />
            waiting on you
          </span>
          <span>
            <span aria-hidden="true" className="tr-dot" style={{ background: theme.critical }} />
            failed
          </span>
          <span>
            <span aria-hidden="true" className="tr-dot" style={{ background: theme.faint }} />
            skipped or not yet
          </span>
          <span className="tr-legend-sep" aria-hidden="true" />
          <span>drag nodes · wheel to zoom · hover an edge to see what crosses it</span>
        </div>
      )}

      {hover && hoverEdge && (
        <div role="tooltip" className="tr-tip" style={{ left: hover.x, top: hover.y }}>
          <div className="tr-tip-title">
            {hoverEdge.from} → {hoverEdge.to} · {hoverEdge.kind}
          </div>
          {hoverEdge.data.map((d, i) => (
            <code key={i} dir="ltr">
              {d}
            </code>
          ))}
        </div>
      )}

      {!run && (
        <div className="tr-overlay">
          <div className="tr-overlay-card">
            {loading ? (
              'Loading run…'
            ) : error ? (
              <>
                <b>{apiDown ? 'Trace stream disconnected' : 'Run not available'}</b>
                {error}
              </>
            ) : hasRuns ? (
              'Select a run to see its graph.'
            ) : (
              <>
                <b>No runs yet</b>
                “Run sweep now” starts the nightly-sweep graph and the graph appears here as it runs.
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function Marker({ id, color }: { id: string; color: string }) {
  return (
    <marker id={id} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={8} markerHeight={8} orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill={color} />
    </marker>
  )
}

interface CardProps {
  id: string
  box: Box
  kindColor: string
  kindLabel: string
  status: GrenNodeRecord['status'] | string
  dot: string
  pulse: boolean
  statusLabel: string
  sub: string
  badge: string
  right: string
  isSel: boolean
  dim: boolean
  onCp: boolean
  rtl: boolean
  theme: Theme
  onDown: (id: string, e: ReactPointerEvent<SVGGElement>) => void
  onKey: (id: string, e: ReactKeyboardEvent<SVGGElement>) => void
}

const NodeCard = memo(function NodeCard({ id, box: P, kindColor, kindLabel, status, dot, pulse, statusLabel, sub, badge, right, isSel, dim, onCp, rtl, theme, onDown, onKey }: CardProps) {
  const running = status === 'running'
  const waiting = isWaiting(status)
  const failed = status === 'failed'
  const skipped = status === 'skipped'
  const stroke = isSel ? theme.primary : running ? theme.primary : waiting ? theme.amberLine : failed ? theme.critical : onCp ? theme.primary : theme.line
  const strokeWidth = isSel ? 2.5 : running || waiting || failed ? 2 : 1.2
  const opacity = dim ? 0.3 : skipped ? 0.6 : 1
  const start = (v: number) => (rtl ? P.w - v : v)
  const anchorStart = rtl ? 'end' : 'start'
  const anchorEnd = rtl ? 'start' : 'end'
  return (
    <g
      className="tr-node"
      transform={`translate(${P.x},${P.y})`}
      style={{ opacity, transition: 'opacity .15s' }}
      tabIndex={0}
      role="button"
      aria-label={`${id}, ${kindLabel.toLowerCase()}, ${statusLabel}`}
      aria-pressed={isSel}
      onPointerDown={e => onDown(id, e)}
      onKeyDown={e => onKey(id, e)}
    >
      <rect className="tr-focus" x={-4} y={-4} width={P.w + 8} height={P.h + 8} rx={15} fill="none" stroke={theme.primary} strokeWidth={2} />
      <rect
        width={P.w}
        height={P.h}
        rx={12}
        fill={theme.surface}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={running ? '6 4' : skipped ? '3 3' : undefined}
        style={running ? { animation: 'gDash 1.2s linear infinite' } : undefined}
      />
      <rect x={rtl ? P.w - 5 : 0} y={0} width={5} height={P.h} rx={2} fill={kindColor} />
      <circle cx={start(20)} cy={20} r={5} fill={dot} style={pulse ? { animation: 'gFade 1.2s infinite' } : undefined} />
      <text x={start(32)} y={24} textAnchor={anchorStart} fill={theme.ink} style={{ fontFamily: FONTS.heading, fontWeight: 600, fontSize: 13.5 }}>
        {id}
      </text>
      <text x={rtl ? 12 : P.w - 12} y={24} textAnchor={anchorEnd} fill={kindColor} style={{ fontFamily: FONTS.ui, fontSize: 10.5, letterSpacing: '.06em' }}>
        {kindLabel}
      </text>
      <text x={start(16)} y={45} textAnchor={anchorStart} fill={theme.ink2} style={{ fontFamily: FONTS.ui, fontSize: 11 }}>
        {sub}
      </text>
      <text x={start(16)} y={66} textAnchor={anchorStart} fill={theme.ink} style={{ fontFamily: FONTS.mono, fontSize: 11 }}>
        {badge}
      </text>
      <text x={rtl ? 12 : P.w - 12} y={80} textAnchor={anchorEnd} fill={theme.ink2} style={{ fontFamily: FONTS.heading, fontSize: 11 }}>
        {right}
      </text>
      <title>{`${id} · ${kindLabel.toLowerCase()} · ${statusLabel}`}</title>
    </g>
  )
})
