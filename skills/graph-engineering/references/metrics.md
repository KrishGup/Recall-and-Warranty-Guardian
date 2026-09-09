# Reading gren metrics as architecture signals

| metric | healthy | what it means when it is not |
|---|---|---|
| critical path vs wall | wall ≈ critical path | large gap = the engine waited on width budget or gates; check `peak width` and `human` |
| parallel speedup (sum of work / critical path) | > 1.5× for fork/join graphs | ≈ 1× = the graph ran as a chain: fake edges, or a fan-out with width 1 |
| peak width vs budget | below budget | at budget every time = queueing; raise only if `unique/worker` is still high |
| node failure rate | < 10% | one node dominating = brittle prompt, tool or schema (see `gren_node` artifacts) |
| retry rate | < 20% | succeeding only after retries is not healthy; fix the node, do not raise retries |
| verifier kill rate | 10–50% | 0% = verifier is decoration (weak prompt, threshold too high); ≥ 80% = workers poorly scoped or verifier too strict |
| fan-out efficiency (unique per worker) | > 2 | ≈ 1 or lower = workers duplicate each other; reduce width or diversify lanes |
| compression (records kept) | 30–70% | ≈ 100% = reducers do nothing, synthesis reads raw material; add dedupe/rank/filter |
| degraded fan-outs | none | "7/10" = failure domains worked; decide whether coverage is still sufficient (quorum) |
| human intervention | gates only | manual task completions / rejections = places where the architecture needs work |
| cost by model | most cost on cheap models | opus dominating = move extraction/verification to haiku, keep opus for synthesis |

Iterate on the **topology**, not the prompts first: cut fake edges, add reducers, move verification earlier, bound width, put gates only in front of irreversible actions.
