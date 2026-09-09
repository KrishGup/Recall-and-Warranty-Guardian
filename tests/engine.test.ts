import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze } from "../src/spec/analyze.js";
import { loadGraphFromObject, parseSpecText } from "../src/spec/load.js";
import { GraphRunner } from "../src/engine/scheduler.js";
import { RunStore } from "../src/engine/state.js";
import { BridgeRegistry } from "../src/bridges/registry.js";
import { MockBridge } from "../src/bridges/mock.js";
import { computeMetrics } from "../src/metrics/metrics.js";
import { resolveRef, renderTemplate, evalCond, collectNodeRefs } from "../src/engine/expr.js";
import { builtinReducers } from "../src/reducers/builtin.js";

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gren-test-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const OUT = { type: "object", required: ["value"], properties: { value: { type: "string" } } };
const LIST = { type: "object", required: ["items"], properties: { items: { type: "array", minItems: 2, maxItems: 3, items: { type: "object", required: ["claim", "source"], properties: { claim: { type: "string" }, source: { type: "string" } } } } } };

function bridges(opts: ConstructorParameters<typeof MockBridge>[0] = {}) {
  const reg = new BridgeRegistry();
  reg.register(new MockBridge({ latencyMs: 5, jitterMs: 5, ...opts }));
  return reg;
}

async function run(specYaml: string, input: unknown = {}, mock: ConstructorParameters<typeof MockBridge>[0] = {}, extra: Partial<Parameters<typeof GraphRunner.create>[0]> = {}) {
  const store = new RunStore(path.join(tmp, "runs"));
  const spec = parseSpecText(specYaml);
  const runner = GraphRunner.create({ store, bridges: bridges(mock), spec, specFile: "<test>", input, bridge: "mock", gateWait: "return", ...extra });
  const state = await runner.run();
  return { state, store, runner };
}

describe("expressions", () => {
  const scope = { input: { topic: "x", n: 2 }, nodes: { a: { status: "completed", output: { items: [{ t: "one" }, { t: "two" }], flag: true } }, b: { status: "skipped" } } };
  it("resolves refs and templates", () => {
    expect(resolveRef("$input.topic", scope)).toBe("x");
    expect(resolveRef("$nodes.a.output.items[1].t", scope)).toBe("two");
    expect(resolveRef("$nodes.missing.output.x", scope)).toBeUndefined();
    expect(renderTemplate("T={{ input.topic }} J={{ json $nodes.a.output.flag }} keep {{not a ref}}", scope)).toBe("T=x J=true keep {{not a ref}}");
  });
  it("evaluates conditions", () => {
    expect(evalCond({ eq: ["$input.n", 2] }, scope)).toBe(true);
    expect(evalCond({ and: [{ status: ["a", "completed"] }, { not: { status: ["b", "completed"] } }] }, scope)).toBe(true);
    expect(evalCond({ in: ["$input.topic", ["x", "y"]] }, scope)).toBe(true);
    expect(evalCond("$nodes.a.output.items", scope)).toBe(true);
    expect(evalCond({ empty: "$nodes.b.output" }, scope)).toBe(true);
  });
  it("collects node refs", () => {
    const refs = collectNodeRefs({ prompt: "use {{ $nodes.a.output.items }} and $nodes.b.status", when: { eq: ["$nodes.c.route", "x"] } });
    expect(refs.map((r) => `${r.node}${r.path}`).sort()).toEqual(["a.output.items", "b.status", "c.route"]);
  });
});

describe("reducers", () => {
  it("dedupe / flatten / top_k report stats", () => {
    const fl = builtinReducers.flatten!({ items: [{ findings: [1, 2] }, { findings: [3] }, null] }, { path: "findings" }, { runId: "r", nodeId: "n", log() {} }) as { items: unknown[]; _stats: { in: number; out: number } };
    expect(fl.items).toEqual([1, 2, 3]);
    const dd = builtinReducers.dedupe!({ items: [{ claim: "A b" }, { claim: "a  B" }, { claim: "c" }] }, { key: ["claim"] }, { runId: "r", nodeId: "n", log() {} }) as { items: unknown[]; _stats: { in: number; out: number } };
    expect(dd.items.length).toBe(2);
    expect(dd._stats).toMatchObject({ in: 3, out: 2 });
    const tk = builtinReducers.top_k!({ items: [{ s: 1 }, { s: 3 }, { s: 2 }] }, { k: 2, by: "s" }, { runId: "r", nodeId: "n", log() {} }) as { items: Array<{ s: number }> };
    expect(tk.items.map((x) => x.s)).toEqual([3, 2]);
    const votes = builtinReducers.count_votes!({ items: [{ w: 1 }, { w: 2 }, { w: 1 }] }, { by: "w" }, { runId: "r", nodeId: "n", log() {} }) as { winner: string };
    expect(votes.winner).toBe("1");
  });
});

describe("analysis (the dependency test)", () => {
  it("derives edges from refs, flags status-only and ordering-only edges, finds cycles", () => {
    const spec = loadGraphFromObject({
      name: "t",
      budget: { max_cost_usd: 1 },
      nodes: [
        { id: "a", kind: "agent", prompt: "x {{ input.q }}", output_schema: OUT },
        { id: "b", kind: "agent", prompt: "y {{ $nodes.a.output.value }}", output_schema: OUT },
        { id: "c", kind: "agent", prompt: "z", output_schema: OUT, when: { status: ["a", "completed"] } },
        { id: "d", kind: "code", fn: "identity", after: [{ node: "b", reason: "wait for b" }] },
      ],
    }).spec;
    const a = analyze(spec);
    expect(a.ok).toBe(true);
    expect(a.edges.find((e) => e.from === "a" && e.to === "b")?.kind).toBe("data");
    expect(a.edges.find((e) => e.from === "a" && e.to === "c")?.kind).toBe("status");
    expect(a.edges.find((e) => e.from === "b" && e.to === "d")?.kind).toBe("order");
    expect(a.findings.some((f) => f.code === "status_only_edge")).toBe(true);
    expect(a.findings.some((f) => f.code === "ordering_only_edge")).toBe(true);
    expect(a.findings.some((f) => f.code === "no_inputs" && f.node === "c")).toBe(true);
    expect(a.levels[0]).toEqual(["a"]);
    expect(a.critical_path.nodes[0]).toBe("a");

    const cyc = analyze(loadGraphFromObject({ name: "c", budget: { max_cost_usd: 1 }, nodes: [{ id: "a", kind: "agent", prompt: "{{ $nodes.b.output.value }}", output_schema: OUT }, { id: "b", kind: "agent", prompt: "{{ $nodes.a.output.value }}", output_schema: OUT }] }).spec);
    expect(cyc.ok).toBe(false);
    expect(cyc.findings.some((f) => f.code === "cycle")).toBe(true);
  });
  it("enforces frozen constraints statically", () => {
    const a = analyze(loadGraphFromObject({ name: "f", nodes: [{ id: "pub", kind: "code", fn: "record", side_effect: true }] }).spec);
    expect(a.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["side_effect_without_gate", "no_spend_cap"]));
    expect(a.ok).toBe(false);
    const v = analyze(loadGraphFromObject({ name: "v", budget: { max_cost_usd: 1 }, frozen: ["verifier_can_kill"], nodes: [{ id: "a", kind: "agent", prompt: "x", output_schema: LIST }, { id: "ver", kind: "verify", target: "$nodes.a.output.items" }] }).spec);
    expect(v.findings.some((f) => f.code === "verifier_is_decoration" && f.level === "error")).toBe(true);
  });
});

describe("engine", () => {
  it("runs fork/join with fan-out, reducer, verify, auto gate and side effect; records metrics", async () => {
    const yaml = `
name: forkjoin
budget: { max_cost_usd: 5, max_width: 3 }
output: { from: final }
nodes:
  - id: plan
    kind: agent
    prompt: "plan {{ input.q }}"
    output_schema: ${JSON.stringify({ type: "object", required: ["lanes"], properties: { lanes: { type: "array", minItems: 4, maxItems: 4, items: { type: "string" } } } })}
  - id: work
    kind: agent
    model: haiku
    map: $nodes.plan.output.lanes
    max_width: 2
    failure: { quorum: 0.5 }
    prompt: "lane {{ item }}"
    output_schema: ${JSON.stringify(LIST)}
  - id: flat
    kind: code
    fn: flatten
    input: { items: $nodes.work.outputs }
    args: { path: items }
  - id: ver
    kind: verify
    target: $nodes.flat.output.items
    kill_threshold: 0.5
  - id: gate
    kind: gate
    title: ok?
    auto_approve_when: { gte: ["$nodes.ver.output.total", 1] }
    show: { n: $nodes.ver.output.total }
  - id: final
    kind: code
    fn: identity
    side_effect: true
    requires_gate: gate
    input: { survivors: $nodes.ver.survivors, killed: $nodes.ver.killed, workers: $nodes.work.count }
`;
    const { state, store } = await run(yaml, { q: "x" }, { killRate: 0.5, seed: "s1" });
    expect(state.run.status).toBe("completed");
    expect(state.nodes.work!.items!.length).toBe(4);
    expect(state.nodes.gate!.gate?.decision).toBe("auto");
    expect(state.nodes.final!.side_effect_done).toBe(true);
    const out = state.run.output as { survivors: unknown[]; killed: unknown[]; workers: { total: number } };
    expect(out.workers.total).toBe(4);
    expect(out.survivors.length + out.killed.length).toBe(state.nodes.ver!.verify!.total);
    const m = computeMetrics(state, store.readEvents(state.run.id));
    expect(m.width.peak).toBeGreaterThanOrEqual(2);
    expect(m.width.peak).toBeLessThanOrEqual(3);
    expect(m.verifier.candidates).toBeGreaterThan(0);
    expect(m.human.auto).toBe(1);
    expect(m.parallel_speedup).toBeGreaterThan(1);
  });

  it("isolates failures: continue + optional lets the join run, block fails the run, quorum degrades visibly", async () => {
    const base = (policyA: string, optional: string) => `
name: fd
budget: { max_cost_usd: 5, max_width: 4 }
nodes:
  - id: a
    kind: agent
    prompt: "a"
    output_schema: ${JSON.stringify(OUT)}
    failure: { retries: 1, ${policyA} }
  - id: b
    kind: agent
    prompt: "b"
    output_schema: ${JSON.stringify(OUT)}
  - id: join
    kind: code
    fn: merge
    ${optional}
    input: { a: $nodes.a.output, b: $nodes.b.output, a_status: $nodes.a.status }
    args: { mode: object }
`;
    const cont = await run(base("on_failure: continue", "optional: [a]"), {}, { alwaysFail: ["a"] });
    expect(cont.state.run.status).toBe("completed");
    expect(cont.state.nodes.a!.status).toBe("failed");
    expect(cont.state.nodes.a!.attempts.length).toBe(2);
    expect(cont.state.nodes.join!.status).toBe("completed");
    expect(cont.state.run.warnings?.[0]).toMatch(/degraded/);

    const skip = await run(base("on_failure: continue", ""), {}, { alwaysFail: ["a"] });
    expect(skip.state.run.status).toBe("completed");
    expect(skip.state.nodes.join!.status).toBe("skipped");

    const block = await run(base("on_failure: block", ""), {}, { alwaysFail: ["a"] });
    expect(block.state.run.status).toBe("failed");
    expect(block.state.run.error).toMatch(/node "a" failed/);

    const q = await run(
      `
name: q
budget: { max_cost_usd: 5, max_width: 4 }
nodes:
  - id: w
    kind: agent
    map: $input.items
    failure: { retries: 0, quorum: 0.5 }
    prompt: "w {{ item }}"
    output_schema: ${JSON.stringify(OUT)}
  - id: j
    kind: code
    fn: identity
    input: { n: $nodes.w.count, outs: $nodes.w.outputs }
`,
      { items: [1, 2, 3, 4] },
      { failRate: 0.45, seed: "quorum" },
    );
    const w = q.state.nodes.w!;
    const done = w.items!.filter((i) => i.status === "completed").length;
    if (done >= 2) {
      expect(q.state.run.status).toBe("completed");
      expect((q.state.run.output as { j: { n: { completed: number } } }).j.n.completed).toBe(done);
    } else {
      expect(q.state.run.status).toBe("failed");
      expect(q.state.run.error).toMatch(/quorum/);
    }
  });

  it("routes deterministically and cascades skips through unselected branches", async () => {
    const yaml = `
name: router
budget: { max_cost_usd: 5 }
nodes:
  - id: classify
    kind: code
    fn: classify_regex
    input: { text: $input.text }
    args: { path: text, rules: [{ match: "refund", label: billing }], default: other }
  - id: route
    kind: router
    routes:
      - { when: { eq: ["$nodes.classify.output.label", billing] }, route: billing, reason: "billing keyword" }
    default: other
  - id: billing_path
    kind: code
    fn: identity
    when: { eq: ["$nodes.route.output.route", billing] }
    input: { x: $nodes.classify.output }
  - id: other_path
    kind: code
    fn: identity
    when: { eq: ["$nodes.route.output.route", other] }
    input: { x: $nodes.classify.output }
  - id: after_billing
    kind: code
    fn: identity
    input: { y: $nodes.billing_path.output }
  - id: merge
    kind: code
    fn: merge
    optional: [billing_path, other_path]
    input: { a: $nodes.billing_path.output, b: $nodes.other_path.output }
    args: { mode: object }
`;
    const r = await run(yaml, { text: "I want a refund" });
    expect(r.state.run.status).toBe("completed");
    expect(r.state.nodes.route!.route).toBe("billing");
    expect(r.state.nodes.other_path!.status).toBe("skipped");
    expect(r.state.nodes.billing_path!.status).toBe("completed");
    expect(r.state.nodes.after_billing!.status).toBe("completed");
    expect(r.state.nodes.merge!.status).toBe("completed");
    expect(r.state.run.decisions.some((d) => d.kind === "route" && d.state)).toBe(true);
    const r2 = await run(yaml, { text: "hello" });
    expect(r2.state.nodes.route!.route).toBe("other");
    expect(r2.state.nodes.billing_path!.status).toBe("skipped");
    expect(r2.state.nodes.after_billing!.status).toBe("skipped");
    expect(r2.state.nodes.after_billing!.skip_reason).toMatch(/upstream "billing_path" skipped/);
  });

  it("verify repair cycle re-runs the producer with feedback, bounded by max_rounds", async () => {
    const yaml = `
name: repair
budget: { max_cost_usd: 5 }
nodes:
  - id: draft
    kind: agent
    prompt: "draft {{ input.q }}"
    output_schema: ${JSON.stringify(OUT)}
  - id: check
    kind: verify
    target: $nodes.draft.output
    kill_threshold: 0.5
    repair: { node: draft, max_rounds: 2 }
  - id: use
    kind: code
    fn: identity
    input: { ok: $nodes.check.survivors, bad: $nodes.check.killed }
`;
    const r = await run(yaml, { q: "x" }, { killRate: 1 });
    expect(r.state.run.status).toBe("completed");
    expect(r.state.nodes.check!.verify!.repair_round).toBe(2);
    expect(r.state.nodes.draft!.repair?.round).toBe(2);
    expect(r.state.nodes.draft!.attempts.length).toBe(3);
    expect(r.state.run.decisions.filter((d) => d.kind === "repair").length).toBeGreaterThanOrEqual(3);
    const art = r.store.readArtifact(r.state.run.id, r.state.nodes.draft!.attempts[2]!.artifact!) as { request: { prompt: string } };
    expect(art.request.prompt).toMatch(/repair_feedback/);
  });

  it("pauses at a human gate, resumes after approval, and never re-runs a side effect", async () => {
    const yaml = `
name: gate
budget: { max_cost_usd: 5 }
nodes:
  - id: draft
    kind: agent
    prompt: "d"
    output_schema: ${JSON.stringify(OUT)}
  - id: approve
    kind: gate
    title: publish?
    show: { d: $nodes.draft.output }
  - id: publish
    kind: code
    fn: record
    side_effect: true
    requires_gate: approve
    input: { d: $nodes.draft.output }
`;
    const first = await run(yaml);
    expect(first.state.run.status).toBe("paused");
    expect(first.state.nodes.approve!.status).toBe("waiting_approval");
    expect(first.state.nodes.publish!.status).toBe("pending");
    first.store.writeApproval(first.state.run.id, { gate: "approve", decision: "approved", by: "tester", comment: "ship", at: new Date().toISOString() });
    const resumed = GraphRunner.resume({ store: first.store, bridges: bridges(), runId: first.state.run.id, gateWait: "return" });
    const s2 = await resumed.run();
    expect(s2.run.status).toBe("completed");
    expect(s2.nodes.approve!.gate?.decision).toBe("approved");
    expect(s2.nodes.publish!.side_effect_done).toBe(true);
    const again = GraphRunner.resume({ store: first.store, bridges: bridges(), runId: first.state.run.id, gateWait: "return" });
    const s3 = await again.run();
    expect(s3.nodes.publish!.attempts.length).toBe(1);

    const rej = await run(yaml);
    rej.store.writeApproval(rej.state.run.id, { gate: "approve", decision: "rejected", by: "tester", comment: "no", at: new Date().toISOString() });
    const s4 = await GraphRunner.resume({ store: rej.store, bridges: bridges(), runId: rej.state.run.id, gateWait: "return" }).run();
    expect(s4.run.status).toBe("failed");
    expect(s4.run.error).toMatch(/rejected/);
    expect(s4.nodes.publish!.status).not.toBe("completed");
  });

  it("enforces the spend cap as a frozen constraint", async () => {
    const yaml = `
name: cap
budget: { max_cost_usd: 0.001, max_width: 2 }
nodes:
  - id: w
    kind: agent
    map: $input.items
    prompt: "w {{ item }}"
    output_schema: ${JSON.stringify(OUT)}
`;
    const r = await run(yaml, { items: [1, 2, 3, 4, 5, 6] });
    expect(r.state.run.status).toBe("failed");
    expect(r.state.run.error).toMatch(/spend cap/);
  });

  it("bounded discovery loop converges on no new findings and dedupes against everything seen", async () => {
    const yaml = `
name: loop
budget: { max_cost_usd: 5 }
nodes:
  - id: discover
    kind: loop
    input: { q: $input.q }
    collect: $output.items
    seen_key: key
    until: { max_rounds: 5, no_new_for_rounds: 2 }
    body:
      name: round
      budget: { max_cost_usd: 1 }
      output: { from: search }
      nodes:
        - id: search
          kind: agent
          prompt: "round {{ input.round }} seen {{ json input.seen }}"
          output_schema: ${JSON.stringify({ type: "object", required: ["items"], properties: { items: { type: "array", minItems: 2, maxItems: 2, items: { type: "object", required: ["key"], properties: { key: { type: "string", enum: ["k1", "k2", "k3"] } } } } } })}
`;
    const r = await run(yaml, { q: "x" }, { seed: "loop" });
    expect(r.state.run.status).toBe("completed");
    const loop = r.state.nodes.discover!.loop!;
    expect(loop.rounds).toBeLessThanOrEqual(5);
    expect(loop.collected).toBeLessThanOrEqual(3);
    const out = r.state.run.output as { discover: { items: Array<{ key: string }>; seen: string[] } };
    expect(new Set(out.discover.items.map((i) => i.key)).size).toBe(out.discover.items.length);
    expect(r.store.list().some((s) => s.parent?.node_id === "discover")).toBe(true);
  });

  it("repairs schema-invalid output before giving up", async () => {
    const yaml = `
name: rep
budget: { max_cost_usd: 5 }
defaults: { failure: { retries: 0, repair_attempts: 1 } }
nodes:
  - id: a
    kind: agent
    prompt: "x"
    output_schema: ${JSON.stringify(OUT)}
`;
    const r = await run(yaml, {}, { invalidRate: 1, seed: "inv" });
    expect(r.state.run.status).toBe("completed");
    expect(r.state.nodes.a!.repairs).toBe(1);
    expect(r.state.nodes.a!.attempts.length).toBe(1);
  });

  it("subgraphs run as nested runs and return their output", async () => {
    const yaml = `
name: parent
budget: { max_cost_usd: 5 }
nodes:
  - id: child
    kind: subgraph
    input: { q: $input.q }
    graph:
      name: kid
      budget: { max_cost_usd: 1 }
      output: { from: a }
      nodes:
        - id: a
          kind: agent
          prompt: "{{ input.q }}"
          output_schema: ${JSON.stringify(OUT)}
  - id: use
    kind: code
    fn: identity
    input: { v: $nodes.child.output.value }
`;
    const r = await run(yaml, { q: "hi" });
    expect(r.state.run.status).toBe("completed");
    expect(typeof (r.state.run.output as { use: { v: string } }).use.v).toBe("string");
  });
});

describe("inbox bridge (orchestrator mode)", () => {
  it("emits tasks, waits for an external worker, validates and continues", async () => {
    const { InboxBridge } = await import("../src/bridges/inbox.js");
    const { generateFromSchema } = await import("../src/bridges/mock.js");
    const store = new RunStore(path.join(tmp, "runs-inbox"));
    const reg = new BridgeRegistry();
    reg.register(new InboxBridge({ pollMs: 50, minTimeoutMs: 10_000 }));
    const spec = parseSpecText(`
name: inbox
budget: { max_cost_usd: 5, max_width: 2 }
output: { from: join }
nodes:
  - id: w
    kind: agent
    map: $input.items
    failure: { retries: 0, quorum: 1 }
    prompt: "w {{ item }}"
    output_schema: ${JSON.stringify(OUT)}
  - id: join
    kind: code
    fn: identity
    input: { n: $nodes.w.count, outs: $nodes.w.outputs }
`);
    const runner = GraphRunner.create({ store, bridges: reg, spec, specFile: "<test>", input: { items: [1, 2, 3] }, bridge: "inbox", gateWait: "return" });
    const done: string[] = [];
    // external worker: poll the inbox, submit a schema-valid result for each pending task (first one with a wrong shape to exercise engine-side validation)
    let first = true;
    const worker = setInterval(() => {
      for (const t of store.listTasksDeep(runner.id)) {
        if (done.includes(t.task_id)) continue;
        done.push(t.task_id);
        const output = first ? { wrong: true } : generateFromSchema(t.output_schema, () => 0.4, { node: t.node_id });
        first = false;
        store.writeTaskResult(t.run_id, { task_id: t.task_id, output, source: "human", worker: "test", completed_at: new Date().toISOString() });
      }
    }, 60);
    const state = await runner.run();
    clearInterval(worker);
    // the first (invalid) result is caught by engine-side validation and repaired through a second task (repair_attempts=1)
    expect(state.run.status).toBe("completed");
    expect(state.nodes.w!.items!.filter((i) => i.status === "completed").length).toBe(3);
    expect(state.nodes.w!.repairs).toBe(1);
    expect(store.listTasks(runner.id).every((t) => t.status === "completed" || t.status === "cancelled")).toBe(true);
    const evs = store.readEvents(runner.id);
    expect(evs.filter((e) => e.type === "task.created").length).toBe(4);
    expect(evs.some((e) => e.type === "call.invalid_output")).toBe(true);
    expect(evs.some((e) => e.type === "task.completed" && e.data?.source === "human")).toBe(true);
  });
});
