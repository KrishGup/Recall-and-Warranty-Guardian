"""The gren runtime on Strands Agents.

A gren spec compiles into a Strands `Graph`:
  - every gren node is a `MultiAgentBase` executor (GrenNode) that reads its explicit inputs from the gren run state,
    executes (an Agent call, a reducer, a verification, a gate, a route, a nested run) and writes structured output back;
  - every gren dependency is a Strands edge whose condition is "all of the target's dependencies are complete", which
    turns Strands' OR-readiness into gren's AND-joins;
  - repair cycles (verify -> producer, gate reject -> route) are conditional back-edges with `reset_on_revisit`;
    a generation guard makes downstream nodes wait for fresh inputs after a repair;
  - human gates are Strands interrupts raised from a BeforeNodeCall hook; the run pauses (durably, via the gren checkpoint)
    and resumes with an interruptResponse;
  - budgets, retries, fallbacks, quorum, timeouts, replay/resume and fork are gren's; the agent loop, model providers,
    tools, structured output, hooks and telemetry are Strands'.
"""
from __future__ import annotations

import asyncio
import os
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable

from strands import Agent
from strands.hooks import HookProvider, HookRegistry
from strands.hooks.events import BeforeNodeCallEvent
from strands.interrupt import InterruptException
from strands.multiagent import GraphBuilder
from strands.multiagent.base import MultiAgentBase, MultiAgentResult, NodeResult, Status
from strands.types.event_loop import Metrics, Usage

from ..models._base import OneShotModel
from ..models.pricing import estimate_cost_usd, resolve_model, sum_usage
from ..models.registry import ModelRegistry, default_bridge
from ..reducers.builtin import ReducerCtx, get_reducer, load_reducer_module
from ..spec.analyze import Analysis, analyze
from ..spec.schema import (
    VERIFY_OUTPUT_SCHEMA,
    AgentNode,
    CodeNode,
    GateNode,
    GraphSpec,
    LoopNode,
    RouterNode,
    SubgraphNode,
    VerifyNode,
    effective_failure,
    effective_frozen,
    gates_of,
)
from .expr import Scope, eval_cond, is_ref, render_template, resolve_ref, resolve_value
from .state import RunState, RunStore, add_usage, new_node_record, now_iso
from .validate import apply_defaults, json_schema_to_model, model_to_plain, validate_against

TERMINAL = ("completed", "failed", "skipped")


class RunFailed(Exception):
    pass


class BudgetExceeded(RunFailed):
    pass


class RunCancelled(RunFailed):
    pass


TOOL_MAP: dict[str, str] = {
    "Read": "file_read", "Grep": "file_read", "Glob": "file_read", "Write": "file_write", "Edit": "editor", "Bash": "shell",
    "WebFetch": "http_request", "WebSearch": "tavily", "Python": "python_repl", "AWS": "use_aws", "Retrieve": "retrieve",
}


def strands_tools_for(names: list[str] | None, log: Callable[[str], None]) -> list[Any]:
    """Map gren tool names (Claude Code vocabulary) to strands_tools modules for Bedrock/Anthropic agents."""
    out: list[Any] = []
    seen: set[str] = set()
    for n in names or []:
        mod_name = TOOL_MAP.get(n, n)
        if mod_name in seen:
            continue
        seen.add(mod_name)
        try:
            mod = __import__(f"strands_tools.{mod_name}", fromlist=[mod_name])
            out.append(mod)
        except Exception as e:  # noqa: BLE001
            log(f"tool {n} ({mod_name}) unavailable: {e}")
    return out


@dataclass
class RunOptions:
    bridge: str | None = None
    default_bridge: str | None = None
    on_event: Callable[[dict[str, Any]], None] | None = None
    log: Callable[[str], None] | None = None
    gate_wait: str = "block"  # block | return
    cwd: str | None = None
    auto_approve: bool = False
    poll_s: float = 0.5


class RunContext:
    def __init__(self, store: RunStore, state: RunState, registry: ModelRegistry, options: RunOptions):
        self.store, self.state, self.registry, self.options = store, state, registry, options
        self.spec: GraphSpec = GraphSpec.model_validate(state.run["spec"])
        self.analysis: Analysis = analyze(self.spec)
        self.run_id: str = state.run["id"]
        self.width = asyncio.Semaphore(self.spec.budget.max_width if self.spec.budget and self.spec.budget.max_width else 8)
        self.wall_start = 0.0
        self.cancel_reason: str | None = None
        self.node_gen: dict[str, int] = {}
        self.required_gen: dict[str, int] = {}
        self.stale_deps: dict[str, set[str]] = {}
        self.repair_flag: dict[str, dict[str, Any]] = {}
        self.pending_approval: dict[str, dict[str, Any]] = {}
        self.children: list["GraphRun"] = []
        self.lock = asyncio.Lock()

    # ---- bookkeeping ----
    def log(self, msg: str) -> None:
        if self.options.log:
            self.options.log(msg)

    def emit(self, type_: str, node: str | None = None, item: int | None = None, data: dict[str, Any] | None = None) -> None:
        evt = self.store.append_event(self.run_id, type_, node, item, data)
        if self.options.on_event:
            try:
                self.options.on_event(evt)
            except Exception:  # noqa: BLE001
                pass

    def decision(self, node: str, kind: str, detail: str, state: dict[str, Any] | None = None) -> None:
        self.state.run["decisions"].append({"at": now_iso(), "node": node, "kind": kind, "detail": detail, "state": state})

    def save(self) -> None:
        if self.wall_start:
            self.state.run["totals"]["wall_ms"] = int((time.time() - self.wall_start) * 1000)
        self.store.save(self.state)

    def check_budget(self) -> None:
        b = self.spec.budget
        t = self.state.run["totals"]
        if b is None:
            return
        if b.max_cost_usd is not None and t["cost_usd"] >= b.max_cost_usd:
            self.decision("<run>", "budget", f"spend cap: ${t['cost_usd']:.4f} >= ${b.max_cost_usd}")
            raise BudgetExceeded(f"spend cap exceeded: ${t['cost_usd']:.4f} >= budget.max_cost_usd ${b.max_cost_usd} (frozen: spend_cap)")
        if b.max_wall_ms is not None and self.wall_start and (time.time() - self.wall_start) * 1000 >= b.max_wall_ms:
            raise BudgetExceeded(f"wall-clock budget exceeded: >= {b.max_wall_ms}ms")
        if b.max_agent_calls is not None and t["agent_calls"] >= b.max_agent_calls:
            raise BudgetExceeded(f"agent call budget exceeded: {t['agent_calls']} >= {b.max_agent_calls}")
        if b.max_tokens is not None and (t["usage"].get("inputTokens", 0) + t["usage"].get("outputTokens", 0)) >= b.max_tokens:
            raise BudgetExceeded("token budget exceeded")

    def check_cancel(self) -> None:
        if self.cancel_reason:
            raise RunCancelled(self.cancel_reason)

    def view(self, rec: dict[str, Any]) -> dict[str, Any]:
        v = rec.get("verify") or {}
        items = rec.get("items")
        return {
            "status": rec["status"], "output": rec.get("output"), "outputs": rec.get("outputs"),
            "items": [{"index": i["index"], "status": i["status"], "output": i.get("output"), "error": i.get("error")} for i in items] if items else None,
            "survivors": v.get("survivors"), "killed": v.get("killed"), "kill_rate": v.get("kill_rate"), "route": rec.get("route"), "error": rec.get("error"),
            "count": {"total": len(items), "completed": sum(1 for i in items if i["status"] == "completed"), "failed": sum(1 for i in items if i["status"] == "failed")} if items else None,
            "feedback": (rec.get("repair") or {}).get("feedback"),
        }

    def scope(self, **extra: Any) -> Scope:
        return Scope(
            input=self.state.run["input"], nodes={nid: self.view(r) for nid, r in self.state.nodes.items()}, run={"id": self.run_id},
            graph={"name": self.spec.name}, loop=(self.state.run.get("context") or {}).get("loop"),
            env={k: v for k, v in os.environ.items() if k.startswith("GREN_")}, **extra,
        )

    def bridge_for(self, node: AgentNode | VerifyNode) -> str:
        return self.options.bridge or node.bridge or (self.spec.defaults.bridge if self.spec.defaults else None) or self.state.run["bridge"]

    # ---- repair / generation guard ----
    def descendants(self, node_id: str) -> set[str]:
        out: set[str] = set()
        stack = [node_id]
        while stack:
            cur = stack.pop()
            if cur in out:
                continue
            out.add(cur)
            stack.extend(self.analysis.nodes[cur].dependents if cur in self.analysis.nodes else [])
        return out

    def schedule_repair(self, producer: str, verifier: str, round_: int, feedback: Any) -> None:
        reset = self.descendants(producer)
        for nid in reset:
            self.required_gen[nid] = round_
            self.stale_deps[nid] = {d for d in self.analysis.nodes[nid].deps if d in reset}
            rec = self.state.nodes[nid]
            if nid != verifier and nid != producer and rec["status"] in TERMINAL:
                self._reset_record(nid, f"repair round {round_} from {verifier}")
        self._reset_record(producer, f"repair round {round_} from {verifier}")
        self.state.nodes[producer]["repair"] = {"round": round_, "feedback": feedback}
        self.state.nodes[producer]["repairs"] = int(self.state.nodes[producer].get("repairs", 0)) + 1
        self.repair_flag[verifier] = {"producer": producer, "round": round_}
        self.decision(verifier, "repair", f'round {round_}: sending {len(feedback) if isinstance(feedback, list) else 1} rejection(s) back to "{producer}"; reset {", ".join(sorted(reset))}')
        self.emit("repair.scheduled", verifier, data={"producer": producer, "round": round_, "reset": sorted(reset)})
        self.save()

    def _reset_record(self, nid: str, reason: str) -> None:
        rec = self.state.nodes[nid]
        node = self.spec.node(nid)
        if node is not None and node.side_effect and rec.get("side_effect_done"):
            return
        for k in ("output", "outputs", "items", "error", "skip_reason", "route", "route_reason", "started_at", "ended_at", "duration_ms", "loop"):
            rec[k] = None
        rec["status"] = "pending"
        if node is not None and node.kind == "gate":
            rec["gate"] = None
            self.state.run["approvals"].pop(nid, None)
            self.store.clear_approval(self.run_id, nid)
        if node is not None and node.kind == "verify" and rec.get("verify"):
            rec["verify"] = {**rec["verify"], "survivors": [], "killed": []}
        self.emit("node.reset", nid, data={"reason": reason})

    def fresh_inputs(self, nid: str) -> bool:
        req = self.required_gen.get(nid, 0)
        return all(self.node_gen.get(d, 0) >= req for d in self.stale_deps.get(nid, ()))


# --------------------------------------------------------------------------------------------- executors


class GrenNode(MultiAgentBase):
    """One gren node as a Strands multi-agent node."""

    def __init__(self, ctx: RunContext, node: Any):
        super().__init__()
        self.ctx, self.node = ctx, node
        self.id = f"{ctx.run_id}:{node.id}"

    # Strands calls this with the auto-built dependency text; gren ignores it and resolves explicit inputs itself.
    async def invoke_async(self, task: Any, invocation_state: dict[str, Any] | None = None, **kwargs: Any) -> MultiAgentResult:
        ctx, node = self.ctx, self.node
        rec = ctx.state.nodes[node.id]
        t0 = time.time()
        usage_before = dict(rec.get("usage") or {})
        cost_before = float(rec.get("cost_usd") or 0)
        ctx.check_cancel()
        # replay: a terminal node with fresh inputs is memoized (resume / fork / revisit after a no-op)
        if rec["status"] in TERMINAL and ctx.fresh_inputs(node.id) and ctx.node_gen.get(node.id, 0) >= ctx.required_gen.get(node.id, 0):
            return self._result(rec, t0, usage_before, cost_before)
        if not ctx.fresh_inputs(node.id):
            # a dependency is being re-run by a repair cycle: no-op now, Strands re-triggers us when it completes
            return self._result(rec, t0, usage_before, cost_before, noop=True)
        if rec["status"] in TERMINAL and node.id in ctx.required_gen and ctx.node_gen.get(node.id, 0) < ctx.required_gen[node.id]:
            ctx._reset_record(node.id, "stale after repair")
        skip = self._activation_skip()
        if skip:
            rec.update(status="skipped", skip_reason=skip, ended_at=now_iso())
            ctx.node_gen[node.id] = ctx.required_gen.get(node.id, 0)
            ctx.decision(node.id, "skip", skip)
            ctx.emit("node.skipped", node.id, data={"reason": skip})
            ctx.save()
            return self._result(rec, t0, usage_before, cost_before)
        rec.update(status="running", started_at=now_iso(), ended_at=None, error=None)
        ctx.save()
        ctx.emit("node.started", node.id, data={"kind": node.kind, "repair_round": (rec.get("repair") or {}).get("round")})
        try:
            await self._dispatch(rec)
            if rec["status"] == "running":
                rec["status"] = "completed"
            rec["ended_at"] = now_iso()
            rec["duration_ms"] = int((time.time() - t0) * 1000)
            if node.id not in ctx.repair_flag:
                ctx.node_gen[node.id] = ctx.required_gen.get(node.id, 0)
            ctx.save()
            if rec["status"] == "completed":
                items = rec.get("items")
                ctx.emit("node.completed", node.id, data={"duration_ms": rec["duration_ms"], "cost_usd": rec["cost_usd"], "items": {"total": len(items), "completed": sum(1 for i in items if i["status"] == "completed")} if items else None})
            elif rec["status"] == "skipped":
                ctx.emit("node.skipped", node.id, data={"reason": rec.get("skip_reason")})
            return self._result(rec, t0, usage_before, cost_before)
        except RunFailed:
            self._mark_failed(rec, t0, traceback.format_exc(limit=1).strip().splitlines()[-1])
            raise
        except Exception as e:  # noqa: BLE001
            msg = str(e) or e.__class__.__name__
            self._mark_failed(rec, t0, msg)
            f = effective_failure(ctx.spec, node)
            ctx.decision(node.id, "failure", f"{msg} -> policy {f.on_failure}")
            if f.on_failure == "block":
                raise RunFailed(f'node "{node.id}" failed: {msg}') from e
            ctx.log(f"node {node.id} failed but on_failure=continue: {msg}")
            ctx.node_gen[node.id] = ctx.required_gen.get(node.id, 0)
            ctx.save()
            return self._result(rec, t0, usage_before, cost_before)

    def _mark_failed(self, rec: dict[str, Any], t0: float, msg: str) -> None:
        rec.update(status="failed", error=msg, ended_at=now_iso(), duration_ms=int((time.time() - t0) * 1000))
        self.ctx.save()
        self.ctx.emit("node.failed", self.node.id, data={"error": msg})

    def _result(self, rec: dict[str, Any], t0: float, usage_before: dict[str, Any], cost_before: float, noop: bool = False) -> MultiAgentResult:
        u = sum_usage(rec.get("usage"), {k: -v for k, v in usage_before.items()})
        return MultiAgentResult(
            status=Status.COMPLETED, results={},
            accumulated_usage=Usage(inputTokens=max(0, u.get("inputTokens", 0)), outputTokens=max(0, u.get("outputTokens", 0)), totalTokens=max(0, u.get("totalTokens", 0))),
            accumulated_metrics=Metrics(latencyMs=int((time.time() - t0) * 1000)), execution_count=0 if noop else 1, execution_time=int((time.time() - t0) * 1000),
        )

    def _activation_skip(self) -> str | None:
        ctx, node = self.ctx, self.node
        optional = set(node.optional or [])
        for d in ctx.analysis.nodes[node.id].deps:
            st = ctx.state.nodes[d]["status"]
            if st in ("skipped", "failed") and d not in optional:
                dn = ctx.spec.node(d)
                if dn is not None and dn.kind == "gate":
                    return f'gate "{d}" was not approved'
                reason = ctx.state.nodes[d].get("skip_reason")
                return f'upstream "{d}" {st}{f" ({reason})" if reason else ""}'
        for g in gates_of(node):
            gr = ctx.state.nodes[g]
            if gr["status"] != "completed" or (gr.get("gate") or {}).get("decision") not in ("approved", "auto"):
                return f'gate "{g}" not approved'
        if node.when is not None:
            try:
                ok = eval_cond(node.when, ctx.scope())
            except Exception as e:  # noqa: BLE001
                raise RunFailed(f"node {node.id}: cannot evaluate when: {e}") from e
            if not ok:
                return "when: condition false (route not selected)"
        return None

    async def _dispatch(self, rec: dict[str, Any]) -> None:
        k = self.node.kind
        if k == "agent":
            await self._run_agent(rec)
        elif k == "code":
            await self._run_code(rec)
        elif k == "verify":
            await self._run_verify(rec)
        elif k == "gate":
            await self._run_gate(rec)
        elif k == "router":
            self._run_router(rec)
        elif k == "loop":
            await self._run_loop(rec)
        elif k == "subgraph":
            await self._run_subgraph(rec)

    # ---- agent ----
    async def _run_agent(self, rec: dict[str, Any]) -> None:
        node: AgentNode = self.node
        ctx = self.ctx
        if node.map:
            arr = resolve_ref(node.map, ctx.scope())
            if not isinstance(arr, list):
                raise RuntimeError(f"map: {node.map} did not resolve to a list (got {type(arr).__name__})")

            async def one(item: Any, index: int) -> Any:
                r = await self._call_model(rec, ctx.scope(item=item, index=index, repair=rec.get("repair")), "agent", node.output_schema, index)
                return r["output"]

            await self._fan_out(rec, arr, one)
        else:
            r = await self._call_model(rec, ctx.scope(repair=rec.get("repair")), "agent", node.output_schema)
            rec["output"], rec["artifact"] = r["output"], r["artifact"]

    def _build_prompt(self, node: AgentNode | VerifyNode, scope: Scope, rec: dict[str, Any]) -> tuple[str | None, str]:
        prompt = render_template(node.prompt, scope) if node.prompt else ""
        if node.kind == "verify" and not node.prompt:
            prompt = "Candidate to verify:\n" + _json(scope.item) + "\n\nTry to falsify this candidate. Check that every claim is supported by its evidence, that sources are plausible and dated, and look for internal contradictions or missing fields. Kill it if you find a disqualifying problem."
        system = render_template(node.system, scope) if node.system else None
        parts = [prompt]
        if node.input:
            parts += ["", "<input>", _json(resolve_value(node.input, scope)), "</input>"]
        rp = rec.get("repair")
        if rp and "$repair" not in (node.prompt or "") and "repair" not in (node.prompt or ""):
            parts += ["", f'<repair_feedback round="{rp["round"]}">', _json(rp.get("feedback")), "</repair_feedback>",
                      "An independent verifier rejected parts of your previous output for the reasons above. Produce a corrected output that addresses every reason."]
        return system, "\n".join(parts)

    def _contract(self, role: str, schema: dict[str, Any], repair_errors: list[str] | None, bridge: str | None = None) -> str:
        if bridge == "claude-code":
            # The CLI enforces the schema itself through `--json-schema` and its structured-output tool. Restating the
            # schema as text, or stacking a bulleted rule list, measurably makes the session free-write JSON with its own
            # field names instead of calling that tool, which the engine then rejects. Keep this contract short prose.
            lines = [
                f'You are one bounded node ("{self.node.id}") inside a larger multi-agent graph. Your only job is to return the requested '
                "structured output through the structured output tool, using exactly the fields the schema defines and nothing else. "
                "Never invent sources, citations, numbers or facts you did not derive from the provided input; if evidence is missing, "
                "lower the confidence or leave the array empty rather than filling the gap.",
            ]
            if role == "verify":
                lines.append("You are an ADVERSARIAL verifier: your objective is to find the reason this candidate should be rejected, and you have authority to kill it. Only pass a candidate you could not falsify.")
            if repair_errors:
                lines += ["", "Your previous answer FAILED schema validation with these errors - fix them by using the structured output tool with the exact field names:"] + [f"  - {e}" for e in repair_errors]
            return "\n".join(lines)
        lines = [
            f'You are one bounded node ("{self.node.id}") inside a larger multi-agent graph. You have exactly one job: produce the requested structured output.',
            "Rules:",
            "- Respond with a single JSON object that validates against the provided JSON schema. No prose before or after it.",
            "- Never invent sources, citations, numbers or facts you did not actually derive from the provided input. If evidence is missing, say so inside the structured fields (lower confidence, empty arrays) rather than filling gaps.",
            "- Do not explain your reasoning outside the schema. Do not add fields that are not in the schema.",
        ]
        if role == "verify":
            lines.append("- You are an ADVERSARIAL verifier. Your objective is different from the producer's: find the reason this candidate should be rejected. You have authority to kill it. Only pass a candidate you could not falsify.")
        if repair_errors:
            lines += ["", "Your previous answer FAILED schema validation with these errors - fix them:"] + [f"  - {e}" for e in repair_errors]
        lines += ["", "JSON schema for your output:", _json(schema, indent=None)]
        return "\n".join(lines)

    async def _call_model(self, rec: dict[str, Any], scope: Scope, role: str, schema: dict[str, Any], item_index: int | None = None) -> dict[str, Any]:
        """One logical model call with the node's failure policy: retries, fallback, timeout, validation repair."""
        ctx, node = self.ctx, self.node
        f = effective_failure(ctx.spec, node)
        system, prompt = self._build_prompt(node, scope, rec)
        primary_bridge = ctx.bridge_for(node)
        primary_model = node.model or (ctx.spec.defaults.model if ctx.spec.defaults else None) or "sonnet"
        effort = node.effort or (ctx.spec.defaults.effort if ctx.spec.defaults else None)
        out_model = json_schema_to_model(schema, name=f"{node.id}_out")
        cap = ctx.spec.budget.max_cost_usd if ctx.spec.budget else None
        last_err: Exception | None = None
        max_attempts = 1 + f.retries
        for attempt in range(1, max_attempts + 1):
            use_fallback = bool(f.fallback) and attempt == max_attempts and attempt > 1
            bridge = (f.fallback.bridge if use_fallback and f.fallback and f.fallback.bridge and not ctx.options.bridge else primary_bridge)
            model_alias = f.fallback.model if use_fallback and f.fallback and f.fallback.model else primary_model
            model_id = ctx.registry.model_id_for(bridge, model_alias)
            ctx.check_budget()
            ctx.check_cancel()
            a_rec: dict[str, Any] = {"attempt": attempt, "item": item_index, "started_at": now_iso(), "model": model_id, "bridge": bridge, "status": "ok"}
            rec["attempts"].append(a_rec)
            if attempt > 1:
                rec["retries"] = int(rec.get("retries", 0)) + 1
                ctx.state.run["totals"]["retries"] += 1
                ctx.emit("node.retry", node.id, item_index, {"attempt": attempt, "model": model_id, "bridge": bridge, "fallback": use_fallback, "error": str(last_err)})
                await asyncio.sleep(f.backoff_ms * (2 ** (attempt - 2)) / 1000)
            remaining = max(0.0, cap - ctx.state.run["totals"]["cost_usd"]) if cap is not None else None
            per_call = min(node.max_cost_usd, remaining) if node.max_cost_usd is not None and remaining is not None else (node.max_cost_usd or remaining)
            node_opts = {"tools": node.tools, "max_turns": node.max_turns, "max_budget_usd": per_call, "cwd": self._cwd(scope), "timeout_s": f.timeout_ms / 1000}
            t0 = time.time()
            await ctx.width.acquire()
            ctx.emit("call.started", node.id, item_index, {"attempt": attempt, "model": model_id, "bridge": bridge, "role": role})
            try:
                repairs = 0
                errors: list[str] | None = None
                while True:
                    model = ctx.registry.create(bridge, model_alias, effort=effort, max_tokens=getattr(node, "max_output_tokens", None), node_opts=node_opts)
                    self._bind(model, attempt, item_index, role, bool(errors), f.timeout_ms / 1000)
                    sys_prompt = "\n\n".join(x for x in (self._contract(role, schema, errors, bridge), system) if x)
                    res = await asyncio.wait_for(self._invoke(model, bridge, sys_prompt, prompt, out_model, node), timeout=f.timeout_ms / 1000)
                    a_rec["usage"] = sum_usage(a_rec.get("usage"), res["usage"])
                    a_rec["cost_usd"] = float(a_rec.get("cost_usd") or 0) + float(res["cost_usd"] or 0)
                    add_usage(rec, res["usage"], res["cost_usd"])
                    add_usage(ctx.state.run["totals"], res["usage"], res["cost_usd"])
                    ctx.check_budget()
                    ok, errs = validate_against(schema, res["output"])
                    if ok:
                        break
                    if repairs >= f.repair_attempts:
                        a_rec["validation_errors"] = errs
                        raise RuntimeError(f"output failed schema validation after {repairs} repair attempt(s): {'; '.join(errs[:5])}")
                    repairs += 1
                    rec["repairs"] = int(rec.get("repairs", 0)) + 1
                    ctx.emit("call.invalid_output", node.id, item_index, {"attempt": attempt, "repair": repairs, "errors": errs})
                    errors = errs
                a_rec.update(status="ok", ended_at=now_iso(), duration_ms=int((time.time() - t0) * 1000), source=res.get("source"))
                artifact = ctx.store.write_artifact(ctx.run_id, f"{node.id}{f'.i{item_index}' if item_index is not None else ''}.a{attempt}", {
                    "node": node.id, "item": item_index, "attempt": attempt, "model": model_id, "bridge": bridge,
                    "request": {"system": sys_prompt, "prompt": prompt, "output_schema": schema, "effort": effort, "repair_rounds": repairs},
                    "response": {"output": res["output"], "raw": res.get("raw"), "usage": res["usage"], "cost_usd": res["cost_usd"], "duration_ms": a_rec["duration_ms"], "source": res.get("source"), "session_id": res.get("session_id")},
                })
                a_rec["artifact"] = artifact
                ctx.emit("call.finished", node.id, item_index, {"attempt": attempt, "ok": True, "duration_ms": a_rec["duration_ms"], "cost_usd": res["cost_usd"], "model": model_id, "source": res.get("source"), "repairs": repairs})
                return {"output": res["output"], "artifact": artifact}
            except (RunFailed, asyncio.CancelledError):
                raise
            except asyncio.TimeoutError:
                last_err = RuntimeError(f"timed out after {f.timeout_ms}ms")
                a_rec.update(status="timeout", error=str(last_err), ended_at=now_iso(), duration_ms=int((time.time() - t0) * 1000))
                ctx.emit("call.finished", node.id, item_index, {"attempt": attempt, "ok": False, "error": str(last_err), "model": model_id})
            except Exception as e:  # noqa: BLE001
                last_err = e
                kind = "invalid_output" if "schema validation" in str(e) else "error"
                a_rec.update(status=kind, error=str(e)[:800], ended_at=now_iso(), duration_ms=int((time.time() - t0) * 1000))
                ctx.emit("call.finished", node.id, item_index, {"attempt": attempt, "ok": False, "error": str(e)[:300], "model": model_id})
                if "not logged in" in str(e).lower() or "authenticate" in str(e).lower():
                    break
            finally:
                ctx.width.release()
                ctx.save()
        raise RuntimeError(str(last_err) if last_err else "model call failed")

    def _cwd(self, scope: Scope) -> str | None:
        node = self.node
        if getattr(node, "cwd", None):
            v = resolve_value(node.cwd, scope)
            return os.path.abspath(os.path.join(self.ctx.options.cwd or os.getcwd(), str(v)))
        return self.ctx.options.cwd

    def _bind(self, model: Any, attempt: int, item: int | None, role: str, repair: bool, timeout_s: float) -> None:
        if hasattr(model, "bind"):
            try:
                model.bind(self.ctx.run_id, self.node.id, item, attempt, role, timeout_s, self._inbox_event)  # InboxModel
            except TypeError:
                model.bind(self.node.id, attempt, item, repair)  # MockModel

    def _inbox_event(self, type_: str, data: dict[str, Any]) -> None:
        self.ctx.emit(type_, self.node.id, data.get("item"), data)

    async def _invoke(self, model: Any, bridge: str, system: str, prompt: str, out_model: type, node: Any) -> dict[str, Any]:
        """One structured call. One-shot providers go straight to Model.structured_output (one round trip);
        Bedrock/Anthropic run the full Strands Agent loop (tools, hooks, telemetry) with structured output."""
        if isinstance(model, OneShotModel):
            model.lenient_output = True
            out: Any = None
            async for ev in model.structured_output(out_model, [{"role": "user", "content": [{"text": prompt}]}], system_prompt=system):
                if "output" in ev:
                    out = ev["output"]
            usage = model.last_usage
            cost = model.last_cost_usd if model.last_cost_usd is not None else estimate_cost_usd(model.config["model_id"], usage)
            return {"output": model_to_plain(out), "raw": None, "usage": usage, "cost_usd": cost, "source": bridge, "session_id": model.last_session_id}
        tools = strands_tools_for(getattr(node, "tools", None), self.ctx.log)
        agent = Agent(model=model, tools=tools or None, system_prompt=system, callback_handler=None, name=self.node.id, structured_output_model=out_model)
        result = await agent.invoke_async(prompt)
        usage = dict(result.metrics.accumulated_usage)
        cost = estimate_cost_usd(model.config["model_id"] if hasattr(model, "config") else "sonnet", usage)
        return {"output": model_to_plain(result.structured_output), "raw": str(result), "usage": usage, "cost_usd": cost, "source": bridge, "session_id": None}

    # ---- fan-out ----
    async def _fan_out(self, rec: dict[str, Any], arr: list[Any], fn: Callable[[Any, int], Any], quorum_override: float | None = None) -> None:
        ctx, node = self.ctx, self.node
        f = effective_failure(ctx.spec, node)
        quorum = f.quorum if quorum_override is None else quorum_override
        if not rec.get("items") or len(rec["items"]) != len(arr):
            rec["items"] = [{"index": i, "status": "pending", "attempts": 0} for i in range(len(arr))]
        per_node = asyncio.Semaphore(max(1, min(node.max_width or 64, (ctx.spec.budget.max_width if ctx.spec.budget and ctx.spec.budget.max_width else 64), 64)))
        todo = [it for it in rec["items"] if it["status"] != "completed"]
        ctx.emit("fanout.started", node.id, data={"total": len(arr), "pending": len(todo), "width": node.max_width or (ctx.spec.budget.max_width if ctx.spec.budget else None)})

        async def run_item(it: dict[str, Any]) -> None:
            async with per_node:
                t0 = time.time()
                try:
                    ctx.check_cancel()
                    it["status"], it["attempts"] = "running", int(it.get("attempts", 0)) + 1
                    ctx.emit("item.started", node.id, it["index"])
                    out = await fn(arr[it["index"]], it["index"])
                    it.update(status="completed", output=out, error=None, duration_ms=int((time.time() - t0) * 1000))
                    ctx.emit("item.completed", node.id, it["index"], {"duration_ms": it["duration_ms"]})
                except RunFailed:
                    raise
                except Exception as e:  # noqa: BLE001
                    it.update(status="failed", error=str(e)[:500], duration_ms=int((time.time() - t0) * 1000))
                    ctx.emit("item.failed", node.id, it["index"], {"error": it["error"]})
                finally:
                    ctx.save()

        await asyncio.gather(*(run_item(it) for it in todo))
        completed = [i for i in rec["items"] if i["status"] == "completed"]
        failed = [i for i in rec["items"] if i["status"] == "failed"]
        rec["outputs"] = [i.get("output") for i in completed]
        ctx.emit("fanout.finished", node.id, data={"total": len(arr), "completed": len(completed), "failed": len(failed), "quorum": quorum})
        if failed:
            ctx.decision(node.id, "failure", f"fan-out completed {len(completed)}/{len(arr)} (quorum {quorum}); failed: " + " | ".join(f"#{i['index']}: {i.get('error')}" for i in failed)[:600])
        if arr and (not completed or len(completed) / len(arr) < quorum):
            raise RuntimeError(f"quorum not met: {len(completed)}/{len(arr)} items completed (need {int(-(-quorum * len(arr)) // 1)}). Failures: " + " | ".join(str(i.get("error")) for i in failed)[:400])

    # ---- code ----
    def _reducer(self, node: CodeNode | VerifyNode) -> Callable[..., Any]:
        if node.fn:
            return get_reducer(node.fn)
        if node.module:
            return load_reducer_module(node.module if os.path.isabs(node.module) else os.path.join(self.ctx.options.cwd or os.getcwd(), node.module))
        return get_reducer("identity")

    async def _run_code(self, rec: dict[str, Any]) -> None:
        node: CodeNode = self.node
        ctx = self.ctx
        f = effective_failure(ctx.spec, node)
        if node.side_effect and rec.get("side_effect_done"):
            ctx.log(f"code {node.id}: side effect already executed; reusing recorded output")
            return
        reducer = self._reducer(node)
        rctx = ReducerCtx(run_id=ctx.run_id, node_id=node.id, log=lambda m: ctx.log(f"[{node.id}] {m}"))

        async def once(scope: Scope) -> tuple[Any, Any]:
            inp = resolve_value(node.input or {}, scope)
            t0 = time.time()
            out = reducer(inp, node.args or {}, rctx)
            if asyncio.iscoroutine(out):
                out = await out
            ok, errs = validate_against(node.output_schema, out)
            if not ok:
                raise RuntimeError("code node output failed schema validation: " + "; ".join(errs))
            ctx.emit("code.executed", node.id, data={"duration_ms": int((time.time() - t0) * 1000), "stats": out.get("_stats") if isinstance(out, dict) else None})
            return inp, out

        retries = 0 if node.side_effect else f.retries

        async def with_retries(scope: Scope) -> tuple[Any, Any]:
            last: Exception | None = None
            for attempt in range(1, retries + 2):
                a = {"attempt": attempt, "started_at": now_iso(), "status": "ok", "bridge": "code"}
                rec["attempts"].append(a)
                try:
                    r = await once(scope)
                    a["ended_at"] = now_iso()
                    return r
                except Exception as e:  # noqa: BLE001
                    a.update(status="error", error=str(e)[:500], ended_at=now_iso())
                    last = e
                    if attempt <= retries:
                        rec["retries"] = int(rec.get("retries", 0)) + 1
                        ctx.emit("node.retry", node.id, data={"attempt": attempt + 1, "error": str(e)[:300]})
            raise last if last else RuntimeError("code node failed")

        if node.map:
            arr = resolve_ref(node.map, ctx.scope())
            if not isinstance(arr, list):
                raise RuntimeError(f"map: {node.map} did not resolve to a list")
            await self._fan_out(rec, arr, lambda item, index: _second(with_retries(ctx.scope(item=item, index=index))))
        else:
            inp, out = await with_retries(ctx.scope(repair=rec.get("repair")))
            rec["output"] = out
            rec["artifact"] = ctx.store.write_artifact(ctx.run_id, f"{node.id}.a{len(rec['attempts'])}", {"node": node.id, "input": inp, "output": out})
        if node.side_effect:
            rec["side_effect_done"] = True
            ctx.emit("side_effect.executed", node.id, data={"gates": gates_of(node)})

    # ---- verify ----
    async def _run_verify(self, rec: dict[str, Any]) -> None:
        node: VerifyNode = self.node
        ctx = self.ctx
        target = resolve_ref(node.target, ctx.scope())
        items = target if isinstance(target, list) else ([] if target is None else [target])
        threshold = node.kill_threshold if node.kill_threshold is not None else 0.5
        mode = node.mode or "agent"
        reducer = self._reducer(node) if mode == "code" else None
        verdicts: dict[int, dict[str, Any]] = {}
        rec["items"] = [{"index": i, "status": "pending", "attempts": 0} for i in range(len(items))]

        async def one(item: Any, index: int) -> Any:
            s = ctx.scope(item=item, index=index)
            if mode == "code":
                inp = {**(resolve_value(node.input or {}, s) or {}), "item": item, "index": index}
                out = reducer(inp, node.args or {}, ReducerCtx(ctx.run_id, node.id, ctx.log))  # type: ignore[misc]
                if asyncio.iscoroutine(out):
                    out = await out
            else:
                out = (await self._call_model(rec, s, "verify", VERIFY_OUTPUT_SCHEMA, index))["output"]
            ok, errs = validate_against(VERIFY_OUTPUT_SCHEMA, out)
            if not ok:
                raise RuntimeError("verifier output invalid: " + "; ".join(errs))
            verdicts[index] = out
            return out

        await self._fan_out(rec, items, one, quorum_override=0.0)
        survivors: list[Any] = []
        killed: list[dict[str, Any]] = []
        for i, item in enumerate(items):
            it = rec["items"][i]
            v = verdicts.get(i)
            if v is None or it["status"] != "completed":
                killed.append({"index": i, "item": item, "reasons": [f"verification did not execute: {it.get('error') or 'unknown error'}"], "confidence": 1})
            elif v["verdict"] == "kill" and float(v["confidence"]) >= threshold:
                killed.append({"index": i, "item": item, "reasons": v["reasons"], "confidence": v["confidence"]})
                ctx.emit("verify.kill", node.id, i, {"reasons": v["reasons"], "confidence": v["confidence"]})
            else:
                survivors.append(item)
        kill_rate = round(len(killed) / len(items), 3) if items else 0.0
        round_ = int((rec.get("verify") or {}).get("repair_round") or 0)
        rec["verify"] = {"total": len(items), "survivors": survivors, "killed": killed, "kill_rate": kill_rate, "repair_round": round_}
        rec["output"] = {"total": len(items), "survivors": survivors, "killed": killed, "kill_rate": kill_rate, "verified": len(verdicts)}
        ctx.decision(node.id, "verify", f"{len(killed)}/{len(items)} killed (threshold {threshold})" + (": " + " | ".join(f"#{k['index']} {(k['reasons'] or [''])[0]}" for k in killed)[:400] if killed else ""))
        ctx.emit("verify.finished", node.id, data={"total": len(items), "killed": len(killed), "kill_rate": kill_rate})
        if killed and node.repair and round_ < node.repair.max_rounds:
            rec["verify"]["repair_round"] = round_ + 1
            rec["repairs"] = int(rec.get("repairs", 0)) + 1
            rec["status"] = "completed"
            ctx.schedule_repair(node.repair.node, node.id, round_ + 1, [{"index": k["index"], "item": k["item"], "reasons": k["reasons"]} for k in killed])
            return
        if len(survivors) < (node.min_survivors or 0):
            raise RuntimeError(f"only {len(survivors)} survivor(s) < min_survivors {node.min_survivors}")
        if killed and node.repair and round_ >= node.repair.max_rounds:
            ctx.decision(node.id, "repair", f"repair budget exhausted after {round_} round(s); {len(killed)} item(s) remain killed - proceeding with survivors only")

    # ---- gate ----
    async def _run_gate(self, rec: dict[str, Any]) -> None:
        node: GateNode = self.node
        ctx = self.ctx
        approval = ctx.pending_approval.pop(node.id, None)
        if approval is None:
            approval = ctx.store.read_approval(ctx.run_id, node.id)
        if approval is None:
            raise RunFailed(f'gate "{node.id}" was executed without a decision')
        auto = approval.get("by") in ("auto", "auto_approve_when")
        rec["gate"] = {**(rec.get("gate") or {}), "decision": "auto" if auto else approval["decision"], "by": approval.get("by"), "comment": approval.get("comment"), "at": approval.get("at")}
        ctx.state.run["approvals"][node.id] = approval
        rec["output"] = {"decision": approval["decision"], "by": approval.get("by"), "comment": approval.get("comment"), "auto": auto}
        ctx.decision(node.id, "gate", f"{approval['decision']} by {approval.get('by')}" + (f": {approval.get('comment')}" if approval.get("comment") else ""))
        if approval["decision"] == "approved":
            rec["status"] = "completed"
            ctx.emit("gate.auto_approved" if auto else "gate.approved", node.id, data={"by": approval.get("by"), "comment": approval.get("comment")})
            return
        rec["status"] = "skipped"
        rec["skip_reason"] = f"rejected by {approval.get('by')}" + (f": {approval.get('comment')}" if approval.get("comment") else "")
        ctx.emit("gate.rejected", node.id, data={"by": approval.get("by"), "comment": approval.get("comment")})
        if node.on_reject and node.on_reject.route:
            round_ = int(rec.get("repairs", 0)) + 1
            if round_ > 3:
                raise RunFailed(f'gate "{node.id}" rejected {round_ - 1} times; repair budget exhausted')
            rec["repairs"] = round_
            ctx.schedule_repair(node.on_reject.route, node.id, round_, {"rejected_by": approval.get("by"), "comment": approval.get("comment") or ""})
            return
        if not (node.on_reject and node.on_reject.fail_run is False):
            raise RunFailed(f'gate "{node.id}" rejected by {approval.get("by")}' + (f": {approval.get('comment')}" if approval.get("comment") else ""))

    # ---- router ----
    def _run_router(self, rec: dict[str, Any]) -> None:
        node: RouterNode = self.node
        ctx = self.ctx
        scope = ctx.scope()
        route, reason = node.default, "default"
        for i, r in enumerate(node.routes):
            if eval_cond(r.when, scope):
                route, reason = r.route, r.reason or f"route[{i}] condition matched"
                break
        snapshot: dict[str, Any] = {}

        def walk(v: Any) -> None:
            if isinstance(v, str) and is_ref(v):
                snapshot[v] = resolve_ref(v, scope)
            elif isinstance(v, list):
                for x in v:
                    walk(x)
            elif isinstance(v, dict):
                for x in v.values():
                    walk(x)

        walk([r.model_dump() for r in node.routes])
        rec["route"], rec["route_reason"] = route, reason
        rec["output"] = {"route": route, "reason": reason, "snapshot": snapshot}
        ctx.decision(node.id, "route", f'selected "{route}" ({reason})', snapshot)
        ctx.emit("route.selected", node.id, data={"route": route, "reason": reason, "snapshot": snapshot})

    # ---- nested ----
    async def _run_child(self, spec: GraphSpec, child_id: str, input_: Any, round_: int | None = None, context: dict[str, Any] | None = None) -> RunState:
        ctx = self.ctx
        opts = RunOptions(bridge=ctx.options.bridge, default_bridge=ctx.state.run["bridge"], on_event=ctx.options.on_event, log=ctx.options.log, gate_wait="block", cwd=ctx.options.cwd, auto_approve=ctx.options.auto_approve)
        child = GraphRun.create(ctx.store, spec, f"{ctx.state.run['spec_file']}#{self.node.id}", input_, ctx.registry, opts, run_id=child_id,
                                parent={"run_id": ctx.run_id, "node_id": self.node.id, "round": round_}, context=context)
        ctx.children.append(child)
        try:
            st = await child.run_async()
        finally:
            ctx.children.remove(child)
        if st.run["status"] != "completed":
            raise RunFailed(f"nested run {child_id} {st.run['status']}" + (f": {st.run.get('error')}" if st.run.get("error") else ""))
        add_usage(self.ctx.state.nodes[self.node.id], st.run["totals"]["usage"], st.run["totals"]["cost_usd"], st.run["totals"]["agent_calls"])
        add_usage(ctx.state.run["totals"], st.run["totals"]["usage"], st.run["totals"]["cost_usd"], st.run["totals"]["agent_calls"])
        return st

    async def _run_subgraph(self, rec: dict[str, Any]) -> None:
        node: SubgraphNode = self.node
        ctx = self.ctx
        spec: GraphSpec = node.graph  # type: ignore[assignment]
        if node.map:
            arr = resolve_ref(node.map, ctx.scope())
            if not isinstance(arr, list):
                raise RuntimeError(f"map: {node.map} did not resolve to a list")

            async def one(item: Any, index: int) -> Any:
                inp = resolve_value(node.input or {}, ctx.scope(item=item, index=index, repair=rec.get("repair")))
                st = await self._run_child(spec, f"{ctx.run_id}/nested/{node.id}/item-{index}", inp, index)
                return st.run.get("output")

            await self._fan_out(rec, arr, one)
            return
        inp = resolve_value(node.input or {}, ctx.scope(repair=rec.get("repair")))
        n = len(rec["attempts"]) + 1
        rec["attempts"].append({"attempt": n, "started_at": now_iso(), "status": "ok", "bridge": "subgraph"})
        st = await self._run_child(spec, f"{ctx.run_id}/nested/{node.id}/{n}", inp)
        rec["output"] = st.run.get("output")
        rec["attempts"][-1]["ended_at"] = now_iso()

    async def _run_loop(self, rec: dict[str, Any]) -> None:
        node: LoopNode = self.node
        ctx = self.ctx
        base = resolve_value(node.input or {}, ctx.scope()) or {}
        seen: set[str] = set()
        collected: list[Any] = []
        per_round: list[dict[str, Any]] = []

        def key_of(it: Any) -> str:
            if not node.seen_key:
                return _json(it, indent=None)
            cur: Any = it
            for seg in node.seen_key.split("."):
                cur = cur.get(seg) if isinstance(cur, dict) else None
            return cur.strip().lower() if isinstance(cur, str) else _json(cur if cur is not None else it, indent=None)

        dry, stop, converged, prev, cost, t0, rounds = 0, "max_rounds", False, None, 0.0, time.time(), 0
        for round_ in range(1, node.until.max_rounds + 1):
            if node.until.max_cost_usd and cost >= node.until.max_cost_usd:
                stop = f"loop cost budget reached (${cost:.4f} >= ${node.until.max_cost_usd})"
                break
            if node.until.max_wall_ms and (time.time() - t0) * 1000 >= node.until.max_wall_ms:
                stop = "loop wall budget reached"
                break
            rounds = round_
            loop_ctx = {"round": round_, "seen": sorted(seen), "collected": list(collected), "prev": prev, "dry_rounds": dry}
            inp = {**base, **loop_ctx}
            child_id = f"{ctx.run_id}/nested/{node.id}/round-{round_}"
            ctx.emit("loop.round.started", node.id, data={"round": round_, "seen": len(seen), "collected": len(collected), "run_id": child_id})
            rt0 = time.time()
            st = await self._run_child(node.body, child_id, inp, round_, {"loop": loop_ctx})
            cost += float(st.run["totals"]["cost_usd"])
            found = resolve_ref(node.collect, Scope(input=inp, nodes={}, output=st.run.get("output"), loop=loop_ctx))
            items = found if isinstance(found, list) else ([] if found is None else [found])
            fresh = []
            for it in items:
                k = key_of(it)
                if k in seen:
                    continue
                seen.add(k)
                fresh.append(it)
            collected.extend(fresh)
            dry = dry + 1 if not fresh else 0
            prev = st.run.get("output")
            per_round.append({"round": round_, "run_id": child_id, "items": len(items), "fresh": len(fresh), "cost_usd": st.run["totals"]["cost_usd"], "duration_ms": int((time.time() - rt0) * 1000)})
            ctx.emit("loop.round.finished", node.id, data={"round": round_, "items": len(items), "fresh": len(fresh), "dry_rounds": dry, "cost_usd": st.run["totals"]["cost_usd"]})
            ctx.decision(node.id, "loop", f"round {round_}: {len(items)} found, {len(fresh)} new, {dry} dry round(s)")
            if node.until.converged is not None and eval_cond(node.until.converged, Scope(input=inp, nodes={}, output=prev, loop={**loop_ctx, "fresh": len(fresh), "collected": list(collected), "dry_rounds": dry})):
                converged, stop = True, "converged condition held"
                break
            if node.until.no_new_for_rounds and dry >= node.until.no_new_for_rounds:
                converged, stop = True, f"no new findings for {dry} round(s)"
                break
            ctx.check_budget()
        rec["loop"] = {"rounds": rounds, "stop_reason": stop, "converged": converged, "collected": len(collected), "seen": len(seen), "cost_usd": round(cost, 5)}
        rec["output"] = {"items": collected, "rounds": rounds, "converged": converged, "stop_reason": stop, "per_round": per_round, "seen": sorted(seen)}
        ctx.decision(node.id, "loop", f"stopped after {rounds} round(s): {stop}; {len(collected)} unique item(s)")
        ctx.emit("loop.finished", node.id, data={"rounds": rounds, "converged": converged, "stop_reason": stop, "collected": len(collected)})
        if not converged and (node.on_nonconvergence or "accept") == "fail":
            raise RuntimeError(f"loop did not converge: {stop}")


async def _second(coro: Any) -> Any:
    _, out = await coro
    return out


def _json(v: Any, indent: int | None = 2) -> str:
    import json

    return json.dumps(v, indent=indent, ensure_ascii=False, default=str)


# --------------------------------------------------------------------------------------------- gates as interrupts


class GateHooks(HookProvider):
    """Turns gren gates into Strands interrupts: before a gate node runs, decide or pause the graph."""

    def __init__(self, ctx: RunContext):
        self.ctx = ctx

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeNodeCallEvent, self.before_node)

    def before_node(self, event: BeforeNodeCallEvent) -> None:
        ctx = self.ctx
        node = ctx.spec.node(event.node_id)
        if node is None or node.kind != "gate":
            return
        rec = ctx.state.nodes[node.id]
        if rec["status"] in TERMINAL and ctx.fresh_inputs(node.id) and ctx.node_gen.get(node.id, 0) >= ctx.required_gen.get(node.id, 0):
            return  # replay
        if not ctx.fresh_inputs(node.id):
            return
        for d in ctx.analysis.nodes[node.id].deps:
            if ctx.state.nodes[d]["status"] in ("skipped", "failed") and d not in set(node.optional or []):
                return  # the executor will skip it
        if node.when is not None and not eval_cond(node.when, ctx.scope()):
            return
        gate: GateNode = node  # type: ignore[assignment]
        rec["gate"] = rec.get("gate") or {}
        rec["gate"].setdefault("requested_at", now_iso())
        if gate.auto_approve_when is not None and eval_cond(gate.auto_approve_when, ctx.scope()):
            ctx.pending_approval[gate.id] = {"gate": gate.id, "decision": "approved", "by": "auto", "comment": "auto_approve_when condition held", "at": now_iso()}
            return
        existing = ctx.store.read_approval(ctx.run_id, gate.id)
        if existing and existing.get("by") != "system" and existing.get("at", "") >= rec["gate"]["requested_at"]:
            ctx.pending_approval[gate.id] = existing
            return
        if ctx.options.auto_approve:
            ctx.pending_approval[gate.id] = {"gate": gate.id, "decision": "approved", "by": "auto-approve", "comment": "auto-approved (run started with auto_approve)", "at": now_iso()}
            return
        scope = ctx.scope()
        show = resolve_value(gate.show, scope) if gate.show is not None else None
        prompt = render_template(gate.prompt, scope) if gate.prompt else None
        if rec["status"] != "waiting_approval":
            rec["status"] = "waiting_approval"
            rec["output"] = None
            rec["artifact"] = ctx.store.write_artifact(ctx.run_id, f"{gate.id}.gate", {"title": gate.title, "prompt": prompt, "show": show, "approve_effect": gate.approve_effect, "reject_effect": gate.reject_effect})
            ctx.save()
            ctx.emit("gate.waiting", gate.id, data={"title": gate.title, "prompt": prompt, "show": show, "approve_effect": gate.approve_effect, "reject_effect": gate.reject_effect, "timeout_ms": gate.timeout_ms})
            ctx.log(f'gate "{gate.id}" ({gate.title}) is waiting for approval: gren approve {ctx.run_id} {gate.id}')
        response = event.interrupt(f"gate:{gate.id}", reason={"gate": gate.id, "title": gate.title, "prompt": prompt, "approve_effect": gate.approve_effect, "reject_effect": gate.reject_effect})
        if isinstance(response, dict) and response.get("decision"):
            ctx.pending_approval[gate.id] = {"gate": gate.id, "at": now_iso(), **response}


# --------------------------------------------------------------------------------------------- the run


class GraphRun:
    def __init__(self, store: RunStore, state: RunState, registry: ModelRegistry, options: RunOptions):
        self.store, self.state, self.registry, self.options = store, state, registry, options
        self.ctx = RunContext(store, state, registry, options)
        self.graph = None
        self._approve_event = asyncio.Event()
        self._loop: asyncio.AbstractEventLoop | None = None

    # ---- construction ----
    @classmethod
    def create(cls, store: RunStore, spec: GraphSpec, spec_file: str, input_: Any, registry: ModelRegistry, options: RunOptions, run_id: str | None = None,
               parent: dict[str, Any] | None = None, context: dict[str, Any] | None = None, labels: dict[str, str] | None = None) -> "GraphRun":
        a = analyze(spec)
        errors = [f for f in a.findings if f.level == "error"]
        if errors:
            raise RunFailed(f'graph "{spec.name}" failed validation:\n' + "\n".join(f"  - {e.code}{f' ({e.node})' if e.node else ''}: {e.message}" for e in errors))
        if spec.input_schema:
            input_ = apply_defaults(spec.input_schema, input_ or {})
            ok, errs = validate_against(spec.input_schema, input_)
            if not ok:
                raise RunFailed("input does not match input_schema:\n" + "\n".join(f"  - {e}" for e in errs))
        bridge = options.bridge or (spec.defaults.bridge if spec.defaults else None) or options.default_bridge or default_bridge().name
        state = store.create(spec, spec_file, input_, bridge, (spec.budget.model_dump(exclude_none=True) if spec.budget else {}), effective_frozen(spec), run_id, parent, labels, context)
        return cls(store, state, registry, options)

    @classmethod
    def resume(cls, store: RunStore, run_id: str, registry: ModelRegistry, options: RunOptions) -> "GraphRun":
        state = store.load(run_id)
        spec = GraphSpec.model_validate(state.run["spec"])
        reset: list[str] = []
        for rec in state.nodes.values():
            node = spec.node(rec["id"])
            if node is None:
                continue
            if rec["status"] in ("running", "waiting_task"):
                if node.side_effect and not rec.get("side_effect_done"):
                    rec["status"], rec["error"] = "failed", "interrupted while executing a side effect; not re-run automatically (frozen: no_side_effect_retry_without_idempotency). Inspect and resume manually."
                else:
                    rec["status"], rec["error"] = "pending", None
                    for it in rec.get("items") or []:
                        if it["status"] != "completed":
                            it["status"] = "pending"
                    reset.append(rec["id"])
            elif rec["status"] == "failed" and effective_failure(spec, node).on_failure == "block" and not (node.side_effect and rec.get("side_effect_done")) and "interrupted while executing a side effect" not in (rec.get("error") or ""):
                rec["status"], rec["error"] = "pending", None
                for it in rec.get("items") or []:
                    if it["status"] != "completed":
                        it["status"] = "pending"
                reset.append(rec["id"])
            elif rec["status"] == "skipped" and str(rec.get("skip_reason") or "").startswith("upstream "):
                rec["status"], rec["skip_reason"] = "pending", None
                reset.append(rec["id"])
            elif rec["status"] == "waiting_approval":
                rec["status"] = "pending"
        if state.run["status"] != "completed" or reset:
            state.run["status"] = "created"
        state.run["error"] = None
        state.run["warnings"] = None
        store.save(state)
        run = cls(store, state, registry, options)
        run.ctx.emit("run.resumed", data={"reset": reset})
        return run

    @classmethod
    def fork(cls, store: RunStore, run_id: str, from_nodes: list[str], registry: ModelRegistry, options: RunOptions, new_run_id: str | None = None,
             spec: GraphSpec | None = None, spec_file: str | None = None, input_: Any = None) -> "GraphRun":
        state = store.fork(run_id, new_run_id)
        if spec is not None:
            a = analyze(spec)
            errors = [f for f in a.findings if f.level == "error"]
            if errors:
                raise RunFailed("replacement spec failed validation:\n" + "\n".join(f"  - {e.code}: {e.message}" for e in errors))
            state.run["spec"] = spec.model_dump(exclude_none=True, by_alias=True)
            state.run["spec_file"] = spec_file or state.run["spec_file"]
            state.run["budget"] = spec.budget.model_dump(exclude_none=True) if spec.budget else {}
            state.run["frozen"] = effective_frozen(spec)
        the_spec = GraphSpec.model_validate(state.run["spec"])
        if input_ is not None:
            state.run["input"] = apply_defaults(the_spec.input_schema, input_) if the_spec.input_schema else input_
        a = analyze(the_spec)
        ids = {n.id for n in the_spec.nodes}
        for nid in list(state.nodes):
            if nid not in ids:
                del state.nodes[nid]
        for n in the_spec.nodes:
            state.nodes.setdefault(n.id, new_node_record(n.id, n.kind))
        reset: set[str] = set()
        stack = list(from_nodes)
        while stack:
            cur = stack.pop()
            if cur not in ids:
                raise RunFailed(f'fork: unknown node "{cur}"')
            if cur in reset:
                continue
            reset.add(cur)
            stack.extend(a.nodes[cur].dependents)
        for rec in state.nodes.values():
            if rec["status"] not in TERMINAL:
                reset.add(rec["id"])
        run = cls(store, state, registry, options)
        for nid in reset:
            rec = state.nodes[nid]
            rec.update(attempts=[], cost_usd=0.0, usage={}, agent_calls=0, retries=0, repairs=0, repair=None, verify=None, loop=None, side_effect_done=None)
            run.ctx._reset_record(nid, f"fork from {run_id}")
        kept = [r for r in state.nodes.values() if r["id"] not in reset]
        state.run["totals"] = {"cost_usd": sum(float(r.get("cost_usd") or 0) for r in kept), "usage": {}, "agent_calls": sum(int(r.get("agent_calls") or 0) for r in kept), "retries": sum(int(r.get("retries") or 0) for r in kept), "wall_ms": 0}
        for r in kept:
            state.run["totals"]["usage"] = sum_usage(state.run["totals"]["usage"], r.get("usage"))
        state.run["decisions"] = [d for d in state.run["decisions"] if d["node"] not in reset]
        state.run["started_at"] = None
        store.save(state)
        run.ctx.emit("run.fork_prepared", data={"from": run_id, "reset": sorted(reset), "kept": [r["id"] for r in kept]})
        return run

    @property
    def id(self) -> str:
        return self.state.run["id"]

    # ---- compile ----
    def build_graph(self) -> Any:
        ctx = self.ctx
        spec, a = ctx.spec, ctx.analysis
        builder = GraphBuilder()
        nodes: dict[str, GrenNode] = {}
        for n in spec.nodes:
            nodes[n.id] = GrenNode(ctx, n)
            builder.add_node(nodes[n.id], n.id)

        def all_deps_done(target: str) -> Callable[..., bool]:
            deps = list(a.nodes[target].deps)

            def cond(state: Any, **_: Any) -> bool:
                completed = {n_.node_id for n_ in state.completed_nodes}
                return all(d in completed for d in deps)

            return cond

        for n in spec.nodes:
            for d in a.nodes[n.id].deps:
                builder.add_edge(d, n.id, condition=all_deps_done(n.id))
        repair_rounds = 0
        for n in spec.nodes:
            if n.kind == "verify" and n.repair:
                repair_rounds += n.repair.max_rounds

                def repair_cond(state: Any, verifier: str = n.id, **_: Any) -> bool:
                    return ctx.repair_flag.pop(verifier, None) is not None

                builder.add_edge(n.id, n.repair.node, condition=repair_cond)
            if n.kind == "gate" and n.on_reject and n.on_reject.route:
                repair_rounds += 3

                def reject_cond(state: Any, gate: str = n.id, **_: Any) -> bool:
                    return ctx.repair_flag.pop(gate, None) is not None

                builder.add_edge(n.id, n.on_reject.route, condition=reject_cond)
        for n in spec.nodes:
            if not a.nodes[n.id].deps:
                builder.set_entry_point(n.id)
        builder.reset_on_revisit(True)
        builder.set_max_node_executions(len(spec.nodes) * (2 + repair_rounds) * 3 + 10)
        if spec.budget and spec.budget.max_wall_ms:
            builder.set_execution_timeout(spec.budget.max_wall_ms / 1000)
        builder.set_hook_providers([GateHooks(ctx)])
        builder.set_graph_id(self.id.replace("/", "_"))
        return builder.build()

    # ---- controls ----
    def approve(self, gate: str, decision: str, by: str = "human", comment: str | None = None) -> dict[str, Any]:
        node = self.ctx.spec.node(gate)
        if node is None or node.kind != "gate":
            for child in self.ctx.children:
                if child.ctx.spec.node(gate) is not None:
                    return child.approve(gate, decision, by, comment)
            raise ValueError(f'"{gate}" is not a gate node')
        approval = {"gate": gate, "decision": decision, "by": by, "comment": comment, "at": now_iso()}
        self.store.write_approval(self.id, approval)
        self._wake()
        return approval

    def cancel(self, reason: str = "cancelled") -> None:
        self.ctx.cancel_reason = reason
        for child in self.ctx.children:
            child.cancel(reason)
        self._wake()

    def _wake(self) -> None:
        """Wake the gate wait from any thread (approve/cancel are called from CLI prompts, HTTP and MCP threads)."""
        loop = self._loop
        if loop is not None and loop.is_running():
            try:
                loop.call_soon_threadsafe(self._approve_event.set)
                return
            except RuntimeError:
                pass
        self._approve_event.set()

    # ---- execution ----
    async def run_async(self) -> RunState:
        ctx, run = self.ctx, self.state.run
        if run["status"] == "completed":
            return self.state
        self._loop = asyncio.get_running_loop()
        run["status"] = "running"
        run["started_at"] = run.get("started_at") or now_iso()
        ctx.wall_start = time.time() - float(run["totals"].get("wall_ms") or 0) / 1000
        ctx.save()
        ctx.emit("run.started", data={"graph": run["graph"], "bridge": run["bridge"], "nodes": len(self.state.nodes), "critical_path_est_ms": ctx.analysis.critical_path["est_ms"], "engine": "strands"})
        self.graph = self.build_graph()
        task: Any = run["graph"]
        try:
            while True:
                ctx.check_cancel()
                result = await self.graph.invoke_async(task)
                if result.status == Status.INTERRUPTED and result.interrupts:
                    responses = await self._wait_for_gates(result.interrupts)
                    if responses is None:
                        run["status"] = "paused"
                        ctx.save()
                        return self.state
                    task = responses
                    continue
                if result.status == Status.FAILED:
                    failed = "; ".join(f"{k}: {v.result}" for k, v in result.results.items() if v.status == Status.FAILED)[:500]
                    raise RunFailed("graph execution failed: " + (failed or f"node execution limit or timeout reached after {result.execution_count} executions"))
                break
            await self._finish()
        except Exception as e:  # noqa: BLE001
            await self._fail(e)
        return self.state

    def run(self) -> RunState:
        return asyncio.run(self.run_async())

    async def _wait_for_gates(self, interrupts: list[Any]) -> list[dict[str, Any]] | None:
        """Block until every waiting gate has a decision (in-process approve() or an approval file); None => return paused."""
        ctx = self.ctx
        gates = [(itr, str(itr.name).split(":", 1)[1]) for itr in interrupts if str(itr.name).startswith("gate:")]
        if not gates:
            return [{"interruptResponse": {"interruptId": itr.id, "response": {}}} for itr in interrupts]
        self.state.run["status"] = "paused"
        ctx.save()
        ctx.emit("run.paused", data={"waiting": [g for _, g in gates]})
        responses: list[dict[str, Any]] = []
        pending: dict[str, tuple[Any, str]] = {itr.id: (itr, gate) for itr, gate in gates}
        while pending:
            for iid, (itr, gate) in list(pending.items()):
                a = self._fresh_approval(gate)
                if a is None:
                    node: GateNode = ctx.spec.node(gate)  # type: ignore[assignment]
                    req = (ctx.state.nodes[gate].get("gate") or {}).get("requested_at")
                    if node.timeout_ms and req and (time.time() - _ts(req)) * 1000 > node.timeout_ms and (node.on_timeout or "wait") == "reject":
                        a = {"gate": gate, "decision": "rejected", "by": "timeout", "comment": f"no decision within {node.timeout_ms}ms", "at": now_iso()}
                        ctx.store.write_approval(self.id, a)
                if a is not None:
                    responses.append({"interruptResponse": {"interruptId": itr.id, "response": {"decision": a["decision"], "by": a.get("by"), "comment": a.get("comment")}}})
                    del pending[iid]
            if pending:
                if ctx.options.gate_wait == "return":
                    return None
                self._approve_event.clear()
                try:
                    await asyncio.wait_for(self._approve_event.wait(), timeout=ctx.options.poll_s)
                except asyncio.TimeoutError:
                    pass
                ctx.check_cancel()
        self.state.run["status"] = "running"
        ctx.save()
        ctx.emit("run.resumed", data={"gates": [g for _, g in gates]})
        return responses

    def _fresh_approval(self, gate: str) -> dict[str, Any] | None:
        a = self.ctx.store.read_approval(self.id, gate)
        req = (self.ctx.state.nodes[gate].get("gate") or {}).get("requested_at")
        if a and a.get("by") != "system" and (not req or a.get("at", "") >= req):
            return a
        return None

    async def _finish(self) -> None:
        ctx, run = self.ctx, self.state.run
        scope = ctx.scope()
        out = ctx.spec.output
        if out and isinstance(out.get("from"), str):
            v = scope.nodes.get(out["from"]) or {}
            run["output"] = v.get("output") if v.get("output") is not None else v.get("outputs")
        elif out:
            run["output"] = resolve_value(out, scope)
        else:
            sinks = [nid for nid, na in ctx.analysis.nodes.items() if not na.dependents]
            run["output"] = {nid: (scope.nodes[nid].get("output") if scope.nodes[nid].get("output") is not None else scope.nodes[nid].get("outputs")) for nid in sinks if scope.nodes[nid]["status"] == "completed"}
        if ctx.spec.output_schema:
            ok, errs = validate_against(ctx.spec.output_schema, run["output"])
            if not ok:
                raise RunFailed("graph output does not match output_schema: " + "; ".join(errs))
        failed = [n["id"] for n in self.state.nodes.values() if n["status"] == "failed"]
        skipped = [n["id"] for n in self.state.nodes.values() if n["status"] == "skipped"]
        run["warnings"] = [f"degraded: nodes failed and were tolerated: {', '.join(failed)}"] if failed else []
        run["status"] = "completed"
        run["ended_at"] = now_iso()
        ctx.save()
        ctx.emit("run.completed", data={"cost_usd": run["totals"]["cost_usd"], "wall_ms": run["totals"]["wall_ms"], "failed": failed, "skipped": skipped, "degraded": bool(failed)})

    async def _fail(self, e: Exception) -> None:
        run = self.state.run
        msg = str(e) or e.__class__.__name__
        self.cancel(msg)
        run["status"] = "cancelled" if isinstance(e, RunCancelled) else "failed"
        run["error"] = msg
        run["ended_at"] = now_iso()
        self.ctx.save()
        self.ctx.emit("run.cancelled" if run["status"] == "cancelled" else "run.failed", data={"error": msg, "budget": isinstance(e, BudgetExceeded)})
        if not isinstance(e, RunFailed):
            self.ctx.log(f"run {self.id} crashed: {msg}\n{traceback.format_exc()[-1500:]}")


def _ts(s: str) -> float:
    from datetime import datetime

    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0
