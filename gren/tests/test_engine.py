"""Engine semantics on the Strands runtime, with the mock provider (no tokens). Mirrors the v1 suite."""
import os
import threading
import time

from conftest import LIST, OUT, j

from gren.engine.expr import Scope, collect_node_refs, eval_cond, render_template, resolve_ref
from gren.engine.runtime import GraphRun, RunOptions
from gren.engine.state import RunStore
from gren.metrics.metrics import compute_metrics
from gren.models.mock import generate_from_schema
from gren.models.registry import ModelRegistry
from gren.reducers.builtin import BUILTIN_REDUCERS, ReducerCtx
from gren.spec.analyze import analyze
from gren.spec.load import load_graph_from_object, parse_spec_text

CTX = ReducerCtx("r", "n", lambda m: None)


# ---------------------------------------------------------------- expressions


def test_resolves_refs_and_templates():
    scope = Scope(input={"topic": "x", "n": 2}, nodes={"a": {"status": "completed", "output": {"items": [{"t": "one"}, {"t": "two"}], "flag": True}}, "b": {"status": "skipped"}})
    assert resolve_ref("$input.topic", scope) == "x"
    assert resolve_ref("$nodes.a.output.items[1].t", scope) == "two"
    assert resolve_ref("$nodes.missing.output.x", scope) is None
    assert render_template("T={{ input.topic }} J={{ json $nodes.a.output.flag }} keep {{not a ref}}", scope) == "T=x J=true keep {{not a ref}}"


def test_evaluates_conditions():
    scope = Scope(input={"topic": "x", "n": 2}, nodes={"a": {"status": "completed", "output": {"items": [1], "flag": True}}, "b": {"status": "skipped"}})
    assert eval_cond({"eq": ["$input.n", 2]}, scope) is True
    assert eval_cond({"and": [{"status": ["a", "completed"]}, {"not": {"status": ["b", "completed"]}}]}, scope) is True
    assert eval_cond({"in": ["$input.topic", ["x", "y"]]}, scope) is True
    assert eval_cond("$nodes.a.output.items", scope) is True
    assert eval_cond({"empty": "$nodes.b.output"}, scope) is True


def test_collects_node_refs():
    refs = collect_node_refs({"prompt": "use {{ $nodes.a.output.items }} and $nodes.b.status and {{ nodes.d.output.markdown }} {{ json nodes.e.outputs }}", "when": {"eq": ["$nodes.c.route", "x"]}})
    assert sorted(f"{r.node}{r.path}" for r in refs) == ["a.output.items", "b.status", "c.route", "d.output.markdown", "e.outputs"]


# ---------------------------------------------------------------- reducers


def test_reducers_report_stats():
    fl = BUILTIN_REDUCERS["flatten"]({"items": [{"findings": [1, 2]}, {"findings": [3]}, None]}, {"path": "findings"}, CTX)
    assert fl["items"] == [1, 2, 3]
    dd = BUILTIN_REDUCERS["dedupe"]({"items": [{"claim": "A b"}, {"claim": "a  B"}, {"claim": "c"}]}, {"key": ["claim"]}, CTX)
    assert len(dd["items"]) == 2 and dd["_stats"]["in"] == 3 and dd["_stats"]["out"] == 2
    tk = BUILTIN_REDUCERS["top_k"]({"items": [{"s": 1}, {"s": 3}, {"s": 2}]}, {"k": 2, "by": "s"}, CTX)
    assert [x["s"] for x in tk["items"]] == [3, 2]
    votes = BUILTIN_REDUCERS["count_votes"]({"items": [{"w": 1}, {"w": 2}, {"w": 1}]}, {"by": "w"}, CTX)
    assert votes["winner"] == "1"


# ---------------------------------------------------------------- analysis


def test_analysis_derives_edges_and_finds_cycles():
    spec = load_graph_from_object({
        "name": "t", "budget": {"max_cost_usd": 1},
        "nodes": [
            {"id": "a", "kind": "agent", "prompt": "x {{ input.q }}", "output_schema": OUT},
            {"id": "b", "kind": "agent", "prompt": "y {{ $nodes.a.output.value }}", "output_schema": OUT},
            {"id": "c", "kind": "agent", "prompt": "z", "output_schema": OUT, "when": {"status": ["a", "completed"]}},
            {"id": "d", "kind": "code", "fn": "identity", "after": [{"node": "b", "reason": "wait for b"}]},
        ],
    }).spec
    a = analyze(spec)
    assert a.ok
    kinds = {(e.from_, e.to): e.kind for e in a.edges}
    assert kinds[("a", "b")] == "data" and kinds[("a", "c")] == "status" and kinds[("b", "d")] == "order"
    codes = {f.code for f in a.findings}
    assert {"status_only_edge", "ordering_only_edge"} <= codes
    assert any(f.code == "no_inputs" and f.node == "c" for f in a.findings)
    assert a.levels[0] == ["a"] and a.critical_path["nodes"][0] == "a"
    cyc = analyze(load_graph_from_object({"name": "c", "budget": {"max_cost_usd": 1}, "nodes": [
        {"id": "a", "kind": "agent", "prompt": "{{ $nodes.b.output.value }}", "output_schema": OUT},
        {"id": "b", "kind": "agent", "prompt": "{{ $nodes.a.output.value }}", "output_schema": OUT}]}).spec)
    assert not cyc.ok and any(f.code == "cycle" for f in cyc.findings)


def test_frozen_constraints_are_static():
    a = analyze(load_graph_from_object({"name": "f", "nodes": [{"id": "pub", "kind": "code", "fn": "record", "side_effect": True}]}).spec)
    assert {"side_effect_without_gate", "no_spend_cap"} <= {f.code for f in a.findings} and not a.ok
    v = analyze(load_graph_from_object({"name": "v", "budget": {"max_cost_usd": 1}, "frozen": ["verifier_can_kill"], "nodes": [
        {"id": "a", "kind": "agent", "prompt": "x", "output_schema": LIST}, {"id": "ver", "kind": "verify", "target": "$nodes.a.output.items"}]}).spec)
    assert any(f.code == "verifier_is_decoration" and f.level == "error" for f in v.findings)


# ---------------------------------------------------------------- engine


def test_fork_join_with_verify_auto_gate_and_side_effect(h):
    yaml = f"""
name: forkjoin
budget: {{ max_cost_usd: 5, max_width: 3 }}
output: {{ from: final }}
nodes:
  - id: plan
    kind: agent
    prompt: "plan {{{{ input.q }}}}"
    output_schema: {j({"type": "object", "required": ["lanes"], "properties": {"lanes": {"type": "array", "minItems": 4, "maxItems": 4, "items": {"type": "string"}}}})}
  - id: work
    kind: agent
    model: haiku
    map: $nodes.plan.output.lanes
    max_width: 2
    failure: {{ quorum: 0.5 }}
    prompt: "lane {{{{ item }}}}"
    output_schema: {j(LIST)}
  - id: flat
    kind: code
    fn: flatten
    input: {{ items: $nodes.work.outputs }}
    args: {{ path: items }}
  - id: ver
    kind: verify
    target: $nodes.flat.output.items
    kill_threshold: 0.5
  - id: gate
    kind: gate
    title: ok?
    auto_approve_when: {{ gte: ["$nodes.ver.output.total", 1] }}
    show: {{ n: $nodes.ver.output.total }}
  - id: final
    kind: code
    fn: identity
    side_effect: true
    requires_gate: gate
    input: {{ survivors: $nodes.ver.survivors, killed: $nodes.ver.killed, workers: $nodes.work.count }}
"""
    state, _ = h.run(yaml, {"q": "x"}, {"kill_rate": 0.5, "seed": "s1"})
    assert state.run["status"] == "completed", state.run.get("error")
    assert len(state.nodes["work"]["items"]) == 4
    assert state.nodes["gate"]["gate"]["decision"] == "auto"
    assert state.nodes["final"]["side_effect_done"] is True
    out = state.run["output"]
    assert out["workers"]["total"] == 4
    assert len(out["survivors"]) + len(out["killed"]) == state.nodes["ver"]["verify"]["total"]
    m = compute_metrics(state, h.store.read_events(state.run["id"]))
    assert 2 <= m["width"]["peak"] <= 3
    assert m["verifier"]["candidates"] > 0 and m["human"]["auto"] == 1 and m["parallel_speedup"] > 1


def _fd(policy_a: str, optional: str) -> str:
    return f"""
name: fd
budget: {{ max_cost_usd: 5, max_width: 4 }}
nodes:
  - id: a
    kind: agent
    prompt: "a"
    output_schema: {j(OUT)}
    failure: {{ retries: 1, {policy_a} }}
  - id: b
    kind: agent
    prompt: "b"
    output_schema: {j(OUT)}
  - id: join
    kind: code
    fn: merge
    {optional}
    input: {{ a: $nodes.a.output, b: $nodes.b.output, a_status: $nodes.a.status }}
    args: {{ mode: object }}
"""


def test_failure_isolation(h):
    cont, _ = h.run(_fd("on_failure: continue", "optional: [a]"), {}, {"always_fail": ["a"]})
    assert cont.run["status"] == "completed"
    assert cont.nodes["a"]["status"] == "failed" and len(cont.nodes["a"]["attempts"]) == 2
    assert cont.nodes["join"]["status"] == "completed"
    assert "degraded" in cont.run["warnings"][0]

    skip, _ = h.run(_fd("on_failure: continue", ""), {}, {"always_fail": ["a"]})
    assert skip.run["status"] == "completed" and skip.nodes["join"]["status"] == "skipped"

    block, _ = h.run(_fd("on_failure: block", ""), {}, {"always_fail": ["a"]})
    assert block.run["status"] == "failed" and 'node "a" failed' in block.run["error"]


def test_quorum_degrades_visibly(h):
    yaml = f"""
name: q
budget: {{ max_cost_usd: 5, max_width: 4 }}
nodes:
  - id: w
    kind: agent
    map: $input.items
    failure: {{ retries: 0, quorum: 0.5 }}
    prompt: "w {{{{ item }}}}"
    output_schema: {j(OUT)}
  - id: j
    kind: code
    fn: identity
    input: {{ n: $nodes.w.count, outs: $nodes.w.outputs }}
"""
    q, _ = h.run(yaml, {"items": [1, 2, 3, 4]}, {"fail_rate": 0.45, "seed": "quorum"})
    done = sum(1 for i in q.nodes["w"]["items"] if i["status"] == "completed")
    if done >= 2:
        assert q.run["status"] == "completed" and q.run["output"]["j"]["n"]["completed"] == done
    else:
        assert q.run["status"] == "failed" and "quorum" in q.run["error"]


ROUTER = """
name: router
budget: { max_cost_usd: 5 }
nodes:
  - id: classify
    kind: code
    fn: classify_regex
    input: { text: $input.text }
    args: { path: text, rules: [{ match: "refund", label: billing }], default: other }
  - id: route
    kind: router
    routes:
      - { when: { eq: ["$nodes.classify.output.label", billing] }, route: billing, reason: "billing keyword" }
    default: other
  - id: billing_path
    kind: code
    fn: identity
    when: { eq: ["$nodes.route.output.route", billing] }
    input: { x: $nodes.classify.output }
  - id: other_path
    kind: code
    fn: identity
    when: { eq: ["$nodes.route.output.route", other] }
    input: { x: $nodes.classify.output }
  - id: after_billing
    kind: code
    fn: identity
    input: { y: $nodes.billing_path.output }
  - id: merge
    kind: code
    fn: merge
    optional: [billing_path, other_path]
    input: { a: $nodes.billing_path.output, b: $nodes.other_path.output }
    args: { mode: object }
"""


def test_router_cascades_skips(h):
    r, _ = h.run(ROUTER, {"text": "I want a refund"})
    assert r.run["status"] == "completed"
    assert r.nodes["route"]["route"] == "billing"
    assert r.nodes["other_path"]["status"] == "skipped" and r.nodes["billing_path"]["status"] == "completed"
    assert r.nodes["after_billing"]["status"] == "completed" and r.nodes["merge"]["status"] == "completed"
    assert any(d["kind"] == "route" and d["state"] for d in r.run["decisions"])
    r2, _ = h.run(ROUTER, {"text": "hello"})
    assert r2.nodes["route"]["route"] == "other"
    assert r2.nodes["billing_path"]["status"] == "skipped" and r2.nodes["after_billing"]["status"] == "skipped"
    assert 'upstream "billing_path" skipped' in r2.nodes["after_billing"]["skip_reason"]


def test_verify_repair_cycle_is_bounded(h):
    yaml = f"""
name: repair
budget: {{ max_cost_usd: 5 }}
nodes:
  - id: draft
    kind: agent
    prompt: "draft {{{{ input.q }}}}"
    output_schema: {j(OUT)}
  - id: check
    kind: verify
    target: $nodes.draft.output
    kill_threshold: 0.5
    repair: {{ node: draft, max_rounds: 2 }}
  - id: use
    kind: code
    fn: identity
    input: {{ ok: $nodes.check.survivors, bad: $nodes.check.killed }}
"""
    r, _ = h.run(yaml, {"q": "x"}, {"kill_rate": 1})
    assert r.run["status"] == "completed", r.run.get("error")
    assert r.nodes["check"]["verify"]["repair_round"] == 2
    assert r.nodes["draft"]["repair"]["round"] == 2
    assert len(r.nodes["draft"]["attempts"]) == 3
    assert len([d for d in r.run["decisions"] if d["kind"] == "repair"]) >= 3
    assert r.nodes["use"]["status"] == "completed"
    art = h.store.read_artifact(r.run["id"], r.nodes["draft"]["attempts"][2]["artifact"])
    assert "repair_feedback" in art["request"]["prompt"]


GATE = f"""
name: gate
budget: {{ max_cost_usd: 5 }}
nodes:
  - id: draft
    kind: agent
    prompt: "d"
    output_schema: {j(OUT)}
  - id: approve
    kind: gate
    title: publish?
    show: {{ d: $nodes.draft.output }}
  - id: publish
    kind: code
    fn: record
    side_effect: true
    requires_gate: approve
    input: {{ d: $nodes.draft.output }}
"""


def test_gate_pauses_resumes_and_never_reruns_side_effect(h):
    first, _ = h.run(GATE)
    assert first.run["status"] == "paused"
    assert first.nodes["approve"]["status"] == "waiting_approval" and first.nodes["publish"]["status"] == "pending"
    h.store.write_approval(first.run["id"], {"gate": "approve", "decision": "approved", "by": "tester", "comment": "ship", "at": "2999-01-01T00:00:00Z"})
    s2, _ = h.resume(first.run["id"])
    assert s2.run["status"] == "completed", s2.run.get("error")
    assert s2.nodes["approve"]["gate"]["decision"] == "approved" and s2.nodes["publish"]["side_effect_done"] is True
    s3, _ = h.resume(first.run["id"])
    assert len(s3.nodes["publish"]["attempts"]) == 1

    rej, _ = h.run(GATE)
    h.store.write_approval(rej.run["id"], {"gate": "approve", "decision": "rejected", "by": "tester", "comment": "no", "at": "2999-01-01T00:00:00Z"})
    s4, _ = h.resume(rej.run["id"])
    assert s4.run["status"] == "failed" and "rejected" in s4.run["error"]
    assert s4.nodes["publish"]["status"] != "completed"


def test_gate_block_mode_waits_for_in_process_approval(h):
    spec = parse_spec_text(GATE)
    reg = ModelRegistry(mock_options={"latency_ms": 5, "jitter_ms": 5})
    run = GraphRun.create(h.store, spec, "<test>", {}, reg, RunOptions(bridge="mock", gate_wait="block", poll_s=0.05))
    threading.Timer(0.6, lambda: run.approve("approve", "approved", "thread", "go")).start()
    state = run.run()
    assert state.run["status"] == "completed", state.run.get("error")
    assert state.nodes["approve"]["gate"]["by"] == "thread"
    ev = [e["type"] for e in h.store.read_events(state.run["id"])]
    assert "gate.waiting" in ev and "run.paused" in ev and "gate.approved" in ev


def test_spend_cap_is_frozen(h):
    yaml = f"""
name: cap
budget: {{ max_cost_usd: 0.001, max_width: 2 }}
nodes:
  - id: w
    kind: agent
    map: $input.items
    prompt: "w {{{{ item }}}}"
    output_schema: {j(OUT)}
"""
    r, _ = h.run(yaml, {"items": [1, 2, 3, 4, 5, 6]})
    assert r.run["status"] == "failed" and "spend cap" in r.run["error"]


def test_discovery_loop_converges_and_dedupes(h):
    yaml = f"""
name: loop
budget: {{ max_cost_usd: 5 }}
nodes:
  - id: discover
    kind: loop
    input: {{ q: $input.q }}
    collect: $output.items
    seen_key: key
    until: {{ max_rounds: 5, no_new_for_rounds: 2 }}
    body:
      name: round
      budget: {{ max_cost_usd: 1 }}
      output: {{ from: search }}
      nodes:
        - id: search
          kind: agent
          prompt: "round {{{{ input.round }}}} seen {{{{ json input.seen }}}}"
          output_schema: {j({"type": "object", "required": ["items"], "properties": {"items": {"type": "array", "minItems": 2, "maxItems": 2, "items": {"type": "object", "required": ["key"], "properties": {"key": {"type": "string", "enum": ["k1", "k2", "k3"]}}}}}})}
"""
    r, _ = h.run(yaml, {"q": "x"}, {"seed": "loop"})
    assert r.run["status"] == "completed", r.run.get("error")
    loop = r.nodes["discover"]["loop"]
    assert loop["rounds"] <= 5 and loop["collected"] <= 3
    items = r.run["output"]["discover"]["items"]
    assert len({i["key"] for i in items}) == len(items)
    assert any((s.get("parent") or {}).get("node_id") == "discover" for s in h.store.list())


def test_schema_invalid_output_is_repaired(h):
    yaml = f"""
name: rep
budget: {{ max_cost_usd: 5 }}
defaults: {{ failure: {{ retries: 0, repair_attempts: 1 }} }}
nodes:
  - id: a
    kind: agent
    prompt: "x"
    output_schema: {j(OUT)}
"""
    r, _ = h.run(yaml, {}, {"invalid_rate": 1, "seed": "inv"})
    assert r.run["status"] == "completed", r.run.get("error")
    assert r.nodes["a"]["repairs"] == 1 and len(r.nodes["a"]["attempts"]) == 1


def test_subgraph_runs_nested(h):
    yaml = f"""
name: parent
budget: {{ max_cost_usd: 5 }}
nodes:
  - id: child
    kind: subgraph
    input: {{ q: $input.q }}
    graph:
      name: kid
      budget: {{ max_cost_usd: 1 }}
      output: {{ from: a }}
      nodes:
        - id: a
          kind: agent
          prompt: "{{{{ input.q }}}}"
          output_schema: {j(OUT)}
  - id: use
    kind: code
    fn: identity
    input: {{ v: $nodes.child.output.value }}
"""
    r, _ = h.run(yaml, {"q": "hi"})
    assert r.run["status"] == "completed", r.run.get("error")
    assert isinstance(r.run["output"]["use"]["v"], str)


# ---------------------------------------------------------------- inbox (orchestrator mode)


def test_inbox_emits_tasks_and_validates_results(tmp_path):
    store = RunStore(os.path.join(str(tmp_path), "runs-inbox"))
    reg = ModelRegistry(runs_root=store.root, inbox_options={"poll_s": 0.05, "min_timeout_s": 10})
    spec = parse_spec_text(f"""
name: inbox
budget: {{ max_cost_usd: 5, max_width: 2 }}
output: {{ from: join }}
nodes:
  - id: w
    kind: agent
    map: $input.items
    failure: {{ retries: 0, quorum: 1 }}
    prompt: "w {{{{ item }}}}"
    output_schema: {j(OUT)}
  - id: join
    kind: code
    fn: identity
    input: {{ n: $nodes.w.count, outs: $nodes.w.outputs }}
""")
    run = GraphRun.create(store, spec, "<test>", {"items": [1, 2, 3]}, reg, RunOptions(bridge="inbox", gate_wait="return"))
    done: list[str] = []
    stop = threading.Event()
    state_holder: dict = {"first": True}

    def worker() -> None:
        import random

        while not stop.is_set():
            for t in store.list_tasks_deep(run.id):
                if t["task_id"] in done:
                    continue
                done.append(t["task_id"])
                output = {"wrong": True} if state_holder["first"] else generate_from_schema(t["output_schema"], random.Random(1), t["node_id"])
                state_holder["first"] = False
                store.write_task_result(t["run_id"], {"task_id": t["task_id"], "output": output, "source": "human", "worker": "test", "completed_at": "2026-01-01T00:00:00Z"})
            time.sleep(0.06)

    th = threading.Thread(target=worker, daemon=True)
    th.start()
    state = run.run()
    stop.set()
    assert state.run["status"] == "completed", state.run.get("error")
    assert sum(1 for i in state.nodes["w"]["items"] if i["status"] == "completed") == 3
    assert state.nodes["w"]["repairs"] == 1
    assert all(t["status"] in ("completed", "cancelled") for t in store.list_tasks(run.id))
    evs = store.read_events(run.id)
    assert len([e for e in evs if e["type"] == "task.created"]) == 4
    assert any(e["type"] == "call.invalid_output" for e in evs)
    assert any(e["type"] == "task.completed" and (e.get("data") or {}).get("source") == "human" for e in evs)


# ---------------------------------------------------------------- resume + fork


def test_resume_reruns_blocking_failure(h):
    yaml = f"""
name: res
budget: {{ max_cost_usd: 5 }}
nodes:
  - id: a
    kind: agent
    prompt: "a"
    failure: {{ retries: 0, on_failure: block }}
    output_schema: {j(OUT)}
  - id: b
    kind: code
    fn: identity
    input: {{ v: $nodes.a.output.value }}
"""
    s1, _ = h.run(yaml, {}, {"always_fail": ["a"]})
    assert s1.run["status"] == "failed" and s1.nodes["a"]["status"] == "failed"
    s2, _ = h.resume(s1.run["id"])
    assert s2.run["status"] == "completed" and s2.nodes["a"]["status"] == "completed" and s2.nodes["b"]["status"] == "completed"


def test_fork_reuses_upstream_outputs(h):
    v1 = parse_spec_text(f"""
name: forkme
budget: {{ max_cost_usd: 5 }}
output: {{ from: b }}
nodes:
  - id: a
    kind: agent
    prompt: "a {{{{ input.q }}}}"
    output_schema: {j(OUT)}
  - id: b
    kind: agent
    prompt: "b {{{{ $nodes.a.output.value }}}}"
    failure: {{ retries: 0, on_failure: block }}
    output_schema: {j(OUT)}
""")
    reg_fail = ModelRegistry(mock_options={"latency_ms": 5, "jitter_ms": 5, "always_fail": ["b"]})
    s1 = GraphRun.create(h.store, v1, "<test>", {"q": "x"}, reg_fail, RunOptions(bridge="mock", gate_wait="return")).run()
    assert s1.run["status"] == "failed"
    a_out = s1.nodes["a"]["output"]
    v2 = parse_spec_text(f"""
name: forkme
budget: {{ max_cost_usd: 5 }}
output: {{ from: c }}
nodes:
  - id: a
    kind: agent
    prompt: "a {{{{ input.q }}}}"
    output_schema: {j(OUT)}
  - id: b
    kind: agent
    prompt: "b v2 {{{{ $nodes.a.output.value }}}}"
    output_schema: {j(OUT)}
  - id: c
    kind: code
    fn: identity
    input: {{ a: $nodes.a.output.value, b: $nodes.b.output.value }}
""")
    reg = ModelRegistry(mock_options={"latency_ms": 5, "jitter_ms": 5})
    forked = GraphRun.fork(h.store, s1.run["id"], ["b"], reg, RunOptions(bridge="mock", gate_wait="return"), spec=v2)
    s2 = forked.run()
    assert s2.run["status"] == "completed", s2.run.get("error")
    assert s2.run["forked_from"] == s1.run["id"]
    assert s2.nodes["a"]["output"] == a_out and len(s2.nodes["a"]["attempts"]) == 1
    assert s2.nodes["b"]["status"] == "completed" and s2.nodes["c"]["status"] == "completed"
    assert s2.run["output"]["a"] == a_out["value"]
