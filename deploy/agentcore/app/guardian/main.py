"""Guardian on Amazon Bedrock AgentCore Runtime.

One HTTP entrypoint (`POST /invocations`, `GET /ping` come from the SDK). The payload's `kind` selects the work:

    {"kind": "sweep", "window_days": 45, "full_scan": false, "timeout_s": 1500}
    {"kind": "answer", "decision_id": "dec_...", "choice": "request_remedy", "by": "sms"}
    {"kind": "intake", "text": "<receipt or order email>", "source": "email"}
    {"kind": "status"}                         summary + decisions
    {"kind": "seed", "household": {...}}       load a household (defaults to the bundled demo)
    {"kind": "sync"}                           pull/push only

The container's disk is ephemeral, so every invocation pulls the household store and the gren run store from S3
(GUARDIAN_S3_BUCKET) first and pushes them back at the end. A human gate never holds an invocation open: the graph
pauses durably at the gate and the household's answer arrives as a later `answer` invocation that resumes it.
Deterministic nodes, judgment in agents; the same code as `guardian serve` on a laptop."""
from __future__ import annotations

import json
import os
import time
from dataclasses import replace
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp

DATA = os.environ.get("GUARDIAN_DATA") or "/tmp/guardian/household"
RUNS = os.environ.get("GUARDIAN_RUNS") or "/tmp/guardian/runs"
os.environ["GUARDIAN_DATA"] = DATA
os.environ["GUARDIAN_RUNS"] = RUNS
os.environ.setdefault("GUARDIAN_ENV_FILE", "")  # no .env inside the runtime; configuration comes from envVars
HERE = os.path.dirname(os.path.abspath(__file__))

app = BedrockAgentCoreApp()
log = app.logger


def _targets():
    from guardian.state_sync import sync_targets_from_env

    return sync_targets_from_env(DATA, RUNS)


def _guardian():
    from guardian.service import Guardian

    g, _ = Guardian.build(data_dir=DATA, runs_dir=RUNS, bridge=os.environ.get("GREN_BRIDGE") or "bedrock", quiet=True, with_gren_app=False)
    control = g.control
    original = control._options

    def options(bridge, auto_approve, cwd):
        # return at the gate instead of blocking the invocation; the answer resumes the run later
        return replace(original(bridge, auto_approve, cwd), gate_wait="return")

    control._options = options  # type: ignore[method-assign]
    return g


def _seed(g, household: dict[str, Any] | None) -> dict[str, Any]:
    from guardian.models import Household, Preferences

    if household is None:
        with open(os.path.join(HERE, "demo", "household.json"), encoding="utf-8") as f:
            household = json.load(f)
    g.store.reset()
    hh = Household.model_validate(household.get("household") or {})
    g.store.save_household(hh)
    g.store.save_prefs(Preferences.model_validate(household.get("prefs") or {}))
    n = 0
    for row in household.get("items") or []:
        g.add_item(row, source="seed")
        n += 1
    return {"seeded": n, "household": hh.name}


def _run_summary(g, rid: str) -> dict[str, Any]:
    run = g.run_store.load(rid).run
    return {"run_id": rid, "status": run["status"], "cost_usd": round(float(run["totals"]["cost_usd"] or 0), 4), "wall_ms": run["totals"].get("wall_ms"), "error": run.get("error"), "output": run.get("output")}


@app.entrypoint
def invoke(payload: dict[str, Any], context: Any = None) -> dict[str, Any]:
    t0 = time.time()
    payload = payload if isinstance(payload, dict) else {}
    kind = str(payload.get("kind") or "status")
    targets = _targets()
    pulled = [t.pull() for t in targets]
    log.info("guardian invoke kind=%s pulled=%s", kind, pulled)
    result: dict[str, Any]
    try:
        g = _guardian()
        if kind == "seed":
            result = _seed(g, payload.get("household") if isinstance(payload.get("household"), dict) else None)
        elif kind == "sweep":
            rid = g.start_sweep(window_days=int(payload.get("window_days") or 45), full_scan=bool(payload.get("full_scan")), trigger=str(payload.get("trigger") or "agentcore"))
            g.wait(rid, timeout_s=float(payload.get("timeout_s") or 1500))
            result = {**_run_summary(g, rid), "decisions": g.decisions()["pending"]}
        elif kind == "answer":
            res = g.answer(str(payload["decision_id"]), str(payload["choice"]), by=str(payload.get("by") or "agentcore"), comment=payload.get("comment") if isinstance(payload.get("comment"), str) else None)
            if res.get("resumed") and res.get("run_id"):
                g.wait(str(res["run_id"]), timeout_s=float(payload.get("timeout_s") or 900))
                res["run"] = _run_summary(g, str(res["run_id"]))
            result = res
        elif kind == "intake":
            result = g.intake(str(payload.get("text") or ""), source=str(payload.get("source") or "email"), timeout_s=float(payload.get("timeout_s") or 300))
        elif kind == "sync":
            result = {"pulled": pulled}
        else:
            result = {"summary": g.summary(), "decisions": g.decisions()}
    except Exception as e:  # noqa: BLE001 - report, never crash the runtime
        log.exception("guardian invoke failed")
        result = {"error": f"{e.__class__.__name__}: {e}"}
    pushed = [t.push() for t in targets]
    result["_sync"] = {"pulled": pulled, "pushed": pushed}
    result["_ms"] = int((time.time() - t0) * 1000)
    result["kind"] = kind
    return result


if __name__ == "__main__":
    app.run()
