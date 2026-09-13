"""MCP tools in-process: the orchestrator loop with the inbox provider, driven through the tool functions."""
import asyncio
import json
import os
import random
import threading
import time

from gren.engine.state import RunStore
from gren.mcp.server import build_server
from gren.models.mock import generate_from_schema

GRAPHS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "graphs")


def _call(server, name: str, args: dict):
    res = asyncio.run(server.call_tool(name, args))
    parts = res if isinstance(res, (list, tuple)) else getattr(res, "content", res)
    if isinstance(parts, tuple) and len(parts) == 2:
        parts = parts[0]
    text = "".join(getattr(p, "text", "") for p in parts) if not isinstance(parts, str) else parts
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return text


def test_tool_list_and_reference(tmp_path):
    server = build_server(RunStore(os.path.join(str(tmp_path), "runs")), GRAPHS)
    names = {t.name for t in asyncio.run(server.list_tools())}
    for n in ("gren_validate", "gren_run", "gren_wait", "gren_tasks", "gren_complete_task", "gren_approve", "gren_fork", "gren_metrics", "gren_node", "gren_write_graph"):
        assert n in names
    assert len(names) == 23
    assert _call(server, "gren_shapes", {})[0]["id"] == "fork-join"
    assert "Frozen constraints" in _call(server, "gren_reference", {})
    assert "INVALID" in _call(server, "gren_validate", {"spec_yaml": "name: x\nbudget: {max_cost_usd: 1}\nnodes:\n  - {id: a, kind: agent, prompt: x}\n"})
    assert "OK" in _call(server, "gren_validate", {"spec_path": "tournament.yaml"}) or "ok" in _call(server, "gren_validate", {"spec_path": "tournament.yaml"}).lower()


def test_orchestrator_loop_with_inbox(tmp_path):
    os.environ["GREN_ALLOW_MOCK"] = "1"
    store = RunStore(os.path.join(str(tmp_path), "runs"))
    server = build_server(store, GRAPHS)
    server.gren_control.registry.inbox_options = {"poll_s": 0.05, "min_timeout_s": 20}
    spec = """
name: mcp-inbox
budget: { max_cost_usd: 2, max_width: 2 }
output: { from: join }
nodes:
  - id: w
    kind: agent
    map: $input.items
    failure: { retries: 0, quorum: 1 }
    prompt: "w {{ item }}"
    output_schema: { type: object, required: [value], properties: { value: { type: string } } }
  - id: gate
    kind: gate
    title: ok?
    show: { n: $nodes.w.count }
  - id: join
    kind: code
    fn: identity
    requires_gate: gate
    input: { n: $nodes.w.count, outs: $nodes.w.outputs }
"""
    s = _call(server, "gren_run", {"spec_yaml": spec, "input": {"items": [1, 2, 3]}, "bridge": "inbox"})
    rid = s["run_id"]
    done: set[str] = set()
    deadline = time.time() + 30
    while time.time() < deadline:
        s = _call(server, "gren_wait", {"run_id": rid, "timeout_ms": 5000})
        if s["status"] in ("completed", "failed", "cancelled"):
            break
        if s["waiting_gates"]:
            assert s["waiting_gates"][0]["gate"] == "gate"
            assert _call(server, "gren_approve", {"run_id": rid, "gate": "gate", "decision": "approved", "by": "test"})["ok"]
            continue
        for t in _call(server, "gren_tasks", {"run_id": rid}):
            if t["task_id"] in done:
                continue
            done.add(t["task_id"])
            assert _call(server, "gren_claim_task", {"run_id": t["run_id"], "task_id": t["task_id"], "worker": "w1"})["ok"]
            bad = _call(server, "gren_complete_task", {"run_id": t["run_id"], "task_id": t["task_id"], "output": {"nope": 1}})
            assert "REJECTED" in bad
            out = generate_from_schema(t["output_schema"], random.Random(1), t["node_id"])
            r = _call(server, "gren_complete_task", {"run_id": t["run_id"], "task_id": t["task_id"], "output": out, "model": t["model"], "source": "subagent"})
            assert r["ok"]
    assert s["status"] == "completed", s
    assert len(done) == 3
    out = _call(server, "gren_output", {"run_id": rid})
    assert out["output"]["n"]["completed"] == 3
    assert "Verifier" in _call(server, "gren_metrics", {"run_id": rid})
    node = _call(server, "gren_node", {"run_id": rid, "node_id": "w"})
    assert node["node"]["status"] == "completed" and node["artifacts"]
    assert any(d["kind"] == "gate" for d in _call(server, "gren_decisions", {"run_id": rid}))
    assert "name: mcp-inbox" in _call(server, "gren_spec", {"run_id": rid})
    runs = _call(server, "gren_list_runs", {})
    assert any(r["id"] == rid for r in runs)
