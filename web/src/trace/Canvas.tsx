// Pan/zoom SVG canvas of the run graph: node cards, edges with markers, toolbar, run strip, legend, edge tooltip.
// Owns the viewport (view transform, dragged positions, critical-path toggle); selection lives in TraceView.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { fmt } from '../api/client'
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
}

const MARKERS = { faint: 'gArrow', primary: 'gArrowC', amber: 'gArrowG', critical: 'gArrowR', ink: 'gArrowK', ok: 'gArrowOk' } as const

export function Canvas({ run, runId, graph, rtl, theme, narrow, sel, onSelect, fitKey, now, loading, error, apiDown, hasRuns }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const [override, setOverride] = useState<PosMap>({})
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

  // Reset dragged positions when the run changes.
  useEffect(() => {
    setOverride({})
  }, [runId])

  const fit = useCallback(() => {
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
      setView({ k, x: (r.width - bw * k) / 2 - minX * k, y: (r.height - bh * k) / 2 - minY * k + 20 })
      return
    }
    const recs = runRef.current?.nodes ?? {}
    const ids = Object.keys(recs)
    const focusId = ids.find(id => isWaiting(recs[id].status)) ?? ids.find(id => recs[id].status === 'running') ?? (posRef.current.triage ? 'triage' : graphRef.current.nodes[0]?.id)
    const f = (focusId && posRef.current[focusId]) || ps[0]
    setView({ k, x: r.width / 2 - (f.x + f.w / 2) * k, y: r.height / 2 - (f.y + f.h / 2) * k + 20 })
  }, [])

  // Re-fit on request (panels, drawer, inspector, run change, direction) once the layout exists.
  const hasLayout = graph.nodes.length > 0
  useEffect(() => {
    if (!hasLayout) return
    const id = requestAnimationFrame(() => fit())
    return () => cancelAnimationFrame(id)
  }, [fitKey, runId, rtl, hasLayout, fit])

  // Size of the canvas (legend visibility) and a debounced re-fit on resize.
  useEffect(() => {
    const el = sectionRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let timer: number | null = null
    const ro = new ResizeObserver(entries => {
      const cr = entries[0]?.contentRect
      if (cr) setSize({ w: cr.width, h: cr.height })
      if (timer != null) clearTimeout(timer)
      timer = window.setTimeout(() => fit(), 120)
    })
    ro.observe(el)
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
    setView({ x: mx - (mx - v.x) * (k2 / v.k), y: my - (my - v.y) * (k2 / v.k), k: k2 })
  }, [])

  const onCanvasPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    const t = e.target as Element
    if (t.closest('.tr-node') || t.closest('.tr-edge-hit')) return
    const v0 = viewRef.current
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
  const st = runStatus(theme, run?.run.status)
  const gates = waitingGates(run)
  const legendVisible = !narrow && size.h >= 300 && size.w >= 760
  const hoverEdge: GEdge | null = hover && graph.edges[hover.i] ? graph.edges[hover.i] : null

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
          <button type="button" className="tr-btn" onClick={fit}>
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
