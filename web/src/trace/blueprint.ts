// Graph blueprints: a graph file (nightly-sweep.yaml, intake.yaml) shown in the workbench before it has ever run.
// gren's /api/graph returns the parsed spec, its static analysis (levels, edges, kinds) and the YAML text; a run
// record synthesized from that drives the same canvas, spec tab and inspector as a real run, with every node pending.
import { useEffect, useState } from 'react'
import { Api } from '../api/client'
import type { GrenGraphFile, GrenGraphInfo, GrenRun } from '../api/types'
import { errorMessage } from './model'

export const DEFAULT_BLUEPRINT = 'nightly-sweep.yaml'

export function blueprintRun(path: string, g: GrenGraphFile): GrenRun {
  const now = new Date().toISOString()
  return {
    run: {
      id: `blueprint:${path}`,
      graph: g.spec.name || path.replace(/\.(ya?ml|json)$/, ''),
      spec_file: path,
      spec: g.spec,
      input: null,
      status: 'created',
      created_at: now,
      updated_at: now,
      bridge: '',
      budget: g.spec.budget ? { ...(g.spec.budget as Record<string, number>) } : {},
      frozen: [],
      totals: { cost_usd: 0, usage: {}, agent_calls: 0, retries: 0, wall_ms: 0 },
      approvals: {},
      decisions: [],
      labels: { kind: 'blueprint' },
      output: null,
      error: null,
    },
    nodes: {},
    analysis: g.analysis,
    metrics: null,
    tasks: [],
    spec_yaml: g.yaml,
    in_process: false,
    events_count: 0,
  }
}

export const isBlueprint = (run: GrenRun | null | undefined): boolean => run?.run.labels?.kind === 'blueprint'

/** The graph files gren can run (from /gren/api/graphs); unreadable files are left out. Empty when the API is away. */
export function useGraphs(): GrenGraphInfo[] {
  const [graphs, setGraphs] = useState<GrenGraphInfo[]>([])
  useEffect(() => {
    let on = true
    Api.gren.graphs().then(
      g => {
        if (on) setGraphs(g.filter(x => !x.error))
      },
      () => {
        /* no blueprints without the API; the runs list reports the outage */
      },
    )
    return () => {
      on = false
    }
  }, [])
  return graphs
}

/** The blueprint run for `path` (null while loading or when no path is selected). */
export function useBlueprint(path: string | null): { blueprint: GrenRun | null; error: string | null } {
  const [state, setState] = useState<{ path: string; run: GrenRun | null; error: string | null } | null>(null)
  useEffect(() => {
    if (!path) return
    let on = true
    Api.gren.graph(path).then(
      g => {
        if (on) setState({ path, run: blueprintRun(path, g), error: null })
      },
      e => {
        if (on) setState({ path, run: null, error: errorMessage(e) })
      },
    )
    return () => {
      on = false
    }
  }, [path])
  if (!path || !state || state.path !== path) return { blueprint: null, error: null }
  return { blueprint: state.run, error: state.error }
}
