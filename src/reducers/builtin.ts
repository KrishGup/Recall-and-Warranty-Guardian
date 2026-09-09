/**
 * Built-in deterministic reducers. "Use models for ambiguity. Use code for plumbing."
 *
 * Each reducer is `(input, args, ctx) => output`. Input is the node's resolved `input` mapping.
 * Every reducer reports `_stats` so the compression ratio metric is real, not guessed.
 */
export interface ReducerCtx {
  runId: string;
  nodeId: string;
  log: (msg: string) => void;
}
export type Reducer = (input: Record<string, unknown>, args: Record<string, unknown>, ctx: ReducerCtx) => unknown | Promise<unknown>;

function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

/** Take the first array-valued input (or `args.from`). Reducers are usually wired as `input: { items: $nodes.x.outputs }`. */
function items(input: Record<string, unknown>, args: Record<string, unknown>): unknown[] {
  if (typeof args.from === "string") return asArray(input[args.from]);
  if ("items" in input) return asArray(input.items);
  const firstArr = Object.values(input).find(Array.isArray);
  return firstArr ? (firstArr as unknown[]) : [];
}

function normKey(v: unknown): string {
  if (typeof v === "string") return v.trim().toLowerCase().replace(/\s+/g, " ");
  return JSON.stringify(v);
}

export const builtinReducers: Record<string, Reducer> = {
  /** Flatten nested arrays (e.g. each worker returns {items:[...]}) -> one array. args: { path?: "items", depth?: 1 } */
  flatten(input, args) {
    const src = items(input, args);
    const path = typeof args.path === "string" ? args.path : undefined;
    const out: unknown[] = [];
    for (const it of src) {
      const v = path ? getPath(it, path) : it;
      if (Array.isArray(v)) out.push(...v);
      else if (v !== undefined && v !== null) out.push(v);
    }
    return { items: out, _stats: { in: src.length, out: out.length } };
  },

  /** Drop null/undefined/malformed records. args: { require?: ["claim","source"] } */
  filter_nulls(input, args) {
    const src = items(input, args);
    const req = Array.isArray(args.require) ? (args.require as string[]) : [];
    const out = src.filter((x) => {
      if (x === null || x === undefined) return false;
      if (req.length && (typeof x !== "object" || req.some((k) => (x as Record<string, unknown>)[k] === undefined || (x as Record<string, unknown>)[k] === null || (x as Record<string, unknown>)[k] === ""))) return false;
      return true;
    });
    return { items: out, dropped: src.length - out.length, _stats: { in: src.length, out: out.length } };
  },

  /** Exact/normalized de-duplication. args: { key?: "source_url" | ["claim","source"], keep?: "first"|"last" } */
  dedupe(input, args) {
    const src = items(input, args);
    const keys = args.key === undefined ? undefined : Array.isArray(args.key) ? (args.key as string[]) : [String(args.key)];
    const keep = args.keep === "last" ? "last" : "first";
    const map = new Map<string, unknown>();
    for (const it of src) {
      const k = keys ? keys.map((p) => normKey(getPath(it, p))).join("|") : normKey(it);
      if (keep === "first" && map.has(k)) continue;
      map.set(k, it);
    }
    const out = [...map.values()];
    return { items: out, removed: src.length - out.length, _stats: { in: src.length, out: out.length, compression: src.length ? Number((1 - out.length / src.length).toFixed(3)) : 0 } };
  },

  /** Sort by a path. args: { by: "confidence", order?: "asc"|"desc" } */
  sort(input, args) {
    const src = [...items(input, args)];
    const by = String(args.by ?? "");
    const dir = args.order === "asc" ? 1 : -1;
    src.sort((a, b) => {
      const va = getPath(a, by);
      const vb = getPath(b, by);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va ?? "").localeCompare(String(vb ?? "")) * dir;
    });
    return { items: src, _stats: { in: src.length, out: src.length } };
  },

  /** Keep the top k. args: { k: 10, by?: "score" } */
  top_k(input, args) {
    let src = [...items(input, args)];
    const k = Number(args.k ?? 10);
    if (typeof args.by === "string") {
      const by = args.by;
      src.sort((a, b) => Number(getPath(b, by) ?? 0) - Number(getPath(a, by) ?? 0));
    }
    const out = src.slice(0, k);
    return { items: out, _stats: { in: src.length, out: out.length } };
  },

  /** Group by a path. args: { by: "source" } */
  group_by(input, args) {
    const src = items(input, args);
    const by = String(args.by ?? "");
    const groups: Record<string, unknown[]> = {};
    for (const it of src) {
      const k = String(getPath(it, by) ?? "unknown");
      (groups[k] ??= []).push(it);
    }
    return { groups, keys: Object.keys(groups), _stats: { in: src.length, out: Object.keys(groups).length } };
  },

  /** Count votes over a path (tournament / judges). args: { by: "winner" } */
  count_votes(input, args) {
    const src = items(input, args);
    const by = String(args.by ?? "");
    const counts: Record<string, number> = {};
    for (const it of src) {
      const k = String(getPath(it, by) ?? "");
      if (!k) continue;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return { counts, ranked: ranked.map(([key, votes]) => ({ key, votes })), winner: ranked[0]?.[0] ?? null, total: src.length, _stats: { in: src.length, out: ranked.length } };
  },

  /** Normalize labels via a map. args: { path: "label", map: { "hi": "high" }, lower?: true } */
  normalize_labels(input, args) {
    const src = items(input, args);
    const path = String(args.path ?? "label");
    const map = (args.map ?? {}) as Record<string, string>;
    const lower = args.lower !== false;
    const out = src.map((it) => {
      if (!it || typeof it !== "object") return it;
      const rec = { ...(it as Record<string, unknown>) };
      const v = rec[path];
      if (typeof v === "string") {
        const key = lower ? v.trim().toLowerCase() : v.trim();
        rec[path] = map[key] ?? key;
      }
      return rec;
    });
    return { items: out, _stats: { in: src.length, out: out.length } };
  },

  /** Filter by a simple predicate. args: { path: "confidence", op: ">=", value: 0.6 } */
  filter(input, args) {
    const src = items(input, args);
    const path = String(args.path ?? "");
    const op = String(args.op ?? "==");
    const value = args.value;
    const test = (v: unknown): boolean => {
      switch (op) {
        case "==": return v == value; // eslint-disable-line eqeqeq
        case "!=": return v != value; // eslint-disable-line eqeqeq
        case ">": return Number(v) > Number(value);
        case ">=": return Number(v) >= Number(value);
        case "<": return Number(v) < Number(value);
        case "<=": return Number(v) <= Number(value);
        case "in": return Array.isArray(value) && value.includes(v);
        case "exists": return v !== undefined && v !== null && v !== "";
        case "matches": return new RegExp(String(value)).test(String(v ?? ""));
        default: throw new Error(`filter: unknown op ${op}`);
      }
    };
    const out = src.filter((it) => test(getPath(it, path)));
    return { items: out, dropped: src.length - out.length, _stats: { in: src.length, out: out.length } };
  },

  /** Pick fields from each record. args: { fields: ["claim","source"] } */
  pick(input, args) {
    const src = items(input, args);
    const fields = (args.fields ?? []) as string[];
    const out = src.map((it) => {
      if (!it || typeof it !== "object") return it;
      const o: Record<string, unknown> = {};
      for (const f of fields) o[f] = (it as Record<string, unknown>)[f];
      return o;
    });
    return { items: out, _stats: { in: src.length, out: out.length } };
  },

  /** Merge several arrays/objects from the input mapping into one. args: { mode?: "concat"|"object" } */
  merge(input, args) {
    if (args.mode === "object") {
      const out: Record<string, unknown> = {};
      for (const v of Object.values(input)) if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, v);
      return out;
    }
    const out: unknown[] = [];
    for (const v of Object.values(input)) out.push(...asArray(v));
    return { items: out, _stats: { in: out.length, out: out.length } };
  },

  /** Pass the input through (useful to snapshot state or rename). */
  identity(input) {
    return input;
  },

  /** Summarize fan-out completion: how many workers produced how many unique records. args: { key?: "source_url" } */
  coverage(input, args) {
    const records = items(input, args);
    const key = typeof args.key === "string" ? args.key : undefined;
    const uniq = new Set(records.map((r) => (key ? normKey(getPath(r, key)) : normKey(r))));
    const workers = Number(input.workers ?? 0);
    return {
      records: records.length,
      unique: uniq.size,
      workers,
      unique_per_worker: workers ? Number((uniq.size / workers).toFixed(2)) : null,
      _stats: { in: records.length, out: uniq.size },
    };
  },

  /** Deterministic string template from input. args: { template: "..." } with {{key}} placeholders (input keys only). */
  template(input, args) {
    const tpl = String(args.template ?? "");
    const text = tpl.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, k: string) => {
      const v = getPath(input, k);
      return typeof v === "string" ? v : JSON.stringify(v, null, 2);
    });
    return { text };
  },

  /** Deterministic schema/shape check used by verify nodes in code mode. args: { require: ["claim","source_url"], min_len?: {claim: 10} } */
  check_fields(input, args) {
    const item = input.item ?? input;
    const req = (args.require ?? []) as string[];
    const minLen = (args.min_len ?? {}) as Record<string, number>;
    const reasons: string[] = [];
    for (const k of req) {
      const v = getPath(item, k);
      if (v === undefined || v === null || v === "") reasons.push(`missing field "${k}"`);
    }
    for (const [k, n] of Object.entries(minLen)) {
      const v = getPath(item, k);
      if (typeof v === "string" && v.length < n) reasons.push(`"${k}" shorter than ${n} chars`);
    }
    return { verdict: reasons.length ? "kill" : "pass", reasons, confidence: reasons.length ? 1 : 0 };
  },

  /** Cheap first rung of an escalation ladder: keyword/regex classifier. args: { path, rules: [{match, label}], default } */
  classify_regex(input, args) {
    const text = String(getPath(input, String(args.path ?? "text")) ?? "");
    const rules = (args.rules ?? []) as Array<{ match: string; label: string }>;
    for (const r of rules) if (new RegExp(r.match, "i").test(text)) return { label: r.label, matched: r.match, confidence: 0.9 };
    return { label: String(args.default ?? "unknown"), matched: null, confidence: 0.3 };
  },

  /** Emit a structured failure/ok record - useful as a terminal "publish" placeholder in examples. */
  record(input, args) {
    return { recorded: true, at: new Date().toISOString(), payload: input, note: args.note ?? null };
  },
};

export function getReducer(name: string): Reducer {
  const r = builtinReducers[name];
  if (!r) throw new Error(`unknown built-in reducer "${name}". Available: ${Object.keys(builtinReducers).join(", ")}`);
  return r;
}
