"""The Guardian service: the household store, the gren run control, and the layer between them.

The gren graph raises a Strands interrupt at the household gate; this layer turns the gate's `show` payload into
Decision rows, notifies the household, and when the household answers, writes the gate approval so the graph resumes.
It also formats every engine event into the activity log the dashboard shows."""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from gren.control import RunControl
from gren.engine.state import RunStore
from gren.models.registry import ModelRegistry, default_bridge

from .models import Activity, Decision, DecisionOption, InventoryItem, MatchCandidate, Preferences, RecallRecord, SweepRecord, now_iso
from .notify import Notifier, mask_phone
from .policy import warranty as warranty_policy
from .remote import AgentRuntime
from .state_sync import pull_all, sync_targets_from_env
from .store import Store

GRAPHS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "graphs")
SWEEP_GRAPH = "nightly-sweep.yaml"
INTAKE_GRAPH = "intake.yaml"
DECISION_TTL_H = 72

RECALL_OPTIONS = [
    DecisionOption(key="request_remedy", label="Request remedy", style="critical"),
    DecisionOption(key="no_longer_own", label="No longer own it", style="outline"),
    DecisionOption(key="not_mine", label="Not mine", style="outline"),
    DecisionOption(key="snooze", label="Ask me tomorrow", style="text"),
]
WARRANTY_OPTIONS = [
    DecisionOption(key="report_problem", label="Something's wrong with it", style="primary"),
    DecisionOption(key="fine", label="It's fine", style="outline"),
    DecisionOption(key="snooze", label="Ask me tomorrow", style="text"),
]
SETTLEMENT_OPTIONS = [
    DecisionOption(key="review_and_attest", label="Review and attest", style="primary"),
    DecisionOption(key="skip_claim", label="Skip this settlement", style="outline"),
    DecisionOption(key="snooze", label="Ask me later", style="text"),
]


def _local_hhmm(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%H:%M")
    except ValueError:
        return iso[11:16]


def _local_date(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().date().isoformat()
    except ValueError:
        return iso[:10]


def _short_hazard(text: str, n: int = 110) -> str:
    t = " ".join((text or "").split())
    return t if len(t) <= n else t[: n - 1].rsplit(" ", 1)[0] + "…"


class Guardian:
    def __init__(self, store: Store, run_store: RunStore, control: RunControl, bridge: str | None = None, log: Callable[[str], None] | None = None):
        self.store, self.run_store, self.control, self.bridge = store, run_store, control, bridge
        self.log = log or (lambda m: None)
        self.notifier = Notifier(store)
        self.listeners: list[Callable[[dict[str, Any]], None]] = []
        self._prev_emit = control.emit
        control.emit = self.on_event
        self._lock = threading.RLock()
        # Deployed mode: model work runs on AgentCore Runtime; this process keeps a synced copy of the state for reads.
        self.remote: AgentRuntime | None = AgentRuntime.from_env()
        self._remote_busy = 0
        self._sync_targets = sync_targets_from_env(store.root, run_store.root)
        # GUARDIAN_STATE_SYNC=1 on a server whose disk may be replaced (EC2 redeploys, containers): this process owns the
        # state, pulls the bucket copy once at start and pushes after every change (best effort: a failed push is logged).
        # Remote (AgentCore) mode also pulls at start; there the runtime owns the state and pushes after each invocation.
        self._state_sync = bool(self._sync_targets) and self.remote is None and os.environ.get("GUARDIAN_STATE_SYNC", "").strip().lower() in ("1", "true", "yes")
        if self._sync_targets and (self.remote is not None or self._state_sync):
            try:
                pull_all(self._sync_targets)
            except Exception as e:  # noqa: BLE001
                self.log(f"initial state pull failed: {e}")

    def persist(self) -> None:
        """Push the local state to the bucket (GUARDIAN_STATE_SYNC=1 with a bucket configured); a no-op otherwise."""
        if not self._state_sync:
            return
        try:
            from .state_sync import push_all

            push_all(self._sync_targets)
        except Exception as e:  # noqa: BLE001
            self.log(f"state push failed: {e}")

    # ------------------------------------------------------------------ construction
    @classmethod
    def build(cls, data_dir: str | None = None, runs_dir: str | None = None, bridge: str | None = None, quiet: bool = True, with_gren_app: bool = True, schedule: bool = False):
        """Create the store, the gren run store and control. Returns (guardian, gren_fastapi_app_or_None).
        `schedule=True` (only `guardian serve` sets this) starts the background scheduler (nightly sweep, Gmail
        sync); every other caller, including the test suite, gets a Guardian that only acts when asked."""
        store = Store(data_dir)
        runs_root = os.path.abspath(runs_dir or os.environ.get("GUARDIAN_RUNS") or os.path.join("var", "runs"))
        run_store = RunStore(runs_root)
        # The graph's code nodes resolve the store from the environment (they are plain modules loaded by gren), so the
        # service publishes the paths it was built with; `--data` and `--runs` then apply to the whole run, not just the API.
        os.environ["GUARDIAN_DATA"] = store.root
        os.environ["GUARDIAN_RUNS"] = runs_root
        registry = ModelRegistry(runs_root=runs_root)
        log = (lambda m: None) if quiet else (lambda m: print(f"[guardian] {m}", flush=True))
        gren_app = None
        if with_gren_app:
            from gren.server.app import create_app

            gren_app = create_app(run_store, GRAPHS_DIR, registry, token=None, quiet=True)
            control = gren_app.state.control
        else:
            control = RunControl(run_store, GRAPHS_DIR, registry, log=log)
        g = cls(store, run_store, control, bridge=bridge, log=log)
        if not store.household().created_at or not os.path.exists(os.path.join(store.root, "household.json")):
            store.save_household(store.household())
        if schedule:
            g._start_scheduler()
        return g, gren_app

    # ------------------------------------------------------------------ spend guard
    def spend_today(self) -> float:
        """Model spend recorded by every run created today (local date), from the gren run store."""
        today = date.today().isoformat()
        total = 0.0
        for r in self.run_store.list():
            if _local_date(str(r.get("created_at") or "")) == today:
                total += float(r.get("cost_usd") or 0)
        return round(total, 4)

    def daily_budget(self) -> float | None:
        raw = os.environ.get("GUARDIAN_DAILY_BUDGET_USD", "").strip()
        try:
            return float(raw) if raw else None
        except ValueError:
            return None

    def check_budget(self, reserve: float = 0.0) -> None:
        """Refuse to start model work once today's recorded spend reaches GUARDIAN_DAILY_BUDGET_USD. This is the
        household's own hard stop: AWS Budgets alert but do not cap, and gren's per-run cap only bounds one run."""
        cap = self.daily_budget()
        if cap is None:
            return
        spent = self.spend_today()
        if spent + reserve > cap:
            raise ValueError(f"daily model budget reached: ${spent:.2f} of ${cap:.2f} spent today (GUARDIAN_DAILY_BUDGET_USD); no new runs until tomorrow")

    # ------------------------------------------------------------------ deployed runtime
    def remote_call(self, payload: dict[str, Any], wait: bool = False) -> dict[str, Any] | None:
        """Send one unit of work to the AgentCore runtime, then refresh the local state from S3. In a thread unless
        `wait` is set. Returns the runtime's response when waiting."""
        assert self.remote is not None
        result: dict[str, Any] = {}

        def go() -> None:
            self._remote_busy += 1
            self._emit_local("remote.started", {"kind": payload.get("kind")})
            try:
                result.update(self.remote.invoke(payload))  # type: ignore[union-attr]
                if result.get("error"):
                    self.store.log(Activity(source="Guardian", text=f"AgentCore runtime {payload.get('kind')} failed", result=str(result["error"])[:200], tone="critical"))
            except Exception as e:  # noqa: BLE001
                result["error"] = f"{e.__class__.__name__}: {e}"
                self.store.log(Activity(source="Guardian", text=f"AgentCore runtime {payload.get('kind')} could not be invoked", result=str(e)[:200], tone="critical"))
            finally:
                try:
                    if self._sync_targets:
                        pull_all(self._sync_targets)
                except Exception as e:  # noqa: BLE001
                    self.log(f"state pull failed: {e}")
                self._remote_busy -= 1
                self._emit_local("remote.finished", {"kind": payload.get("kind"), "error": result.get("error")})
                if payload.get("kind") == "sweep":
                    self._emit_local("sweep.finished", {"run_id": result.get("run_id"), "status": result.get("status")})
                elif payload.get("kind") == "answer":
                    self._emit_local("decision.answered", {"decision_id": payload.get("decision_id")})

        if wait:
            go()
            return result
        threading.Thread(target=go, name=f"guardian-remote-{payload.get('kind')}", daemon=True).start()
        return None

    # ------------------------------------------------------------------ runs
    def start_sweep(self, window_days: int = 45, full_scan: bool = False, auto_approve: bool = False, trigger: str = "dashboard") -> str:
        self.check_budget()
        if self.remote is not None:
            session = AgentRuntime.session_id("sweep")
            self.remote_call({"kind": "sweep", "window_days": window_days, "full_scan": full_scan, "trigger": trigger})
            return f"remote:{session}"
        rid = self.control.start(spec_path=SWEEP_GRAPH, input_={"window_days": window_days, "full_scan": full_scan, "trigger": trigger}, bridge=self.bridge, auto_approve=auto_approve, labels={"kind": "sweep", "trigger": trigger})
        self.store.upsert_sweep(SweepRecord(run_id=rid, started_at=now_iso(), status="running", bridge=self.bridge or default_bridge().name))
        return rid

    def wait(self, run_id: str, timeout_s: float = 600, poll_s: float = 0.25) -> dict[str, Any]:
        """Block until the run finishes or pauses at a gate (an in-process run keeps its thread while it waits)."""
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            run = self.run_store.load(run_id).run
            if run["status"] == "paused" or not self.control.is_running(run_id):
                return run
            time.sleep(poll_s)
        return self.run_store.load(run_id).run

    def intake(self, text: str, source: str = "paste", timeout_s: float = 240) -> dict[str, Any]:
        t0 = time.time()
        if self.remote is not None:
            try:
                self.check_budget()
            except ValueError as e:
                return {"run_id": None, "item": None, "fields_confident": 0, "fields_total": 0, "cost_usd": 0.0, "duration_ms": 0, "error": str(e)}
            res = self.remote_call({"kind": "intake", "text": text, "source": source, "timeout_s": timeout_s}, wait=True) or {}
            item_id = ((res.get("item") or {}).get("id")) if isinstance(res.get("item"), dict) else None
            it = self.store.item(item_id) if item_id else None
            return {"run_id": res.get("run_id"), "item": self.item_view(it) if it else res.get("item"), "fields_confident": int(res.get("fields_confident") or 0), "fields_total": int(res.get("fields_total") or 0),
                    "cost_usd": float(res.get("cost_usd") or 0), "duration_ms": int((time.time() - t0) * 1000), "error": res.get("error")}
        try:
            self.check_budget()
            rid = self.control.start(spec_path=INTAKE_GRAPH, input_={"text": text, "source": source}, bridge=self.bridge, labels={"kind": "intake"})
        except Exception as e:  # noqa: BLE001
            return {"run_id": None, "item": None, "fields_confident": 0, "fields_total": 0, "cost_usd": 0.0, "duration_ms": int((time.time() - t0) * 1000), "error": str(e)}
        run = self.wait(rid, timeout_s)
        out = run.get("output") or {}
        item = None
        if run.get("status") == "completed" and out.get("item_ids"):
            it = self.store.item(out["item_ids"][0])
            item = self.item_view(it) if it else None
        return {"run_id": rid, "item": item, "fields_confident": int(out.get("fields_confident") or 0), "fields_total": int(out.get("fields_total") or 0),
                "cost_usd": float(run.get("totals", {}).get("cost_usd") or 0), "duration_ms": int((time.time() - t0) * 1000), "error": run.get("error") if run.get("status") != "completed" else None}

    # ------------------------------------------------------------------ engine events -> decisions and activity
    def on_event(self, e: dict[str, Any]) -> None:
        try:
            self._prev_emit(e)
        except Exception:  # noqa: BLE001
            pass
        try:
            self._handle(e)
        except Exception as ex:  # noqa: BLE001
            self.log(f"event handler error on {e.get('type')}: {ex}")
        for fn in list(self.listeners):
            try:
                fn(e)
            except Exception:  # noqa: BLE001
                pass

    def _emit_local(self, type_: str, data: dict[str, Any] | None = None) -> None:
        evt = {"type": type_, "at": now_iso(), "data": data or {}}
        for fn in list(self.listeners):
            try:
                fn(evt)
            except Exception:  # noqa: BLE001
                pass

    def _run_kind(self, run_id: str) -> tuple[str, dict[str, Any]]:
        try:
            st = self.run_store.load(run_id.split("/nested/")[0])
        except FileNotFoundError:
            return "", {}
        return str((st.run.get("labels") or {}).get("kind") or st.run.get("graph") or ""), st.run

    def _node(self, run_id: str, node_id: str) -> dict[str, Any]:
        try:
            return self.run_store.load(run_id).nodes.get(node_id) or {}
        except FileNotFoundError:
            return {}

    def _handle(self, e: dict[str, Any]) -> None:
        t, rid, node = str(e.get("type")), str(e.get("run_id") or ""), e.get("node")
        if not rid:
            return
        kind, run = self._run_kind(rid)
        data = e.get("data") or {}
        if kind not in ("sweep", "nightly-sweep", "intake"):
            return
        if t == "run.started" and kind != "intake":
            if not run.get("forked_from"):
                existing = {s.run_id: s for s in self.store.sweeps()}.get(rid)
                if existing is None:
                    self.store.upsert_sweep(SweepRecord(run_id=rid, started_at=now_iso(), status="running", bridge=str(run.get("bridge") or "")))
                else:
                    self._sweep_update(rid, status="running")  # a resumed run emits run.started again; keep its first start
            self._emit_local("sweep.started", {"run_id": rid, "forked_from": run.get("forked_from")})
        elif t == "node.completed" and node:
            self._log_node(rid, str(node))
        elif t == "verify.kill" and node == "severity_check":
            reasons = data.get("reasons") or []
            self.store.log(Activity(source="Verifier", text="severity_check killed the triage plan; one repair round", result=str(reasons[0])[:160] if reasons else "no reason given", tone="warn", run_id=rid))
        elif t == "gate.waiting" and node == "household_decision":
            self._surface(rid, data)
        elif t in ("gate.approved", "gate.rejected") and node == "household_decision":
            self.store.log(Activity(source="Household", text=f"Household answered ({'approved' if t.endswith('approved') else 'declined'}) via {data.get('by') or 'dashboard'}", result="graph resumed", tone="ok", run_id=rid))
        elif t == "run.paused":
            if not run.get("forked_from"):
                self._sweep_update(rid, status="paused")
            self._emit_local("sweep.paused", {"run_id": rid})
            self.persist()
        elif t in ("run.completed", "run.failed", "run.cancelled"):
            status = t.split(".")[1]
            if kind == "intake":
                if status != "completed":
                    self.store.log(Activity(source="Intake", text="Intake failed", result=str(data.get("error") or "")[:200], tone="critical", run_id=rid))
                return
            self._finish_sweep(rid, status, run, data)

    def _log_node(self, rid: str, node: str) -> None:
        rec = self._node(rid, node)
        out = rec.get("output") if isinstance(rec.get("output"), dict) else {}
        outs = rec.get("outputs") or []
        S = self.store
        if node == "feeds_refresh":
            live = out.get("mode") == "live"
            win = out.get("window") or {}
            S.log(Activity(source="CPSC", text=f"Pulled {out.get('cpsc', 0)} CPSC recalls for {win.get('from', '')[:10]} to {win.get('to', '')[:10]}" + (" (first sweep: full look-back)" if win.get("first_sweep") else ""), result=("live feed" if live else "recorded fixtures"), tone="ok", run_id=rid))
            S.log(Activity(source="NHTSA", text=f"Checked {out.get('vehicles', 0)} vehicle(s) against NHTSA campaigns", result=f"{out.get('nhtsa', 0)} campaigns", tone="ok", run_id=rid))
            S.log(Activity(source="FDA", text=f"Pulled {out.get('fda', 0)} openFDA food enforcement reports", result=f"{out.get('upserted', 0)} new records across all feeds", tone="ok", run_id=rid))
            for err in out.get("errors") or []:
                S.log(Activity(source="Guardian", text="Feed error", result=str(err)[:200], tone="warn", run_id=rid))
        elif node == "candidate_gen":
            c, k, d = int(out.get("certain_count") or 0), int(out.get("candidate_count") or 0), int(out.get("dropped") or 0)
            S.log(Activity(source="Matcher", text=f"Checked {out.get('items_watched', 0)} items against {out.get('recalls_checked', 0)} recalls ({out.get('checked_pairs', 0)} pairs)", result=f"{c} certain · {k} candidate(s) for adjudication · {d} dropped by date window", tone="critical" if c else ("warn" if k else "ok"), run_id=rid))
        elif node == "matcher":
            yes = sum(1 for o in outs if isinstance(o, dict) and o.get("is_match") == "yes")
            no = sum(1 for o in outs if isinstance(o, dict) and o.get("is_match") == "no")
            un = len(outs) - yes - no
            S.log(Activity(source="Matcher", text=f"Adjudicated {len(outs)} ambiguous pair(s) with the model", result=f"{yes} yes · {no} no · {un} unsure · ${float(rec.get('cost_usd') or 0):.3f}", tone="critical" if yes else "muted", run_id=rid))
        elif node == "warranty":
            S.log(Activity(source="Warranty", text=f"Drafted {len(outs)} warranty check-in question(s) for items ending within 30 days above threshold", result="triage decides tonight or queues within budget", tone="muted", run_id=rid))
        elif node == "triage":
            ch = out.get("channel")
            n, dg, q = len(out.get("decisions") or []), int(out.get("digest_count") or 0), len(out.get("queued") or [])
            S.log(Activity(source="Triage", text=f"Triage chose channel {ch}: {n} decision(s), {dg} digest line(s), {q} question(s) queued", result=(out.get("rationale") or "")[:180], tone="critical" if ch == "sms_now" else "muted", run_id=rid))
        elif node == "severity_check":
            v = rec.get("verify") or {}
            S.log(Activity(source="Verifier", text="severity_check verified the plan against the keyword pass", result=("passed" if not v.get("killed") else f"{len(v.get('killed'))} killed") + f" · repair rounds {v.get('repair_round', 0)}", tone="ok" if not v.get("killed") else "warn", run_id=rid))
        elif node == "digest":
            S.log(Activity(source="Triage", text=f"Added {out.get('appended', 0)} standard-hazard item(s) to the weekly digest", result="no interruption", tone="muted", run_id=rid))
        elif node == "remedy":
            S.log(Activity(source="Remedy", text=f"Drafted {len(outs)} remedy request(s) after approval", result=f"${float(rec.get('cost_usd') or 0):.3f}", tone="ok", run_id=rid))
        elif node == "followup":
            for dec_id in {str(em.get("decision_id")) for em in out.get("emails") or [] if em.get("decision_id")}:
                self._emit_local("decision.answered", {"decision_id": dec_id})
        elif node == "save_item":
            pass  # the reducer logs the intake row with the item id

    def _sweep_update(self, rid: str, **fields: Any) -> None:
        recs = {s.run_id: s for s in self.store.sweeps()}
        s = recs.get(rid) or SweepRecord(run_id=rid, started_at=now_iso())
        for k, v in fields.items():
            setattr(s, k, v)
        self.store.upsert_sweep(s)

    def _finish_sweep(self, rid: str, status: str, run: dict[str, Any], data: dict[str, Any]) -> None:
        out = run.get("output") or {}
        feeds, matching = out.get("feeds") or {}, out.get("matching") or {}
        channel = out.get("channel")
        n_dec = len(out.get("decisions") or [])
        if run.get("forked_from"):
            sent = int(((out.get("actions") or {}).get("sent")) or 0) if isinstance(out.get("actions"), dict) else 0
            self.store.log(Activity(source="Guardian", text="Late-approval run complete", result=(f"{sent} request(s) sent" if status == "completed" else f"{status}: {str(data.get('error') or run.get('error') or '')[:120]}") + f" · ${float(run.get('totals', {}).get('cost_usd') or 0):.3f}", tone="ok" if status == "completed" else "critical", run_id=rid))
            self._emit_local("sweep.finished", {"run_id": rid, "status": status, "forked_from": run.get("forked_from")})
            return
        if status == "completed":
            summary = "Quiet" if channel in (None, "none") else (f"{n_dec} decision(s) surfaced" if channel == "sms_now" else "digest only")
            self.store.log(Activity(source="Guardian", text="Sweep complete", result=("Nothing to report" if channel in (None, "none") else summary) + f" · ${float(run.get('totals', {}).get('cost_usd') or 0):.3f}", tone="ok", run_id=rid))
        else:
            summary = f"{status}: {str(data.get('error') or run.get('error') or '')[:120]}"
            self.store.log(Activity(source="Guardian", text=f"Sweep {status}", result=str(data.get("error") or run.get("error") or "")[:200], tone="critical", run_id=rid))
        self._sweep_update(rid, status=status, ended_at=now_iso(), summary=summary, cost_usd=float(run.get("totals", {}).get("cost_usd") or 0), recalls_pulled=int(feeds.get("upserted") or 0),
                           certain=int(matching.get("certain") or 0), candidates=int(matching.get("candidates") or 0), surfaced=n_dec)
        self._emit_local("sweep.finished", {"run_id": rid, "status": status})
        self.persist()

    # ------------------------------------------------------------------ decisions
    def _surface(self, rid: str, data: dict[str, Any]) -> None:
        show = data.get("show") or {}
        decisions = show.get("decisions") or []
        if not decisions:
            return
        prefs = self.store.prefs()
        existing = [d for d in self.store.decisions() if d.run_id == rid and d.gate == "household_decision"]
        if existing:
            return  # already surfaced (resume after a restart)
        created: list[Decision] = []
        expires = (datetime.now(timezone.utc) + timedelta(hours=DECISION_TTL_H)).strftime("%Y-%m-%dT%H:%M:%SZ")
        for i, sd in enumerate(decisions):
            item = self.store.item(str(sd.get("item_id") or "")) if sd.get("item_id") else None
            recall = self.store.recall(str(sd.get("recall_id") or "")) if sd.get("recall_id") else None
            kind = "recall_remedy" if sd.get("kind") != "warranty_checkin" else "warranty_checkin"
            options = [o.model_copy() for o in (RECALL_OPTIONS if kind == "recall_remedy" else WARRANTY_OPTIONS)]
            if kind == "recall_remedy" and sd.get("remedy_label"):
                options[0].label = str(sd["remedy_label"])
            summary = ""
            if recall is not None:
                summary = f"Remedy: {_short_hazard(recall.remedy_text, 150)} Guardian has drafted the request" + (f" and attached your {item.retailer} receipt." if item and item.retailer else ".")
            elif kind == "warranty_checkin" and item:
                summary = "If something is wrong, reply with a sentence and Guardian drafts the claim."
            d = Decision(kind=kind, severity=sd.get("severity") if sd.get("severity") in ("critical", "standard") else "standard", run_id=rid, gate="household_decision", plan_index=i, expires_at=expires,
                         item_id=item.id if item else None, item_name=(f"{item.brand} {item.name}".strip() if item else str(sd.get("item_id") or "")), match_id=sd.get("match_id"), recall_id=sd.get("recall_id"),
                         headline=str(sd.get("headline") or ""), summary=summary, message=str(sd.get("message") or ""), remedy_label=str(sd.get("remedy_label") or ""), options=options)
            d.notified = self.notifier.sms(prefs.phone or None, d.message, ref={"decision_id": d.id, "run_id": rid})
            self.store.upsert_decision(d)
            if d.match_id:
                m = self.store.match(d.match_id)
                if m is not None:
                    m.state = "surfaced"
                    self.store.upsert_match(m)
            created.append(d)
            self._emit_local("decision.created", {"decision_id": d.id, "severity": d.severity})
        self.store.log(Activity(source="Triage", text=f"Drafted {len(created)} decision(s), sent SMS to {mask_phone(prefs.phone)}, paused the graph for the household", result="Waiting on you" if created else "", tone="critical", run_id=rid, decision_id=created[0].id if created else None))
        self._sweep_update(rid, surfaced=len(created))

    def answer(self, decision_id: str, choice: str, by: str = "dashboard", comment: str | None = None) -> dict[str, Any]:
        with self._lock:
            d = self.store.decision(decision_id)
            if d is None:
                raise KeyError(decision_id)
            if d.state == "answered":
                return {"ok": True, "decision": self.decision_view(d), "run_id": d.run_id, "note": "already answered"}
            valid = {o.key for o in d.options}
            if choice not in valid:
                raise ValueError(f"choice must be one of {sorted(valid)}")
            item = self.store.item(d.item_id) if d.item_id else None
            at = now_iso()
            d.answer = {"choice": choice, "by": by, "at": at, "comment": comment}
            if choice == "snooze":
                tomorrow = (datetime.now().astimezone() + timedelta(days=1)).replace(hour=8, minute=0, second=0, microsecond=0)
                d.state, d.snooze_until = "snoozed", tomorrow.isoformat()
                d.outcome = {"title": "Snoozed until tomorrow", "subtitle": "Logged. Nothing else to do.", "steps": [{"text": "You answered: ask me tomorrow", "when": "Just now", "done": True}, {"text": "Guardian will resurface this at 08:00 tomorrow", "when": tomorrow.strftime("%b %d"), "done": False}]}
                self.store.log(Activity(source="Household", text=f"Snoozed: {d.headline or d.item_name}", result="resurfaces tomorrow 08:00", tone="muted", run_id=d.run_id, item_id=d.item_id, decision_id=d.id))
            elif choice in ("no_longer_own", "not_mine", "fine", "done", "skip_claim"):
                d.state = "answered"
                what = {"no_longer_own": "no longer own it", "not_mine": "not mine", "fine": "it's fine", "done": "done", "skip_claim": "skip this settlement"}[choice]
                d.outcome = {"title": "Match closed" if d.kind == "recall_remedy" else ("Settlement skipped" if choice == "skip_claim" else "Noted"), "subtitle": "Logged. Nothing else to do.", "steps": [{"text": f"You answered: {what}", "when": "Just now", "done": True}, {"text": "Match closed and logged; item status updated" if d.kind == "recall_remedy" else "No claim drafted", "when": "Just now", "done": True}]}
                if d.match_id:
                    m = self.store.match(d.match_id)
                    if m is not None:
                        m.state = "closed"
                        if choice == "not_mine":
                            m.verdict, m.rationale = "no", (m.rationale + " Household answered: not mine.").strip()
                        self.store.upsert_match(m)
                if item is not None and choice == "no_longer_own":
                    item.status = "disposed"
                    self.store.upsert_item(item)
                self.store.log(Activity(source="Household", text=f"Answered '{what}' for {d.item_name}", result="match closed" if d.kind == "recall_remedy" else "no claim", tone="ok", run_id=d.run_id, item_id=d.item_id, decision_id=d.id))
            elif choice == "review_and_attest":
                d.state = "answered"
                d.outcome = {"title": "Claim drafting started", "subtitle": "Guardian prefills the claim form; you review and attest before anything is submitted.", "steps": [{"text": "You approved: review and attest", "when": "Just now", "done": True}, {"text": "Claim form assembly is the next milestone (see read_this_labubu.md)", "when": "Now", "done": False}]}
                self.store.log(Activity(source="Household", text=f"Approved 'review and attest' for {d.item_name}", result="claim assembly is the next milestone", tone="ok", run_id=d.run_id, item_id=d.item_id, decision_id=d.id))
            else:  # request_remedy / report_problem
                d.state = "answered"
                d.outcome = {"title": "Approved", "subtitle": "Guardian is drafting and sending the request.", "steps": [{"text": f"You approved: {d.remedy_label.lower() or choice.replace('_', ' ')}", "when": "Just now", "done": True}, {"text": "Remedy request being drafted", "when": "Now", "done": False}]}
                self.store.log(Activity(source="Household", text=f"Approved '{d.remedy_label or choice}' for {d.item_name}", result="remedy agent runs next", tone="ok", run_id=d.run_id, item_id=d.item_id, decision_id=d.id))
            self.store.upsert_decision(d)
            self._emit_local("decision.answered", {"decision_id": d.id, "choice": choice})
            if self.remote is not None:
                # the runtime applies the same answer to its copy of the state, releases or forks the gate there, and the
                # result comes back with the next S3 pull; the local record above gives the dashboard an instant response
                self.remote_call({"kind": "answer", "decision_id": d.id, "choice": choice, "by": by, "comment": comment})
                return {"ok": True, "decision": self.decision_view(self.store.decision(d.id) or d), "run_id": d.run_id, "resumed": None, "remote": True}
            resumed = self._maybe_release_gate(d)
            self.persist()
            return {"ok": True, "decision": self.decision_view(self.store.decision(d.id) or d), "run_id": d.run_id, "resumed": resumed}

    def _maybe_release_gate(self, d: Decision) -> bool:
        """An approval releases the gate at once: the remedy for what the household said yes to should not wait for
        the answers to the other decisions of the night. The approval carries every answered-but-not-yet-actioned
        decision; snoozed ones come back tomorrow, still-pending ones stay on the card. A later approval, after the run
        has moved on, forks the run from the gate (same triage plan, only remedy and followup re-execute). Declines
        alone release the gate as rejected only once nothing is pending, since there is nothing to send."""
        if not d.run_id or not d.gate:
            return False
        siblings = sorted([x for x in self.store.decisions() if x.run_id == d.run_id and x.gate == d.gate], key=lambda x: x.plan_index)
        actionable = [x for x in siblings if x.state == "answered" and not x.action]
        if not actionable:
            return False
        answers = [{"index": x.plan_index, "decision_id": x.id, "choice": (x.answer or {}).get("choice"), "by": (x.answer or {}).get("by")} for x in actionable]
        approved = any(a["choice"] in ("request_remedy", "report_problem") for a in answers)
        if not approved and any(x.state == "pending" for x in siblings):
            return False
        comment = json.dumps({"answers": answers})
        by = (d.answer or {}).get("by") or "household"
        try:
            st = self.run_store.load(d.run_id)
        except FileNotFoundError:
            return False
        gate_waiting = st.run["status"] == "paused" and (st.nodes.get(d.gate) or {}).get("status") == "waiting_approval"
        if not gate_waiting:
            if not approved:
                return False  # declines were applied when they were answered; nothing to send
            return self._late_approval(d, siblings, comment, by)
        self.control.approve(d.run_id, d.gate, "approved" if approved else "rejected", by=by, comment=comment)
        if not self.control.is_running(d.run_id):
            self.control.resume(d.run_id, bridge=self.bridge)
        return True

    def _late_approval(self, d: Decision, siblings: list[Decision], comment: str, by: str) -> bool:
        """The run already finished without this decision (the household snoozed it, or answered after a restart).
        Fork the run from the gate: the triage plan and every upstream output are reused, only the gate, answers,
        remedy and followup re-execute, for the decisions in the approval comment."""
        old = d.run_id or ""
        t0 = time.time()
        while self.control.is_running(old) and time.time() - t0 < 300:
            time.sleep(0.5)  # the original run is still sending an earlier approval; fork from a settled run
        new_rid = f"{old}-late-{datetime.now(timezone.utc).strftime('%H%M%S')}"
        for x in siblings:
            if not x.action:
                x.run_id = new_rid
                self.store.upsert_decision(x)
        try:
            self.control.fork(old, [d.gate or "household_decision"], bridge=self.bridge, new_run_id=new_rid)
        except Exception as e:  # noqa: BLE001
            self.log(f"fork for late approval failed: {e}")
            for x in siblings:
                if x.run_id == new_rid:
                    x.run_id = old
                    self.store.upsert_decision(x)
            return False
        self.store.log(Activity(source="Guardian", text=f"Late approval: forked the sweep from the household gate so the remedy runs for {d.item_name}", result=new_rid, tone="muted", run_id=new_rid, decision_id=d.id))
        t0 = time.time()
        while time.time() - t0 < 60:
            st = self.run_store.load(new_rid)
            if st.run["status"] == "paused" and (st.nodes.get(d.gate or "") or {}).get("status") == "waiting_approval":
                break
            if st.run["status"] in ("completed", "failed", "cancelled"):
                self.log(f"fork {new_rid} ended with {st.run['status']} before reaching the gate")
                return False
            time.sleep(0.2)
        self.control.approve(new_rid, d.gate or "household_decision", "approved", by=by, comment=comment)
        if not self.control.is_running(new_rid):
            self.control.resume(new_rid, bridge=self.bridge)
        return True

    def resurface_snoozed(self) -> int:
        n = 0
        now = datetime.now().astimezone().isoformat()
        for d in self.store.decisions():
            if d.state == "snoozed" and d.snooze_until and d.snooze_until <= now:
                d.state, d.snooze_until, d.answer, d.outcome = "pending", None, None, None
                self.store.upsert_decision(d)
                n += 1
        return n

    def report_problem(self, item_id: str, text: str) -> dict[str, Any]:
        item = self.store.item(item_id)
        if item is None:
            raise KeyError(item_id)
        wv = warranty_policy.view(item)
        self.store.log(Activity(source="Warranty", text=f"Problem reported for {item.brand} {item.name}: {text[:140]}", result=f"coverage {wv['label']}", tone="warn", item_id=item.id))
        covered = wv["ends_on"] is not None and wv["ends_on"] >= date.today().isoformat()
        msg = (f"Logged. The warranty is still active ({wv['label']}); claim drafting is the next milestone (see read_this_labubu.md)." if covered
               else f"Logged. The warranty on file ended ({wv['label']}); Guardian will check card and retailer coverage in the next milestone.")
        return {"ok": True, "decision": None, "message": msg, "covered": covered}

    # ------------------------------------------------------------------ views
    def item_view(self, it: InventoryItem) -> dict[str, Any]:
        matches = self.store.matches_for_item(it.id)
        state, label, rationale = "unchecked", "Not yet swept", "This item has not been through a nightly sweep yet."
        live = [m for m in matches if m.verdict in ("certain", "yes") and m.state in ("open", "surfaced")]
        resolved = [m for m in matches if m.verdict in ("certain", "yes") and m.state == "closed"]
        nos = [m for m in matches if m.verdict == "no"]
        unsure = [m for m in matches if m.verdict == "unsure" and m.state != "closed"]
        digested = [m for m in resolved if m.severity == "standard"]
        if live:
            m = max(live, key=lambda x: (x.severity == "critical", x.score))
            state = "critical_match" if m.severity == "critical" else "standard_match"
            label = "Critical match" if m.severity == "critical" else "Standard match"
            rationale = m.rationale
        elif unsure:
            state, label, rationale = "candidate", "Probable · one fact missing", unsure[0].rationale
        elif resolved:
            answered = [d for d in self.store.decisions() if d.item_id == it.id and d.state == "answered"]
            if any((d.answer or {}).get("choice") == "request_remedy" for d in answered):
                state, label, rationale = "resolved", "Resolved", f"Remedy requested for {resolved[0].recall_id.replace('#', ' ')}. Follow-up scheduled."
            elif digested and it.vehicle:
                state, label, rationale = "clear", f"Clear · {len(digested)} campaign(s) checked", f"{len(digested)} NHTSA campaign(s) exist for this vehicle class; logged in the digest. A VIN lookup at nhtsa.gov confirms whether this vehicle is included."
            else:
                state, label, rationale = "resolved", "Logged in digest", resolved[0].rationale
        elif nos:
            state, label, rationale = "adjudicated_no", "Adjudicated no", nos[-1].rationale + (f" Confidence {nos[-1].confidence:.2f}." if nos[-1].confidence is not None else "")
        elif it.sweeps > 0:
            dropped = [m for m in matches if m.verdict == "dropped"]
            state, label = "clear", "Clear"
            rationale = f"{len(dropped)} lexical candidate(s) dropped by the date-window filter before any model call." if dropped else f"No candidates in {it.sweeps} sweep(s)."
        sources = ["NHTSA"] if it.category == "Vehicle" else (["openFDA"] if it.category == "Food" else ["CPSC"])
        w = warranty_policy.view(it)
        photo_url = f"/api/items/{it.id}/photo" if it.photo_filename else None
        return {**it.model_dump(exclude={"receipt_text", "notes", "photo_filename", "photo_content_type"}), "warranty": w, "photo_url": photo_url,
                "recall": {"state": state, "label": label, "rationale": rationale, "sources": sources, "sweeps": it.sweeps}}

    def match_view(self, m: MatchCandidate) -> dict[str, Any]:
        r = self.store.recall(m.recall_id)
        return {**m.model_dump(), "recall": self.recall_view(r) if r else None}

    def recall_view(self, r: RecallRecord) -> dict[str, Any]:
        f, t = r.sold_window()
        return {"recall_id": r.recall_id, "native_id": r.native_id, "source": r.source, "source_label": r.source_label, "title": r.title, "published_at": r.published_at, "url": r.url, "hazard_text": r.hazard_text,
                "remedy_text": r.remedy_text, "severity": r.severity, "contact": {"phone": r.contact.phone, "email": r.contact.email, "url": r.contact.url}, "sold_window": {"from": f, "to": t} if (f or t) else None,
                "retailers": [x for p in r.products for x in p.retailers][:3]}

    def item_detail(self, item_id: str) -> dict[str, Any] | None:
        it = self.store.item(item_id)
        if it is None:
            return None
        v = self.item_view(it)
        v["matches"] = [self.match_view(m) for m in sorted(self.store.matches_for_item(it.id), key=lambda m: m.updated_at, reverse=True)]
        v["activity"] = [self.activity_row(a) for a in self.store.activity() if a.item_id == it.id][-20:]
        v["receipt_text"] = it.receipt_text
        v["notes"] = it.notes
        return v

    def items_page(self, q: str = "", category: str = "", warranty: str = "", recall: str = "", page: int = 1, page_size: int = 25) -> dict[str, Any]:
        today = date.today().isoformat()
        soon = (date.today() + timedelta(days=60)).isoformat()
        rows = [self.item_view(it) for it in self.store.items(include_disposed=True)]
        ql = q.lower().strip()
        if ql:
            rows = [r for r in rows if ql in f"{r['brand']} {r['name']} {r.get('model_number') or ''} {r.get('upc') or ''} {r.get('retailer') or ''}".lower()]
        if category:
            rows = [r for r in rows if r["category"] == category]
        if warranty:
            def wf(r: dict[str, Any]) -> bool:
                e = r["warranty"]["ends_on"]
                return {"active": e is not None and e >= today, "ending": e is not None and today <= e <= soon, "expired": e is not None and e < today, "none": e is None}.get(warranty, True)
            rows = [r for r in rows if wf(r)]
        if recall:
            groups = {"clear": {"clear", "unchecked"}, "match": {"critical_match", "standard_match", "candidate"}, "adjudicated_no": {"adjudicated_no"}, "resolved": {"resolved"}}
            rows = [r for r in rows if r["recall"]["state"] in groups.get(recall, set())]
        order = {"critical_match": 0, "standard_match": 1, "candidate": 2, "resolved": 3, "adjudicated_no": 4, "clear": 5, "unchecked": 6}
        rows.sort(key=lambda r: (order.get(r["recall"]["state"], 9), r["purchase_date"]), reverse=False)
        total = len(rows)
        start = max(0, (page - 1) * page_size)
        return {"items": rows[start : start + page_size], "total": total, "page": page, "page_size": page_size}

    def decision_view(self, d: Decision) -> dict[str, Any]:
        it = self.store.item(d.item_id) if d.item_id else None
        r = self.store.recall(d.recall_id) if d.recall_id else None
        m = self.store.match(d.match_id) if d.match_id else None
        facts: list[dict[str, str]] = []
        if it:
            facts.append({"label": "Purchased", "value": f"{it.purchase_date}" + (f", {it.retailer}" if it.retailer else "")})
            facts.append({"label": "Model", "value": " · ".join(x for x in [it.model_number, (f"UPC {it.upc}" if it.upc else None)] if x) or "not on receipt"})
        if m:
            conf = "Certain (stage 1, exact key)" if m.verdict == "certain" else (f"{(m.confidence or 0):.0%} (stage 4, adjudicated)" if m.confidence is not None else f"stage {m.stage}")
            facts.append({"label": "Match confidence", "value": conf})
        if r:
            f, t = r.sold_window()
            facts.append({"label": "Sold window", "value": f"{f or '?'} to {t or '?'}" if (f or t) else "not stated"})
        facts.extend(d.extra_facts)
        created_local = _local_hhmm(d.created_at)
        try:
            hours_left = max(0, int((datetime.fromisoformat((d.expires_at or d.created_at).replace("Z", "+00:00")) - datetime.now(timezone.utc)).total_seconds() // 3600))
        except ValueError:
            hours_left = 0
        src = f"{r.source_label} recall {r.native_id}" if r else {"warranty_checkin": "Warranty window", "settlement_claim": "Class action settlement", "advisory": "Advisory"}.get(d.kind, "Advisory")
        meta = f"{src} · surfaced {created_local} {'today' if _local_date(d.created_at) == date.today().isoformat() else _local_date(d.created_at)}" + (f" · expires in {hours_left} h" if d.state == "pending" else "")
        past_label = None
        if d.state != "pending":
            ch = (d.answer or {}).get("choice")
            past_label = {"request_remedy": "Remedy requested" if not d.action else "Remedy sent", "no_longer_own": "Closed · no longer owned", "not_mine": "Closed · not mine", "snooze": "Snoozed", "fine": "Checked in · fine", "report_problem": "Claim drafted", "done": "Done", "review_and_attest": "Claim drafted", "skip_claim": "Closed · skipped"}.get(ch or "", d.state)
        badge = "Critical hazard" if d.severity == "critical" else ({"warranty_checkin": "Warranty window", "settlement_claim": "Class action settlement"}.get(d.kind, "Standard hazard"))
        return {**d.model_dump(), "item_name": d.item_name or (f"{it.brand} {it.name}".strip() if it else ""), "badge": badge,
                "meta": meta, "title": d.headline, "recall": self.recall_view(r) if r else None, "match": ({"stage": m.stage, "key": m.key, "confidence_label": facts[-2]["value"] if r and m else (facts[-1]["value"] if m else ""), "rationale": m.rationale} if m else None),
                "facts": facts, "options": [o.model_dump() for o in d.options], "past_label": past_label}

    def decisions(self) -> dict[str, Any]:
        self.resurface_snoozed()
        ds = sorted(self.store.decisions(), key=lambda d: d.created_at, reverse=True)
        pending = [self.decision_view(d) for d in sorted((d for d in ds if d.state == "pending"), key=lambda d: (d.severity != "critical", d.plan_index))]
        past = [self.decision_view(d) for d in ds if d.state != "pending"]
        return {"pending": pending, "past": past[:30]}

    def activity_row(self, a: Activity) -> dict[str, Any]:
        return {"time": _local_hhmm(a.at), "source": a.source, "text": a.text, "result": a.result, "tone": a.tone, "at": a.at, "run_id": a.run_id, "item_id": a.item_id, "decision_id": a.decision_id}

    def activity_nights(self, days: int = 7) -> dict[str, Any]:
        since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
        rows = self.store.activity(since=since)
        by_day: dict[str, list[Activity]] = {}
        for a in rows:
            by_day.setdefault(_local_date(a.at), []).append(a)
        decisions = self.store.decisions()
        today = date.today().isoformat()
        nights = []
        for day in sorted(by_day, reverse=True):
            ds = [d for d in decisions if _local_date(d.created_at) == day]
            pending = [d for d in ds if d.state == "pending"]
            run_ids = [a.run_id for a in by_day[day] if a.run_id]
            if pending:
                summary, tone = f"{len(pending)} decision(s) pending", "critical"
            elif ds:
                summary, tone = f"{len(ds)} decision(s) answered", "ok"
            elif any(a.tone == "critical" for a in by_day[day]):
                summary, tone = "Needs attention", "critical"
            else:
                summary, tone = "Quiet", "ok"
            d = date.fromisoformat(day)
            label = ("Tonight · " if day == today else "") + d.strftime("%b %d").replace(" 0", " ")
            nights.append({"date": day, "label": label, "summary": summary, "tone": tone, "run_id": run_ids[-1] if run_ids else None, "rows": [self.activity_row(a) for a in reversed(by_day[day])]})
        return {"nights": nights}

    def summary(self) -> dict[str, Any]:
        self.resurface_snoozed()
        hh = self.store.household()
        items = self.store.items()
        decisions = self.store.decisions()
        sweeps = sorted(self.store.sweeps(), key=lambda s: s.started_at)
        pending = [d for d in decisions if d.state == "pending"]
        running = [s for s in sweeps if s.status in ("running", "created") and self.control.is_running(s.run_id)] or ([True] if self._remote_busy else [])
        last = sweeps[-1] if sweeps else None
        if pending:
            quiet_days = 0
        elif decisions:
            last_dec = max(decisions, key=lambda d: d.created_at)
            quiet_days = max(0, (date.today() - date.fromisoformat(_local_date(last_dec.created_at))).days)
        else:
            quiet_days = max(0, (date.today() - date.fromisoformat(_local_date(hh.created_at))).days)
        status = "working" if running else ("pending" if pending else "idle")
        recent = [self.activity_row(a) for a in self.store.activity() if last and a.run_id == last.run_id][-8:] if last else [self.activity_row(a) for a in self.store.activity(limit=6)]
        bridge = self.bridge or default_bridge().name
        avail, reason = self.control.registry.available(bridge)
        return {
            "household": {"id": hh.id, "name": hh.name},
            "agent_status": status,
            "agent_label": {"working": "Sweeping now…", "pending": "Needs you", "idle": "Quiet"}[status],
            "sweep_label": "Sweep running" if running else (f"Last sweep {_local_hhmm(last.started_at)} {'today' if _local_date(last.started_at) == date.today().isoformat() else _local_date(last.started_at)}" if last else "No sweep yet"),
            "last_sweep": {"run_id": last.run_id if last else None, "at": last.started_at if last else None, "status": last.status if last else None},
            "quiet_days": quiet_days,
            "items_watched": len([i for i in items if i.status == "watched"]),
            "sweeps_run": len([s for s in sweeps if s.status in ("completed", "paused")]),
            "recalls_screened_30d": self.store.recalls_since(30),
            "decisions_pending": len(pending),
            "forwarding_address": self.store.prefs().forwarding_address,
            "recent_activity": recent,
            "ending_soon": [{"item_id": e["item_id"], "name": e["name"], "ends_on": e["ends_on"], "days_left": e["days_left"], "pct": e["pct"], "note": e["note"]} for e in warranty_policy.ending_soon(items, 60)[:8]],
            "provider": {"bridge": bridge, "live": bool(avail) and bridge != "mock", "label": {"claude-code": "Claude Code (local, headless)", "bedrock": "Amazon Bedrock", "anthropic": "Anthropic API", "mock": "mock provider (no tokens)", "inbox": "inbox (orchestrator)"}.get(bridge, bridge) + ("" if avail else f" · unavailable: {reason}")},
            "spend": {"today_usd": self.spend_today(), "daily_budget_usd": self.daily_budget()},
            "runtime": {"mode": "agentcore" if self.remote else "local", "arn": self.remote.arn if self.remote else None, "busy": bool(self._remote_busy), "state_bucket": os.environ.get("GUARDIAN_S3_BUCKET") or None, "state_sync": self._state_sync},
        }

    def preferences(self) -> Preferences:
        return self.store.prefs()

    def save_preferences(self, p: Preferences) -> Preferences:
        self.store.save_prefs(p)
        self.store.log(Activity(source="Household", text="Preferences saved", result=f"budget {p.budget} · threshold ${p.value_threshold:,.0f} · quiet {', '.join(p.quiet_categories) or 'none'}", tone="muted"))
        self.persist()
        return p

    # ------------------------------------------------------------------ inventory
    def add_item(self, body: dict[str, Any], source: str = "manual") -> dict[str, Any]:
        vin = (body.get("vin") or "").strip().upper() or None
        vehicle = None
        if vin:
            from .feeds.nhtsa import decode_vin

            vehicle = decode_vin(vin)
        months = body.get("warranty_months")
        it = InventoryItem(name=str(body["name"]).strip(), brand=str(body.get("brand") or "").strip(), model_number=body.get("model_number") or None, upc=body.get("upc") or None, serial=body.get("serial") or None,
                           category="Vehicle" if vehicle else (body.get("category") if body.get("category") in warranty_policy.CATEGORY_DEFAULT_MONTHS else "Other"), purchase_date=str(body["purchase_date"])[:10],
                           price=float(body["price"]) if body.get("price") not in (None, "") else None, retailer=body.get("retailer") or None, vehicle=vehicle, source=source if source in ("manual", "csv", "intake", "seed") else "manual",
                           warranty=warranty_policy.resolve(InventoryItem(name="x", purchase_date=str(body["purchase_date"])[:10], category=body.get("category") or "Other", warranty={"term_months": int(months), "source": "receipt"} if months else {})) if months else warranty_policy.resolve(InventoryItem(name="x", purchase_date=str(body["purchase_date"])[:10], category=body.get("category") or "Other")))
        if body.get("id"):
            it.id = str(body["id"])
        if body.get("receipt_text"):
            it.receipt_text = str(body["receipt_text"])
        if body.get("notes"):
            it.notes = str(body["notes"])
        it.warranty = warranty_policy.resolve(it)
        self.store.upsert_item(it)
        wv = warranty_policy.view(it)
        self.store.log(Activity(source="Intake", text=f"Added {it.brand} {it.name}".strip() + (f" ({it.vehicle.year} {it.vehicle.make} {it.vehicle.model} by VIN)" if it.vehicle else ""), result=f"warranty {wv['label']} · source {source}", tone="ok", item_id=it.id))
        self._emit_local("item.created", {"item_id": it.id})
        self.persist()
        return self.item_view(it)

    def save_item_photo(self, item_id: str, data: bytes, filename: str, content_type: str) -> dict[str, Any]:
        it = self.store.item(item_id)
        if it is None:
            raise KeyError(item_id)
        if it.photo_filename:
            self.store.delete_photo(it.id, it.photo_filename)
        it.photo_filename = self.store.save_photo(it.id, data, filename)
        it.photo_content_type = content_type
        self.store.upsert_item(it)
        self.store.log(Activity(source="Household", text=f"Added a label photo to {it.brand} {it.name}".strip(), tone="ok", item_id=it.id))
        self._emit_local("item.updated", {"item_id": it.id})
        self.persist()
        return self.item_view(it)

    def item_photo_file(self, item_id: str) -> tuple[str, str] | None:
        it = self.store.item(item_id)
        if it is None or not it.photo_filename:
            return None
        return self.store.photo_path(it.id, it.photo_filename), it.photo_content_type or "application/octet-stream"

    def remove_item_photo(self, item_id: str) -> dict[str, Any]:
        it = self.store.item(item_id)
        if it is None:
            raise KeyError(item_id)
        if it.photo_filename:
            self.store.delete_photo(it.id, it.photo_filename)
            it.photo_filename, it.photo_content_type = None, None
            self.store.upsert_item(it)
            self.persist()
        return self.item_view(it)

    def remove_item(self, item_id: str) -> dict[str, Any]:
        it = self.store.item(item_id)
        if it is None:
            raise KeyError(item_id)
        name = f"{it.brand} {it.name}".strip()
        for d in self.store.decisions():
            if d.item_id == item_id and d.state == "pending":
                d.state = "answered"
                d.answer = {"choice": "no_longer_own", "by": "household", "at": now_iso(), "comment": "item removed from inventory"}
                d.outcome = {"title": "Item removed", "subtitle": "Guardian stopped watching this item.", "steps": [{"text": "Item removed from inventory", "when": "Just now", "done": True}]}
                self.store.upsert_decision(d)
        if it.photo_filename:
            self.store.delete_photo(it.id, it.photo_filename)
        self.store.delete_item(item_id)
        self.store.log(Activity(source="Household", text=f"Removed {name} from inventory", result="no longer watched", tone="muted", item_id=item_id))
        self._emit_local("item.removed", {"item_id": item_id})
        self.persist()
        return {"ok": True, "item_id": item_id}

    # ------------------------------------------------------------------ gmail
    def gmail_status(self) -> dict[str, Any]:
        from . import gmail

        st = self.store.gmail_state()
        return {"configured": gmail.configured(), "connected": bool(st.get("refresh_token")), "email": st.get("email"), "last_sync": st.get("last_sync")}

    def gmail_connect_url(self) -> str:
        from . import gmail

        if not gmail.configured():
            raise ValueError("Gmail is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see .env.example)")
        return gmail.auth_url(state=self.store.household().id)

    def gmail_handle_callback(self, code: str) -> dict[str, Any]:
        from . import gmail

        tokens = gmail.exchange_code(code)
        profile = gmail.get_profile(tokens["access_token"])
        st = {
            "refresh_token": tokens.get("refresh_token") or self.store.gmail_state().get("refresh_token"),
            "access_token": tokens["access_token"],
            "expires_at": time.time() + float(tokens.get("expires_in") or 3600),
            "email": profile.get("emailAddress"),
            "connected_at": now_iso(),
            "last_sync": None,
        }
        self.store.save_gmail_state(st)
        self.store.log(Activity(source="Household", text=f"Connected Gmail ({st['email']})", result="ready to sync receipts", tone="ok"))
        self.persist()
        return st

    def gmail_disconnect(self) -> dict[str, Any]:
        self.store.save_gmail_state({})
        self.store.log(Activity(source="Household", text="Disconnected Gmail", tone="muted"))
        self.persist()
        return {"ok": True}

    def gmail_sync(self, max_results: int = 15) -> dict[str, Any]:
        """Pull recent receipt-shaped messages and run each through the existing intake pipeline. Best-effort: one
        message failing to parse does not stop the others."""
        from . import gmail

        st = self.store.gmail_state()
        if not st.get("refresh_token"):
            raise ValueError("Gmail is not connected")
        access, st = gmail.valid_access_token(st)
        self.store.save_gmail_state(st)
        ids = gmail.list_message_ids(access, max_results=max_results)
        added = 0
        for mid in ids:
            try:
                msg = gmail.get_message(access, mid)
                if len((msg.get("text") or "").strip()) < 8:
                    continue
                res = self.intake(msg["text"], source="email")
            except Exception as e:  # noqa: BLE001
                self.log(f"gmail sync: message {mid} failed: {e}")
                continue
            if res.get("item"):
                it = self.store.item(res["item"]["id"])
                if it is not None and not it.gmail_message_id:
                    it.gmail_message_id = mid
                    self.store.upsert_item(it)
                added += 1
        st["last_sync"] = now_iso()
        self.store.save_gmail_state(st)
        self.store.log(Activity(source="Intake", text=f"Gmail sync checked {len(ids)} message(s)", result=f"{added} item(s) added", tone="ok"))
        self.persist()
        return {"checked": len(ids), "added": added}

    # ------------------------------------------------------------------ background scheduler
    def _start_scheduler(self) -> None:
        threading.Thread(target=self._scheduler_loop, name="guardian-scheduler", daemon=True).start()
        self.log("background scheduler started: nightly sweep every 24h, Gmail sync every 45m when connected")

    def _scheduler_loop(self) -> None:
        poll_s, sweep_every_s, gmail_every_s = 300, 24 * 3600, 45 * 60
        while True:
            try:
                st = self.store.scheduler_state()
                now = time.time()
                if now - float(st.get("last_sweep_at") or 0) >= sweep_every_s:
                    st["last_sweep_at"] = now
                    self.store.save_scheduler_state(st)
                    try:
                        self.check_budget(reserve=0.05)
                        self.start_sweep(trigger="scheduled")
                    except ValueError as e:
                        self.log(f"scheduled sweep skipped: {e}")
                    except Exception as e:  # noqa: BLE001
                        self.log(f"scheduled sweep failed: {e}")
                if self.store.gmail_state().get("refresh_token") and now - float(st.get("last_gmail_sync_at") or 0) >= gmail_every_s:
                    st = self.store.scheduler_state()
                    st["last_gmail_sync_at"] = now
                    self.store.save_scheduler_state(st)
                    try:
                        self.gmail_sync()
                    except Exception as e:  # noqa: BLE001
                        self.log(f"scheduled gmail sync failed: {e}")
            except Exception as e:  # noqa: BLE001
                self.log(f"scheduler loop error: {e}")
            time.sleep(poll_s)
