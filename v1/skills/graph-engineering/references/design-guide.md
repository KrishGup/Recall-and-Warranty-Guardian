# Graph engineering — the design guide (condensed)

Source: "Graph Engineering: The Complete Guide to Building Multi-Agent AI Systems" (LunarResearcher) and "Graph engineering" (whrrari), encoded into gren.

## Vocabulary
```
NODE   = one bounded unit of work            (gren: agent | code | verify | gate | router | loop | subgraph)
EDGE   = a real dependency: data crosses it  (gren: derived from $nodes.<id> references)
STATE  = the data that survives between nodes (gren: structured outputs validated by JSON schema, stored as artifacts)
ROUTER = the rule that selects the next edge (gren: router node, deterministic, logged with state)
GATE   = the check that decides whether work can continue (gren: verify with kill authority; gate = human approval)
```

## 1. A workflow is not a checklist
Order is not dependency. Ask "what information must exist before this can start?" — not "what comes next?". If B never consumes anything A produced, there is no edge. In gren an edge exists only when B references `$nodes.A…`; the analysis lists what crosses each edge and flags status-only edges as waiting, not dependency.

## 2. The graph needs state, not just arrows
Every node returns an object, not a blob. `output_schema` on every agent/verify node; consumers read fields (`$nodes.research.outputs`, `$nodes.verify.survivors`). Replaceability, inspectability, determinism around the model.

## 3. The dependency test
For every arrow: "what exact data crosses?" Bad: "the next agent should know the previous finished" (status). Good: "the reviewer receives claim, source URL, evidence excerpt." The goal is not maximum parallelism — it is removing fake synchronization.

## 4. Parallelism is not free — width budget
Add a worker only when it increases coverage more than it increases reconciliation cost. `budget.max_width` (global) and `max_width` per fan-out. Optimize useful independent coverage per dollar (metric: unique records per worker).

## 5. The critical path matters more than total steps
Latency = longest unavoidable path, not the sum. `gren analyze` estimates it; `gren metrics` measures it. A 40-node graph can beat a 7-node chain.

## 6. Compress before you reason
Never feed 20 raw worker outputs into one synthesis prompt. Put deterministic reducers first: `flatten`, `dedupe`, `filter_nulls`, `sort`, `top_k`, `group_by`, `count_votes`, `normalize_labels`. Use models for ambiguity, code for plumbing. The analysis warns when an opus/fable node reads raw fan-out output; the compression metric shows what reducers removed.

## 7. Verification should be asymmetric
Worker: "find the strongest answer." Verifier: "find the reason this should be rejected." A `verify` node gets the adversarial preamble automatically, has authority to kill (`kill_threshold`), and can send rejections back through a bounded `repair:` cycle. A verifier nobody listens to is decoration (validator error under `verifier_can_kill`).

### Lessons from live runs (gren, Sep 2026)
- A verifier will happily reject outputs that are wrong because of YOUR plumbing: a marker file the worktree reducer left in the diff, a header that said `findings_verified: 45` when 15 survived, an arXiv `pdf/` URL that did not match the verified `abs/` URL. Treat every kill as evidence about the graph first, the model second.
- Give writers the facts they are expected to state (coverage counts, what was killed) as explicit input; a "limits" section written without them will guess, and the editor will catch the guess.
- Grade severity in editor prompts: kill only for fabricated/unsupported claims, contradictions or a missing required dimension; pass with listed reasons otherwise. An editor that kills for metadata quibbles never converges inside a bounded repair budget.
- Loop rounds, mapped subgraphs and verify fan-outs are where budgets blow: cap the fan-out with code before the expensive step, and set `max_cost_usd` on every tool node.

## 8. Design failure domains before the graph runs
Per node: `failure: { retries, fallback: {model|bridge}, timeout_ms, on_failure: block|continue, quorum }`. A fan-out with 9/10 workers done still produces output — and the output knows it is 9/10 (`$nodes.x.count`). Never hide missing work; degrade visibly. Block only when the node is critical.

## 9. Human approval is an edge type
`gate` nodes + `requires_gate` make the downstream node structurally unreachable until an approval record exists. Not "the model was told to ask first." Mandatory for `side_effect: true` (frozen constraint). Rejection can route feedback back to the producer.

## 10. Some rules should be frozen
Constraints on the graph, not suggestions to the agent: spend cap, gate before side effect, no unbounded loops, structured outputs only, side effects run at most once; opt-in: verifier can kill, width budget, no status-only edges. The engine validates and enforces them.

## 11. Observe the graph, not the chat
Critical-path latency, node failure rate, retry rate, verifier kill rate, fan-out efficiency, compression ratio, human intervention rate, width vs budget, cost by model. `gren metrics`, dashboard Metrics tab.

## 12. Five shapes
1. Fork/Join — research, audits, batch analysis.
2. Escalation ladder — cheap check → medium → strong model/human; most cases stop early.
3. Tournament — candidates → independent judges → code counts votes.
4. Map → reduce → verify → synthesize — decision-grade research.
5. Bounded discovery loop — search until no new findings for N rounds; max rounds/spend/time are part of the topology.

Also: the chain (only when every step truly depends on the previous), the diamond (fork/join), the router (inspect state, choose one path), the controlled cycle (work → verify → fail → feedback → work, with a hard stop).

## 13. The spec template
GOAL · INPUT STATE · PARALLEL WORK · EDGE DATA · REDUCER · VERIFICATION · FAILURE POLICY · BUDGET · HUMAN GATE · OUTPUT. Fill it before writing prompts: prompts optimize nodes, the spec optimizes the system.

## 14. When not to build a graph
Small task; genuinely sequential; still exploring; coordination cost > work; one coherent perspective wanted; human steers every step. A graph buys width, isolation and control flow — not taste or truth.

## The checklist (gren prints it with `analyze`)
- [ ] every edge carries real data or authority
- [ ] every node has one bounded job, structured in and out
- [ ] independent nodes run in parallel; joins only where the full set is required
- [ ] important results are verified before moving downstream
- [ ] failures retry without duplicating side effects; the graph resumes from a checkpoint
- [ ] every cycle has a hard stop and a budget
- [ ] a human can interrupt high-risk paths
- [ ] every route selection is explainable
- [ ] the graph is simpler than the problem it solves — if not, delete nodes
