import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
os.environ.setdefault("GREN_ALLOW_MOCK", "1")
os.environ["GUARDIAN_FEEDS"] = "fixtures"
os.environ["GUARDIAN_ENV_FILE"] = ""  # never let a developer's .env (AWS keys, live feeds) leak into the tests

from guardian.store import Store  # noqa: E402


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    d = str(tmp_path / "household")
    monkeypatch.setenv("GUARDIAN_DATA", d)
    monkeypatch.setenv("GUARDIAN_RUNS", str(tmp_path / "runs"))
    return d


@pytest.fixture
def store(data_dir):
    return Store(data_dir)


@pytest.fixture
def demo():
    with open(os.path.join(ROOT, "demo", "household.json"), encoding="utf-8") as f:
        return json.load(f)


def seed_store(store: Store, demo: dict, only: set[str] | None = None):
    """Seed through the service so warranty terms and VINs resolve the same way the CLI does."""
    from guardian.models import Household, Preferences
    from guardian.service import Guardian
    from gren.control import RunControl
    from gren.engine.state import RunStore
    from gren.models.registry import ModelRegistry

    runs = RunStore(os.path.join(store.root, "..", "runs"))
    control = RunControl(runs, os.path.join(ROOT, "guardian", "graphs"), ModelRegistry(mock_options={"latency_ms": 1, "jitter_ms": 1, "kill_rate": 0.0}))
    g = Guardian(store, runs, control)
    store.save_household(Household.model_validate(demo["household"]))
    store.save_prefs(Preferences.model_validate(demo["prefs"]))
    for row in demo["items"]:
        if only is None or row["id"] in only:
            g.add_item(row, source="seed")
    return g
