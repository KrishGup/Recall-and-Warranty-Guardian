"""The five graph shapes worth knowing, as scaffold templates."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class Shape:
    id: str
    title: str
    diagram: str
    use: str
    template: Callable[[str], str]


def _header(name: str, description: str) -> str:
    return f"""name: {name}
version: 1
description: {description}
budget: {{ max_cost_usd: 2.0, max_wall_ms: 900000, max_width: 5 }}
defaults: {{ model: sonnet, effort: low, failure: {{ retries: 1, timeout_ms: 240000 }} }}
input_schema:
  type: object
  required: [task]
  properties:
    task: {{ type: string }}
"""


def _fork_join(name: str) -> str:
    return _header(name, "Fork/Join: plan -> parallel workers -> deterministic reduce -> synthesize") + """output: { from: synthesize }
nodes:
  - id: plan
    kind: agent
    prompt: |
      Task: {{ input.task }}
      Split this into 3-5 genuinely independent sub-questions (different angles, no overlap).
    output_schema:
      type: object
      required: [subtasks]
      properties:
        subtasks: { type: array, minItems: 3, maxItems: 5, items: { type: object, required: [name, question], properties: { name: { type: string }, question: { type: string } } } }

  - id: work
    kind: agent
    model: haiku
    map: $nodes.plan.output.subtasks
    max_width: 5
    failure: { retries: 1, quorum: 0.6, on_failure: block }
    prompt: |
      Answer sub-question "{{ item.name }}": {{ item.question }}
      Return 2-5 findings with evidence and a source.
    output_schema:
      type: object
      required: [findings]
      properties:
        findings: { type: array, items: { type: object, required: [claim, evidence, source, confidence], properties: { claim: { type: string }, evidence: { type: string }, source: { type: string }, confidence: { type: number, minimum: 0, maximum: 1 } } } }

  - id: reduce
    kind: code
    fn: flatten
    input: { items: $nodes.work.outputs }
    args: { path: findings }

  - id: dedupe
    kind: code
    fn: dedupe
    input: { items: $nodes.reduce.output.items }
    args: { key: [claim] }

  - id: synthesize
    kind: agent
    effort: medium
    input: { task: $input.task, findings: $nodes.dedupe.output.items, workers_completed: $nodes.work.count.completed, workers_total: $nodes.work.count.total }
    prompt: |
      Write the answer to the task from ONLY the findings in <input>. Cite sources. State coverage (workers_completed/workers_total) if incomplete.
    output_schema:
      type: object
      required: [answer, citations, coverage_note]
      properties: { answer: { type: string }, citations: { type: array, items: { type: string } }, coverage_note: { type: string } }
"""


def _escalation(name: str) -> str:
    return _header(name, "Escalation ladder: regex -> haiku -> sonnet -> human gate, routed by confidence") + """output: { from: decision }
nodes:
  - id: rung0
    kind: code
    fn: classify_regex
    input: { text: $input.task }
    args: { path: text, rules: [{ match: "refund|chargeback", label: billing }, { match: "crash|error|bug", label: technical }], default: unknown }

  - id: route0
    kind: router
    routes:
      - { when: { gte: [$nodes.rung0.output.confidence, 0.85] }, route: done, reason: "regex matched with high confidence" }
    default: escalate

  - id: rung1
    kind: agent
    model: haiku
    when: { eq: [$nodes.route0.output.route, escalate] }
    prompt: "Classify this request into billing | technical | sales | other with a confidence 0-1: {{ input.task }}"
    output_schema: { type: object, required: [label, confidence, reason], properties: { label: { type: string, enum: [billing, technical, sales, other] }, confidence: { type: number, minimum: 0, maximum: 1 }, reason: { type: string } } }

  - id: route1
    kind: router
    when: { eq: [$nodes.route0.output.route, escalate] }
    routes:
      - { when: { gte: [$nodes.rung1.output.confidence, 0.75] }, route: done, reason: "haiku confident" }
    default: escalate

  - id: rung2
    kind: agent
    model: sonnet
    effort: medium
    when: { eq: [$nodes.route1.output.route, escalate] }
    input: { cheap_guess: $nodes.rung1.output }
    prompt: "A cheaper model was unsure (see <input>). Classify carefully: {{ input.task }}"
    output_schema: { type: object, required: [label, confidence, reason], properties: { label: { type: string, enum: [billing, technical, sales, other] }, confidence: { type: number, minimum: 0, maximum: 1 }, reason: { type: string } } }

  - id: human
    kind: gate
    title: Classification still uncertain - decide manually
    approve_effect: The system records the classification from the strong model.
    reject_effect: The system records that a human must classify this request.
    when: { and: [{ eq: [$nodes.route1.output.route, escalate] }, { lt: [$nodes.rung2.output.confidence, 0.6] }] }
    show: { task: $input.task, rung1: $nodes.rung1.output, rung2: $nodes.rung2.output }
    on_reject: { fail_run: false }

  - id: decision
    kind: code
    fn: merge
    optional: [rung1, rung2, human, route1]
    input:
      regex: $nodes.rung0.output
      haiku: $nodes.rung1.output
      sonnet: $nodes.rung2.output
      human: $nodes.human.output
      route0: $nodes.route0.output.route
      route1: $nodes.route1.output.route
    args: { mode: object }
"""


def _tournament(name: str) -> str:
    return _header(name, "Tournament: N candidates -> M independent judges -> deterministic vote count -> winner") + """output: { from: winner }
nodes:
  - id: candidates
    kind: agent
    model: haiku
    map: $input.styles
    max_width: 4
    failure: { quorum: 0.5 }
    prompt: |
      Task: {{ input.task }}
      Produce ONE candidate in the style "{{ item }}". Be specific and concrete.
    output_schema: { type: object, required: [id, text, rationale], properties: { id: { type: string }, text: { type: string }, rationale: { type: string } } }

  - id: judges
    kind: agent
    model: sonnet
    map: $input.judges
    max_width: 3
    input: { candidates: $nodes.candidates.outputs, criteria: $input.criteria }
    prompt: |
      You are judge "{{ item }}". Rank the candidates in <input> against the criteria. Pick exactly one winner (its index in the candidates array) and explain the deciding factor.
    output_schema: { type: object, required: [winner, ranking, reason], properties: { winner: { type: integer, minimum: 0 }, ranking: { type: array, items: { type: integer } }, reason: { type: string } } }

  - id: tally
    kind: code
    fn: count_votes
    input: { items: $nodes.judges.outputs }
    args: { by: winner }

  - id: winner
    kind: code
    fn: identity
    input: { winner_index: $nodes.tally.output.winner, votes: $nodes.tally.output.ranked, candidates: $nodes.candidates.outputs, judges: $nodes.judges.outputs }
"""


def _map_reduce_verify(name: str) -> str:
    return _header(name, "Map -> deterministic reduce -> adversarial verify -> synthesize") + """output: { from: synthesize }
frozen: [verifier_can_kill]
nodes:
  - id: plan
    kind: agent
    prompt: "Split the task into 3-5 independent lanes: {{ input.task }}"
    output_schema: { type: object, required: [lanes], properties: { lanes: { type: array, minItems: 3, items: { type: object, required: [name, angle], properties: { name: { type: string }, angle: { type: string } } } } } }
  - id: work
    kind: agent
    model: haiku
    map: $nodes.plan.output.lanes
    max_width: 5
    failure: { retries: 1, quorum: 0.6 }
    prompt: "Lane {{ item.name }} ({{ item.angle }}) for task: {{ input.task }}. Return findings with claim, evidence, source, confidence."
    output_schema: { type: object, required: [findings], properties: { findings: { type: array, items: { type: object, required: [claim, evidence, source, confidence], properties: { claim: { type: string }, evidence: { type: string }, source: { type: string }, confidence: { type: number } } } } } }
  - id: reduce
    kind: code
    fn: flatten
    input: { items: $nodes.work.outputs }
    args: { path: findings }
  - id: dedupe
    kind: code
    fn: dedupe
    input: { items: $nodes.reduce.output.items }
    args: { key: [claim] }
  - id: verify
    kind: verify
    model: haiku
    target: $nodes.dedupe.output.items
    kill_threshold: 0.6
    min_survivors: 2
    prompt: "Try to falsify this finding: {{ json item }}. Kill it if the evidence does not support the claim or the source is vague."
  - id: rank
    kind: code
    fn: top_k
    input: { items: $nodes.verify.survivors }
    args: { k: 10, by: confidence }
  - id: synthesize
    kind: agent
    effort: medium
    input: { task: $input.task, findings: $nodes.rank.output.items, kill_rate: $nodes.verify.kill_rate, coverage: $nodes.work.count }
    prompt: "Answer the task from ONLY the verified findings in <input>; cite sources; note coverage and kill rate."
    output_schema: { type: object, required: [answer, citations, caveats], properties: { answer: { type: string }, citations: { type: array, items: { type: string } }, caveats: { type: array, items: { type: string } } } }
"""


def _discovery_loop(name: str) -> str:
    return _header(name, "Bounded discovery loop: search until no new findings for 2 rounds (max 5), dedupe against everything seen") + """output: { from: discover }
nodes:
  - id: discover
    kind: loop
    input: { task: $input.task }
    collect: $output.findings
    seen_key: key
    until: { max_rounds: 5, no_new_for_rounds: 2, max_cost_usd: 1.0 }
    body:
      name: discover-round
      budget: { max_cost_usd: 0.5, max_width: 3 }
      defaults: { model: haiku, effort: low }
      output: { from: keep }
      nodes:
        - id: search
          kind: agent
          input: { already_seen: $input.seen, round: $input.round }
          prompt: |
            Round {{ input.round }} for task: {{ input.task }}
            Find NEW items not in already_seen (see <input>). Each item needs a stable "key" (lowercase slug), a claim, evidence and a source. Return an empty list if you genuinely cannot find anything new.
          output_schema: { type: object, required: [findings], properties: { findings: { type: array, items: { type: object, required: [key, claim, evidence, source], properties: { key: { type: string }, claim: { type: string }, evidence: { type: string }, source: { type: string } } } } } }
        - id: verify
          kind: verify
          target: $nodes.search.output.findings
          prompt: "Try to falsify: {{ json item }}"
        - id: keep
          kind: code
          fn: identity
          input: { findings: $nodes.verify.survivors, killed: $nodes.verify.killed }
"""


SHAPES: list[Shape] = [
    Shape("fork-join", "Fork / Join", "        A\n     /  |  \\\n    B   C   D\n     \\  |  /\n        E", "research, audits, batch analysis, competitive scans", _fork_join),
    Shape("escalation", "Escalation Ladder", "cheap check\n    | uncertain?\nmedium check\n    | still uncertain?\nstrong model / human", "most cases are easy but a few deserve expensive reasoning", _escalation),
    Shape("tournament", "Tournament", "candidate 1 -\\\ncandidate 2 --> judges -> winner\ncandidate 3 -/", "copy, designs, plans, code approaches, hypotheses", _tournament),
    Shape("map-reduce-verify", "Map -> Reduce -> Verify -> Synthesize", "many workers\n     |\nnormalize + dedupe (code)\n     |\nattack weak findings (verify, kill authority)\n     |\nfinal answer", "decision-grade research and large-scale review", _map_reduce_verify),
    Shape("discovery-loop", "Bounded Discovery Loop", "search -> new findings? -> verify -> add to seen -> search again\nstop after: no new findings for N rounds | max rounds | max spend | max time", "when you do not know how large the problem is before starting", _discovery_loop),
]

SHAPE_IDS = [s.id for s in SHAPES]


def scaffold(shape: str, name: str) -> str:
    for s in SHAPES:
        if s.id == shape:
            return s.template(name)
    raise ValueError(f'unknown shape "{shape}". Known: {", ".join(SHAPE_IDS)}')


def shapes_summary() -> list[dict[str, str]]:
    return [{"id": s.id, "title": s.title, "diagram": s.diagram, "use": s.use} for s in SHAPES]
