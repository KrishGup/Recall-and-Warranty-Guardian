"""gren code-node modules. Each exports reduce(input, args, ctx) and is referenced from guardian/graphs/*.yaml
with `module: ../reducers/<name>.py`. Deterministic; no tokens; every one reports `_stats` so compression is measurable."""
