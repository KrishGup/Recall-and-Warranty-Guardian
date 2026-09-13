"""Static analysis of a graph spec - the dependency test as code.

Answers, before anything runs:
  - what exact data crosses each edge (edges are derived from $nodes refs)
  - which edges are status-only (fake dependencies)
  - is the graph acyclic (except declared, bounded repair cycles)
  - what is the estimated critical path vs the sum of all work
  - how wide does the graph get, and does that fit the width budget
  - are the frozen constraints satisfied (gate before side effect, spend cap, ...)
  - rough cost estimate per model tier
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from ..engine.expr import collect_node_refs, collect_status_conds, uses_input
from ..models.pricing import estimate_call_cost_usd, model_info, resolve_model
from .schema import GraphSpec, NodeBase, effective_failure, effective_frozen, gates_of

EdgeKind = Literal["data", "status", "gate", "order", "repair", "route"]
KIND_EST_MS = {"code": 200, "router": 5, "gate": 0, "loop": 60000, "subgraph": 30000}


@dataclass
class Edge:
    from_: str
    to: str
    kind: str
    data: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {"from": self.from_, "to": self.to, "kind": self.kind, "data": self.data}


@dataclass
class Finding:
    level: Literal["error", "warning", "info"]
    code: str
    message: str
    node: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"level": self.level, "code": self.code, "node": self.node, "message": self.message}


@dataclass
class NodeAnalysis:
    id: str
    kind: str
    model: str | None
    deps: list[str]
    dependents: list[str]
    level: int
    est_ms: float
    est_cost_usd: float
    fan_out: bool
    on_critical_path: bool

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


@dataclass
class Analysis:
    name: str
    nodes: dict[str, NodeAnalysis]
    edges: list[Edge]
    order: list[str]
    levels: list[list[str]]
    critical_path: dict[str, Any]
    sum_of_work_ms: float
    parallel_speedup: float
    max_width: int
    est_cost_usd: dict[str, float]
    frozen: list[str]
    findings: list[Finding]
    checklist: list[dict[str, Any]]
    ok: bool
    repair_edges: list[tuple[str, str]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "nodes": {k: v.to_dict() for k, v in self.nodes.items()},
            "edges": [e.to_dict() for e in self.edges],
            "order": self.order,
            "levels": self.levels,
            "critical_path": self.critical_path,
            "sum_of_work_ms": self.sum_of_work_ms,
            "parallel_speedup": self.parallel_speedup,
            "max_width": self.max_width,
            "est_cost_usd": self.est_cost_usd,
            "frozen": self.frozen,
            "findings": [f.to_dict() for f in self.findings],
            "checklist": self.checklist,
            "ok": self.ok,
        }


def node_model(spec: GraphSpec, n: NodeBase) -> str | None:
    if n.kind in ("agent", "verify"):
        return resolve_model(getattr(n, "model", None) or (spec.defaults.model if spec.defaults else None))
    return None


def _ref_fields(n: NodeBase) -> dict[str, Any]:
    base: dict[str, Any] = {"input": n.input, "when": n.when, "map": n.map}
    k = n.kind
    if k == "agent":
        base.update(prompt=n.prompt, system=n.system)
    elif k == "verify":
        base.update(target=n.target, prompt=n.prompt, system=n.system, args=n.args)
    elif k == "code":
        base.update(args=n.args)
    elif k == "gate":
        base.update(show=n.show, prompt=n.prompt, auto_approve_when=n.auto_approve_when)
    elif k == "router":
        base.update(routes=[r.model_dump() for r in n.routes])
    return base


def _est_ms(spec: GraphSpec, n: NodeBase) -> float:
    if n.est_ms:
        return float(n.est_ms)
    if n.kind == "agent" or (n.kind == "verify" and (n.mode or "agent") == "agent"):
        return float(model_info(node_model(spec, n) or "sonnet").est_latency_ms)
    if n.kind == "verify":
        return 200.0
    if n.kind == "subgraph":
        return analyze(n.graph).critical_path["est_ms"]
    if n.kind == "loop":
        return analyze(n.body).critical_path["est_ms"] * min(n.until.max_rounds, 3)
    return float(KIND_EST_MS.get(n.kind, 1000))


def analyze(spec: GraphSpec) -> Analysis:
    findings: list[Finding] = []
    ids = [n.id for n in spec.nodes]
    by_id: dict[str, NodeBase] = {}
    for n in spec.nodes:
        if n.id in by_id:
            findings.append(Finding("error", "duplicate_id", f'duplicate node id "{n.id}"', n.id))
        by_id[n.id] = n
    frozen = effective_frozen(spec)

    edges: list[Edge] = []
    deps: dict[str, set[str]] = {i: set() for i in ids}
    repair_edges: list[tuple[str, str]] = []

    def add_dep(to: str, frm: str) -> None:
        deps.setdefault(to, set()).add(frm)

    for n in spec.nodes:
        fields = _ref_fields(n)
        refs = collect_node_refs(fields) + collect_status_conds({"when": fields.get("when"), "routes": fields.get("routes"), "auto_approve_when": fields.get("auto_approve_when")})
        by_from: dict[str, list[Any]] = {}
        for r in refs:
            if r.node == n.id:
                findings.append(Finding("error", "self_reference", f'node "{n.id}" references itself', n.id))
                continue
            if r.node not in by_id:
                findings.append(Finding("error", "unknown_ref", f'node "{n.id}" references unknown node "{r.node}"', n.id))
                continue
            by_from.setdefault(r.node, []).append(r)
        for frm, rs in by_from.items():
            data = sorted({f"$nodes.{frm}{r.path}" for r in rs})
            status_only = all(r.path in (".status", "") for r in rs)
            route_only = all(r.path == ".route" for r in rs)
            kind = "status" if status_only else "route" if route_only else "data"
            edges.append(Edge(frm, n.id, kind, data))
            add_dep(n.id, frm)
            if status_only:
                findings.append(Finding("warning", "status_only_edge", f"edge {frm} -> {n.id} carries only status ({', '.join(data)}). That is waiting, not dependency. Pass real data or drop the edge.", n.id))
        for a in n.after or []:
            if a.node not in by_id:
                findings.append(Finding("error", "unknown_ref", f'after: unknown node "{a.node}"', n.id))
                continue
            edges.append(Edge(a.node, n.id, "order", [f"(ordering only: {a.reason})"]))
            add_dep(n.id, a.node)
            findings.append(Finding("error" if "no_status_only_edges" in frozen else "warning", "ordering_only_edge", f'edge {a.node} -> {n.id} is ordering-only ("{a.reason}"). No data crosses it.', n.id))
        for g in gates_of(n):
            gate = by_id.get(g)
            if gate is None:
                findings.append(Finding("error", "unknown_gate", f'requires_gate: unknown node "{g}"', n.id))
            elif gate.kind != "gate":
                findings.append(Finding("error", "not_a_gate", f'requires_gate "{g}" is a {gate.kind}, not a gate', n.id))
            else:
                edges.append(Edge(g, n.id, "gate", ["human approval"]))
                add_dep(n.id, g)
        if n.kind == "gate" and n.on_reject and n.on_reject.route and n.on_reject.route not in by_id:
            findings.append(Finding("error", "unknown_ref", f'on_reject.route: unknown node "{n.on_reject.route}"', n.id))
        if n.kind == "verify" and n.repair:
            tgt = by_id.get(n.repair.node)
            if tgt is None:
                findings.append(Finding("error", "unknown_ref", f'repair.node: unknown node "{n.repair.node}"', n.id))
            else:
                edges.append(Edge(n.id, n.repair.node, "repair", [f"killed reasons (max {n.repair.max_rounds} rounds)"]))
                repair_edges.append((n.id, n.repair.node))

    # ---- cycle check (repair back-edges are bounded by construction) ----
    order: list[str] = []
    state: dict[str, int] = {}
    cyclic = False

    def visit(nid: str, stack: list[str]) -> None:
        nonlocal cyclic
        s = state.get(nid, 0)
        if s == 1:
            cyclic = True
            findings.append(Finding("error", "cycle", f"dependency cycle: {' -> '.join(stack + [nid])}. Use a loop node or a verify repair edge for bounded cycles.", nid))
            return
        if s == 2:
            return
        state[nid] = 1
        for d in sorted(deps.get(nid, ())):
            visit(d, stack + [nid])
        state[nid] = 2
        order.append(nid)

    for nid in ids:
        visit(nid, [])

    # ---- levels & critical path ----
    est = {n.id: _est_ms(spec, n) for n in spec.nodes}
    cost: dict[str, float] = {}
    for n in spec.nodes:
        c = 0.0
        if n.kind == "agent" or (n.kind == "verify" and (n.mode or "agent") == "agent"):
            prompt_chars = len(getattr(n, "prompt", "") or "") + len(getattr(n, "system", "") or "") + len(str(n.input or {})) + 800
            c = estimate_call_cost_usd(node_model(spec, n) or "sonnet", prompt_chars)
            if getattr(n, "tools", None):
                c *= 4
        elif n.kind == "subgraph":
            c = analyze(n.graph).est_cost_usd["max"]
        elif n.kind == "loop":
            c = analyze(n.body).est_cost_usd["max"] * min(n.until.max_rounds, 3)
        cost[n.id] = c
    level: dict[str, int] = {}
    longest: dict[str, tuple[float, str | None]] = {}
    for nid in (ids if cyclic else order):
        ds = sorted(deps.get(nid, ()))
        level[nid] = (max(level.get(d, 0) for d in ds) + 1) if ds else 0
        best_ms, via = 0.0, None
        for d in ds:
            l = longest.get(d, (0.0, None))[0]
            if l > best_ms:
                best_ms, via = l, d
        longest[nid] = (best_ms + est.get(nid, 0.0), via)
    end_id, end_ms = "", -1.0
    for nid, (ms, _) in longest.items():
        if ms > end_ms:
            end_id, end_ms = nid, ms
    cp: list[str] = []
    cur: str | None = end_id
    while cur:
        cp.insert(0, cur)
        cur = longest.get(cur, (0.0, None))[1]
    sum_of_work = 0.0
    for n in spec.nodes:
        expected = max(2, min(n.max_width or 3, (spec.budget.max_width if spec.budget and spec.budget.max_width else 3))) if n.map else 1
        sum_of_work += est.get(n.id, 0.0) * expected
    levels: list[list[str]] = []
    for nid in ids:
        lv = level.get(nid, 0)
        while len(levels) <= lv:
            levels.append([])
        levels[lv].append(nid)
    fanout_widths = [(n.max_width or (spec.budget.max_width if spec.budget else None) or 1) for n in spec.nodes if n.map]
    max_width = max([1] + [len(l) for l in levels] + fanout_widths)

    dependents: dict[str, list[str]] = {}
    for e in edges:
        if e.kind != "repair":
            dependents.setdefault(e.from_, []).append(e.to)

    cost_min = cost_max = 0.0
    nodes: dict[str, NodeAnalysis] = {}
    for n in spec.nodes:
        c = cost.get(n.id, 0.0)
        width = max(1, n.max_width or (spec.budget.max_width if spec.budget and spec.budget.max_width else 5)) if n.map else 1
        f = effective_failure(spec, n)
        cost_min += c * (2 if n.map else 1)
        cost_max += c * width * (1 + f.retries)
        nodes[n.id] = NodeAnalysis(
            id=n.id, kind=n.kind, model=node_model(spec, n), deps=sorted(deps.get(n.id, ())),
            dependents=sorted(set(dependents.get(n.id, []))), level=level.get(n.id, 0), est_ms=est.get(n.id, 0.0),
            est_cost_usd=c, fan_out=bool(n.map), on_critical_path=n.id in cp,
        )

    # ---- frozen constraints & design lint ----
    for n in spec.nodes:
        f = effective_failure(spec, n)
        if n.side_effect and not gates_of(n):
            findings.append(Finding("error" if "gate_before_side_effect" in frozen else "warning", "side_effect_without_gate", f'node "{n.id}" has side_effect:true but no requires_gate. The unsafe transition must be impossible, not merely discouraged.', n.id))
        if n.kind == "agent" and not n.output_schema:
            findings.append(Finding("error", "no_output_schema", f'agent node "{n.id}" must declare output_schema', n.id))
        if n.kind == "agent" and not uses_input(_ref_fields(n)) and not collect_node_refs(_ref_fields(n)):
            findings.append(Finding("warning", "no_inputs", f'agent node "{n.id}" consumes no input and no node output. What data enters it?', n.id))
        if n.map:
            if n.failure is None or n.failure.quorum is None:
                findings.append(Finding("warning", "no_quorum", f'fan-out node "{n.id}" has no failure.quorum; default 1.0 means one failed worker fails the join. Set quorum to degrade visibly.', n.id))
            w = n.max_width or (spec.budget.max_width if spec.budget else None)
            if not w:
                findings.append(Finding("warning", "unbounded_width", f'fan-out node "{n.id}" has no max_width and the graph has no budget.max_width.', n.id))
            elif w > 10:
                findings.append(Finding("info", "wide_fanout", f'fan-out node "{n.id}" allows width {w}. Add width only when coverage grows faster than reconciliation cost.', n.id))
        if n.kind == "agent":
            tier = model_info(node_model(spec, n) or "sonnet").tier
            for r in collect_node_refs(_ref_fields(n)):
                if r.path.startswith(".outputs") or r.path.startswith(".items"):
                    if tier in ("large", "frontier"):
                        findings.append(Finding("warning", "compress_before_reason", f'{tier} model "{n.id}" reads raw fan-out output $nodes.{r.node}{r.path} directly. Put a deterministic reducer (dedupe/normalize/rank) in front of the expensive reasoning node.', n.id))
        if n.kind == "verify":
            consumers = [e for e in edges if e.from_ == n.id and e.kind != "repair"]
            listened = any(any(k in d for k in (".survivors", ".killed", ".kill_rate", ".output")) for e in consumers for d in e.data)
            if not listened and not n.repair:
                findings.append(Finding("error" if "verifier_can_kill" in frozen else "warning", "verifier_is_decoration", f'verify node "{n.id}" is not consumed downstream (nobody reads its survivors/killed) and has no repair edge. A verifier without authority is decoration.', n.id))
            if n.repair:
                tgt = by_id.get(n.repair.node)
                if tgt is not None and tgt.kind not in ("agent", "code", "subgraph"):
                    findings.append(Finding("error", "bad_repair_target", f'repair.node "{n.repair.node}" must be an agent/code/subgraph node', n.id))
                ancestors: set[str] = set()
                stack = [r.node for r in collect_node_refs(n.target)]
                while stack:
                    c_ = stack.pop()
                    if c_ in ancestors:
                        continue
                    ancestors.add(c_)
                    stack.extend(deps.get(c_, ()))
                if tgt is not None and tgt.id not in ancestors:
                    findings.append(Finding("warning", "repair_target_mismatch", f'verify "{n.id}" repairs "{n.repair.node}" but its target does not derive from that node\'s output.', n.id))
        if n.kind == "loop":
            if not n.until.no_new_for_rounds and n.until.converged is None:
                findings.append(Finding("warning", "loop_no_convergence", f'loop "{n.id}" stops only at max_rounds={n.until.max_rounds}. Add no_new_for_rounds or a converged condition.', n.id))
            if not n.until.max_cost_usd and not (spec.budget and spec.budget.max_cost_usd):
                findings.append(Finding("warning", "loop_no_budget", f'loop "{n.id}" has no cost budget (until.max_cost_usd or graph budget).', n.id))
            for f2 in analyze(n.body).findings:
                findings.append(Finding(f2.level, f2.code, f"[loop body] {f2.message}", f"{n.id}/{f2.node or ''}"))
        if n.kind == "subgraph":
            for f2 in analyze(n.graph).findings:
                findings.append(Finding(f2.level, f2.code, f"[subgraph] {f2.message}", f"{n.id}/{f2.node or ''}"))
        if n.kind == "gate":
            guarded = [m for m in spec.nodes if n.id in gates_of(m)]
            consumed = any(e.from_ == n.id and e.kind == "data" for e in edges)
            if not guarded and not consumed:
                findings.append(Finding("warning", "gate_guards_nothing", f'gate "{n.id}" guards no node (nothing declares requires_gate: {n.id}) and nobody reads its decision.', n.id))
        if n.kind == "router":
            consumers = [m for m in spec.nodes if any(r.node == n.id for r in collect_node_refs(m.when))]
            if not consumers:
                findings.append(Finding("warning", "router_unused", f'router "{n.id}" selects a route but no node\'s when: reads $nodes.{n.id}.route', n.id))
        if f.on_failure == "block" and n.map:
            findings.append(Finding("info", "map_blocks", f'fan-out node "{n.id}" blocks the run if quorum is not met (on_failure: block).', n.id))
    if "spend_cap" in frozen and not (spec.budget and spec.budget.max_cost_usd):
        findings.append(Finding("error", "no_spend_cap", "frozen constraint spend_cap: budget.max_cost_usd is required"))
    if "width_budget" in frozen and not (spec.budget and spec.budget.max_width):
        findings.append(Finding("error", "no_width_budget", "frozen constraint width_budget: budget.max_width is required"))
    if spec.output and isinstance(spec.output.get("from"), str) and spec.output["from"] not in by_id:
        findings.append(Finding("error", "unknown_output", f'output.from references unknown node "{spec.output["from"]}"'))
    agent_nodes = [n for n in spec.nodes if n.kind == "agent"]
    if len(agent_nodes) >= 2 and max_width == 1 and not any(n.map for n in spec.nodes):
        findings.append(Finding("info", "pure_chain", "every node waits for the previous one (no parallel branches, no fan-out). If every step truly needs the previous output this is fine; otherwise cut fake edges - or use a single agent."))
    if spec.budget and spec.budget.max_width and max_width > spec.budget.max_width:
        findings.append(Finding("info", "width_exceeds_budget", f"graph can have {max_width} nodes ready at once but budget.max_width={spec.budget.max_width}; the engine will queue the rest."))

    has_gate = any(n.kind == "gate" for n in spec.nodes)
    has_side_effect = any(n.side_effect for n in spec.nodes)
    has_verify = any(n.kind == "verify" for n in spec.nodes)
    has_loop = any(n.kind == "loop" or (n.kind == "verify" and n.repair) for n in spec.nodes)
    codes = {f.code for f in findings}
    checklist = [
        {"item": "Every edge carries real data or authority", "ok": not ({"status_only_edge", "ordering_only_edge"} & codes)},
        {"item": "Every node has one bounded job with structured output", "ok": "no_output_schema" not in codes},
        {"item": "Independent nodes can run in parallel", "ok": True if (max_width > 1 or any(n.map for n in spec.nodes)) else (None if len(agent_nodes) < 2 else False)},
        {"item": "Joins are placed only where the full set is required", "ok": None, "note": "review manually"},
        {"item": "Important results are verified before moving downstream", "ok": True if has_verify else None, "note": None if has_verify else "no verify node"},
        {"item": "Failures can be retried without duplicating side effects", "ok": (not has_side_effect) or all(gates_of(n) for n in spec.nodes if n.side_effect)},
        {"item": "The graph can resume from a checkpoint", "ok": True, "note": "Strands session state + gren checkpoints after every node"},
        {"item": "Every cycle has a hard stop and budget", "ok": ("loop_no_budget" not in codes) if has_loop else None},
        {"item": "A human can interrupt high-risk paths", "ok": has_gate if has_side_effect else None},
        {"item": "Every route selection is explainable", "ok": True, "note": "router decisions are logged with the state that produced them"},
        {"item": "Spend cap set", "ok": bool(spec.budget and spec.budget.max_cost_usd)},
        {"item": "Width budget set", "ok": bool(spec.budget and spec.budget.max_width)},
    ]
    ok = not any(f.level == "error" for f in findings)
    return Analysis(
        name=spec.name, nodes=nodes, edges=edges, order=(ids if cyclic else order), levels=levels,
        critical_path={"nodes": cp, "est_ms": max(0.0, end_ms)}, sum_of_work_ms=sum_of_work,
        parallel_speedup=round(sum_of_work / end_ms, 2) if end_ms > 0 else 1.0, max_width=max_width,
        est_cost_usd={"min": round(cost_min, 4), "max": round(cost_max, 4)}, frozen=frozen, findings=findings,
        checklist=checklist, ok=ok, repair_edges=repair_edges,
    )


def format_analysis(a: Analysis) -> str:
    L = [f"Graph: {a.name}  ({len(a.nodes)} nodes, {len(a.edges)} edges)  {'OK' if a.ok else 'ERRORS'}"]
    L.append(f"Critical path (est): {a.critical_path['est_ms'] / 1000:.1f}s  vs sum of work {a.sum_of_work_ms / 1000:.1f}s  => {a.parallel_speedup}x")
    L.append("  " + " -> ".join(a.critical_path["nodes"]))
    L.append(f"Max width: {a.max_width}   Est. cost: ${a.est_cost_usd['min']} - ${a.est_cost_usd['max']}")
    L.append("Frozen: " + ", ".join(a.frozen))
    L.append("")
    L.append("Levels:")
    for i, lv in enumerate(a.levels):
        L.append(f"  {i}: {', '.join(lv)}")
    L.append("")
    L.append("Edges (what crosses):")
    for e in a.edges:
        L.append(f"  {e.from_} -> {e.to}  [{e.kind}]  {', '.join(e.data)}")
    if a.findings:
        L.append("")
        L.append("Findings:")
        for f in a.findings:
            L.append(f"  {f.level.upper():7} {f.code}{f' ({f.node})' if f.node else ''}: {f.message}")
    L.append("")
    L.append("Checklist:")
    for c in a.checklist:
        mark = "x" if c["ok"] is True else "!" if c["ok"] is False else "?"
        L.append(f"  [{mark}] {c['item']}{' - ' + c['note'] if c.get('note') else ''}")
    return "\n".join(L)
