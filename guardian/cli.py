"""guardian CLI: serve the API and dashboard, seed a household, run a sweep, intake a receipt, answer a decision."""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Optional

import typer

app = typer.Typer(add_completion=False, help="Recall & Warranty Guardian")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _guardian(bridge: Optional[str], data: Optional[str], runs: Optional[str], quiet: bool = True):
    from .service import Guardian

    g, _ = Guardian.build(data_dir=data, runs_dir=runs, bridge=bridge, quiet=quiet, with_gren_app=False)
    return g


@app.command()
def serve(port: int = typer.Option(8787, "--port"), host: str = typer.Option("127.0.0.1", "--host"), bridge: Optional[str] = typer.Option(None, "--bridge", help="bedrock | anthropic | claude-code | inbox | mock"),
          data: Optional[str] = typer.Option(None, "--data", help="household store dir (default var/household)"), runs: Optional[str] = typer.Option(None, "--runs", help="gren runs dir (default var/runs)"),
          schedule: bool = typer.Option(True, "--schedule/--no-schedule", help="run the nightly sweep and Gmail sync automatically in the background (real model spend, capped by GUARDIAN_DAILY_BUDGET_USD)")) -> None:
    """Serve the Guardian API, the gren run API under /gren, and the built dashboard."""
    import uvicorn

    from .api.app import create_guardian_app

    if bridge == "mock":
        os.environ.setdefault("GREN_ALLOW_MOCK", "1")
    application = create_guardian_app(data_dir=data, runs_dir=runs, bridge=bridge, quiet=False, schedule=schedule)
    g = application.state.guardian
    typer.echo(f"guardian: http://{host}:{port}  (data: {g.store.root}, runs: {g.run_store.root}, bridge: {bridge or 'auto'}, feeds: {os.environ.get('GUARDIAN_FEEDS', 'live')}, background scheduler: {'on' if schedule else 'off'})")
    uvicorn.run(application, host=host, port=port, log_level="warning")


@app.command()
def seed(file: str = typer.Option(os.path.join(ROOT, "demo", "household.json"), "--file"), reset: bool = typer.Option(True, "--reset/--keep"), data: Optional[str] = typer.Option(None, "--data"),
         case_studies: bool = typer.Option(True, "--case-studies/--no-case-studies", help="also seed the battery-recall and class-action-settlement example decisions")) -> None:
    """Load a household (items, preferences) from a JSON file. --reset clears the store first."""
    from .case_studies import seed_case_studies
    from .demo_photos import attach_all
    from .models import Household, Preferences
    from .service import Guardian

    g, _ = Guardian.build(data_dir=data, with_gren_app=False)
    with open(file, encoding="utf-8") as f:
        seedd = json.load(f)
    if reset:
        g.store.reset()
    hh = Household.model_validate(seedd.get("household") or {})
    g.store.save_household(hh)
    g.store.save_prefs(Preferences.model_validate(seedd.get("prefs") or {}))
    n = 0
    for row in seedd.get("items") or []:
        g.add_item(row, source="seed")
        n += 1
    typer.echo(f"seeded household '{hh.name}' with {n} item(s) into {g.store.root}")
    if case_studies:
        cs = seed_case_studies(g)
        typer.echo(f"seeded {cs['items']} case-study item(s) and {cs['decisions']} pending decision(s) (battery recall, class-action settlement)")
    n_photos = attach_all(g)
    typer.echo(f"attached {n_photos} demo label photo(s)")


@app.command()
def sweep(bridge: Optional[str] = typer.Option(None, "--bridge"), window: int = typer.Option(45, "--window", help="days of recall history to pull"), full_scan: bool = typer.Option(False, "--full-scan"),
          auto_approve: bool = typer.Option(False, "--auto-approve", help="approve the household gate automatically (demo)"), data: Optional[str] = typer.Option(None, "--data"), runs: Optional[str] = typer.Option(None, "--runs"),
          timeout: int = typer.Option(900, "--timeout")) -> None:
    """Run the nightly sweep now and wait for it to finish or pause at the household gate."""
    if bridge == "mock":
        os.environ.setdefault("GREN_ALLOW_MOCK", "1")
    g = _guardian(bridge, data, runs, quiet=False)
    rid = g.start_sweep(window_days=window, full_scan=full_scan, auto_approve=auto_approve, trigger="cli")
    typer.echo(f"sweep started: {rid}")
    run = g.wait(rid, timeout_s=timeout)
    typer.echo(f"status: {run['status']}  cost ${run['totals']['cost_usd']:.4f}  wall {run['totals']['wall_ms'] / 1000:.1f}s")
    if run["status"] == "paused":
        pend = [d for d in g.store.decisions() if d.state == "pending"]
        typer.echo(f"paused at the household gate with {len(pend)} pending decision(s):")
        for d in pend:
            typer.echo(f"  {d.id}  [{d.severity}]  {d.headline}")
            typer.echo(f"      SMS: {d.message}")
            typer.echo(f"      answer with: guardian answer {d.id} {'|'.join(o.key for o in d.options)}")
    elif run["status"] == "completed":
        out = run.get("output") or {}
        typer.echo(f"channel: {out.get('channel')}  feeds: {json.dumps(out.get('feeds'))}  matching: {json.dumps(out.get('matching'))}")
    else:
        typer.echo(f"error: {run.get('error')}")
        raise typer.Exit(1)


@app.command()
def answer(decision_id: str, choice: str, by: str = typer.Option("cli", "--by"), data: Optional[str] = typer.Option(None, "--data"), runs: Optional[str] = typer.Option(None, "--runs"), bridge: Optional[str] = typer.Option(None, "--bridge"),
           wait: bool = typer.Option(True, "--wait/--no-wait")) -> None:
    """Answer a pending decision (request_remedy | no_longer_own | not_mine | snooze | fine | report_problem)."""
    if bridge == "mock":
        os.environ.setdefault("GREN_ALLOW_MOCK", "1")
    g = _guardian(bridge, data, runs, quiet=False)
    res = g.answer(decision_id, choice, by=by)
    typer.echo(f"answered {decision_id}: {choice}  resumed={res.get('resumed')}")
    if wait and res.get("resumed") and res.get("run_id"):
        run = g.wait(res["run_id"], timeout_s=600)
        typer.echo(f"run {res['run_id']}: {run['status']}  cost ${run['totals']['cost_usd']:.4f}")
        d = g.store.decision(decision_id)
        if d and d.outcome:
            for s in d.outcome.get("steps", []):
                typer.echo(f"  [{'x' if s.get('done') else ' '}] {s.get('text')}  ({s.get('when')})")


@app.command()
def intake(text: Optional[str] = typer.Argument(None), file: Optional[str] = typer.Option(None, "--file"), bridge: Optional[str] = typer.Option(None, "--bridge"), data: Optional[str] = typer.Option(None, "--data"),
           runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """Parse a receipt or order confirmation (text or --file) into inventory items."""
    if bridge == "mock":
        os.environ.setdefault("GREN_ALLOW_MOCK", "1")
    if file:
        with open(file, encoding="utf-8", errors="replace") as f:
            text = f.read()
    if not text:
        typer.echo("give the receipt text or --file", err=True)
        raise typer.Exit(2)
    g = _guardian(bridge, data, runs, quiet=False)
    res = g.intake(text, source="email" if file else "paste")
    typer.echo(json.dumps({k: v for k, v in res.items() if k != "item"}, indent=1))
    if res.get("item"):
        it = res["item"]
        typer.echo(f"item: {it['id']}  {it['brand']} {it['name']}  ${it.get('price')}  warranty {it['warranty']['label']}")


@app.command()
def feeds(window: int = typer.Option(45, "--window"), data: Optional[str] = typer.Option(None, "--data")) -> None:
    """Refresh the recall feeds only (no matching)."""
    from .feeds.refresh import refresh
    from .store import Store

    out = refresh(Store(data), window_days=window)
    typer.echo(json.dumps({k: v for k, v in out.items() if k != "new_recall_ids"}, indent=1))


@app.command()
def status(data: Optional[str] = typer.Option(None, "--data"), runs: Optional[str] = typer.Option(None, "--runs")) -> None:
    """Household summary as JSON."""
    g = _guardian(None, data, runs)
    typer.echo(json.dumps(g.summary(), indent=1, default=str))


@app.command()
def reset(data: Optional[str] = typer.Option(None, "--data"), yes: bool = typer.Option(False, "--yes")) -> None:
    """Delete the household store (items, recalls, matches, decisions, activity, outbox)."""
    from .store import Store

    s = Store(data)
    if not yes:
        typer.echo(f"this deletes everything under {s.root}; re-run with --yes")
        raise typer.Exit(1)
    s.reset()
    typer.echo("reset")


if __name__ == "__main__":
    sys.exit(app())
