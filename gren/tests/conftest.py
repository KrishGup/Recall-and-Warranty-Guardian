import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
os.environ.setdefault("GREN_ALLOW_MOCK", "1")

from gren.engine.runtime import GraphRun, RunOptions  # noqa: E402
from gren.engine.state import RunStore  # noqa: E402
from gren.models.registry import ModelRegistry  # noqa: E402
from gren.spec.load import parse_spec_text  # noqa: E402

OUT = {"type": "object", "required": ["value"], "properties": {"value": {"type": "string"}}}
LIST = {"type": "object", "required": ["items"], "properties": {"items": {"type": "array", "minItems": 2, "maxItems": 3, "items": {"type": "object", "required": ["claim", "source"], "properties": {"claim": {"type": "string"}, "source": {"type": "string"}}}}}}


def j(x) -> str:
    return json.dumps(x)


def registry(**mock) -> ModelRegistry:
    return ModelRegistry(mock_options={"latency_ms": 5, "jitter_ms": 5, **mock})


class Harness:
    def __init__(self, root: str):
        self.store = RunStore(os.path.join(root, "runs"))

    def run(self, spec_yaml: str, input_=None, mock: dict | None = None, **opts):
        spec = parse_spec_text(spec_yaml)
        reg = registry(**(mock or {}))
        o = RunOptions(bridge="mock", gate_wait="return", **opts)
        run = GraphRun.create(self.store, spec, "<test>", input_ or {}, reg, o)
        state = run.run()
        return state, run

    def resume(self, run_id: str, mock: dict | None = None, **opts):
        reg = registry(**(mock or {}))
        run = GraphRun.resume(self.store, run_id, reg, RunOptions(bridge="mock", gate_wait="return", **opts))
        return run.run(), run


@pytest.fixture
def h(tmp_path):
    return Harness(str(tmp_path))
