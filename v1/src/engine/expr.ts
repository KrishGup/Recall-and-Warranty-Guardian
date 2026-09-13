/**
 * Reference resolution, templating and the deterministic condition DSL.
 *
 * References are the ONLY way data crosses an edge:
 *   $input.topic                 graph input
 *   $nodes.<id>.output.path      a node's structured output
 *   $nodes.<id>.outputs          successful item outputs of a map node (array)
 *   $nodes.<id>.items            per-item records {index,status,output,error}
 *   $nodes.<id>.status           completed | failed | skipped ...
 *   $nodes.<id>.survivors/.killed/.kill_rate   verify nodes
 *   $nodes.<id>.route            router nodes
 *   $item / $index               inside a map or verify fan-out
 *   $loop.round/.seen/.collected/.prev          inside a loop body (also on $input)
 *   $repair.round/.feedback      when a producer is re-run by a verify repair cycle
 *   $run.id / $graph.name
 *
 * Templates: "{{ $nodes.a.output.title }}" - non-strings are inserted as pretty JSON.
 * The model can be fuzzy inside the box; the interface around the box stays strict.
 */
import type { Cond } from "../spec/schema.js";

export interface NodeView {
  status: string;
  output?: unknown;
  outputs?: unknown[];
  items?: Array<{ index: number; status: string; output?: unknown; error?: string }>;
  survivors?: unknown[];
  killed?: unknown[];
  kill_rate?: number;
  route?: string;
  error?: string;
  count?: { total: number; completed: number; failed: number };
  feedback?: unknown;
}

export interface Scope {
  input: unknown;
  nodes: Record<string, NodeView | undefined>;
  item?: unknown;
  index?: number;
  loop?: unknown;
  repair?: unknown;
  run?: { id: string };
  graph?: { name: string };
  env?: Record<string, string | undefined>;
  /** Only inside loop `collect` expressions: the body graph's output. */
  output?: unknown;
}

const REF_RE = /^\$(input|nodes|item|index|loop|repair|run|graph|env|output)(?=$|[.\[])/;
const TEMPLATE_RE = /\{\{\s*(json\s+)?([^{}]+?)\s*\}\}/g;

export function isRef(v: unknown): boolean {
  return typeof v === "string" && REF_RE.test(v.trim());
}

/** Parse "$nodes.a.output.items[0].title" into ["nodes","a","output","items","0","title"]. */
export function parsePath(ref: string): string[] {
  const s = ref.trim().replace(/^\$/, "");
  const out: string[] = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push((m[1] ?? m[2])!);
  return out;
}

export class RefError extends Error {
  constructor(
    public ref: string,
    message: string,
  ) {
    super(message);
  }
}

export function resolveRef(ref: string, scope: Scope, opts: { strict?: boolean } = {}): unknown {
  const path = parsePath(ref);
  const root = path.shift();
  let cur: unknown;
  switch (root) {
    case "input":
      cur = scope.input;
      break;
    case "nodes":
      cur = scope.nodes;
      break;
    case "item":
      cur = scope.item;
      break;
    case "index":
      cur = scope.index;
      break;
    case "loop":
      cur = scope.loop;
      break;
    case "repair":
      cur = scope.repair;
      break;
    case "run":
      cur = scope.run;
      break;
    case "graph":
      cur = scope.graph;
      break;
    case "env":
      cur = scope.env ?? {};
      break;
    case "output":
      cur = scope.output;
      break;
    default:
      throw new RefError(ref, `unknown reference root in ${ref}`);
  }
  for (const seg of path) {
    if (cur === null || cur === undefined) {
      if (opts.strict) throw new RefError(ref, `cannot resolve ${ref}: hit undefined at "${seg}"`);
      return undefined;
    }
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else {
      if (opts.strict) throw new RefError(ref, `cannot resolve ${ref}: "${seg}" on a ${typeof cur}`);
      return undefined;
    }
  }
  return cur;
}

function stringify(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

/** Render a {{ }} template. `{{ json $ref }}` forces JSON. Bare paths like `input.topic` are treated as `$input.topic`. */
export function renderTemplate(tpl: string, scope: Scope): string {
  return tpl.replace(TEMPLATE_RE, (_m, jsonFlag: string | undefined, exprRaw: string) => {
    const expr = exprRaw.trim();
    const ref = expr.startsWith("$") ? expr : `$${expr}`;
    if (!isRef(ref)) return _m; // leave unknown braces untouched (e.g. JSON examples in prompts)
    const v = resolveRef(ref, scope);
    return jsonFlag ? JSON.stringify(v, null, 2) : stringify(v);
  });
}

/** Deep-resolve a mapping: refs become values; strings with templates are rendered. */
export function resolveValue(v: unknown, scope: Scope): unknown {
  if (typeof v === "string") {
    if (isRef(v)) return resolveRef(v, scope);
    if (v.includes("{{")) return renderTemplate(v, scope);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, scope));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = resolveValue(x, scope);
    return out;
  }
  return v;
}

function val(x: unknown, scope: Scope): unknown {
  return isRef(x) ? resolveRef(x as string, scope) : x;
}

export function evalCond(c: Cond | undefined, scope: Scope): boolean {
  if (c === undefined) return true;
  if (typeof c === "boolean") return c;
  if (typeof c === "string") return truthy(val(c, scope));
  const o = c as Record<string, unknown>;
  if ("eq" in o) {
    const [a, b] = o.eq as [unknown, unknown];
    return looseEq(val(a, scope), val(b, scope));
  }
  if ("neq" in o) {
    const [a, b] = o.neq as [unknown, unknown];
    return !looseEq(val(a, scope), val(b, scope));
  }
  if ("gt" in o) {
    const [a, b] = o.gt as [unknown, unknown];
    return Number(val(a, scope)) > Number(val(b, scope));
  }
  if ("gte" in o) {
    const [a, b] = o.gte as [unknown, unknown];
    return Number(val(a, scope)) >= Number(val(b, scope));
  }
  if ("lt" in o) {
    const [a, b] = o.lt as [unknown, unknown];
    return Number(val(a, scope)) < Number(val(b, scope));
  }
  if ("lte" in o) {
    const [a, b] = o.lte as [unknown, unknown];
    return Number(val(a, scope)) <= Number(val(b, scope));
  }
  if ("in" in o) {
    const [a, b] = o.in as [unknown, unknown];
    const arr = val(b, scope);
    const needle = val(a, scope);
    return Array.isArray(arr) && arr.some((x) => looseEq(x, needle));
  }
  if ("contains" in o) {
    const [a, b] = o.contains as [unknown, unknown];
    const hay = val(a, scope);
    const needle = val(b, scope);
    if (Array.isArray(hay)) return hay.some((x) => looseEq(x, needle));
    if (typeof hay === "string") return hay.includes(String(needle));
    return false;
  }
  if ("matches" in o) {
    const [a, re] = o.matches as [unknown, string];
    return safeMatch(String(re), String(val(a, scope) ?? ""));
  }
  if ("exists" in o) {
    const v = val(o.exists, scope);
    return v !== undefined && v !== null;
  }
  if ("empty" in o) {
    const v = val(o.empty, scope);
    return (
      v === undefined ||
      v === null ||
      v === "" ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === "object" && Object.keys(v as object).length === 0)
    );
  }
  if ("truthy" in o) return truthy(val(o.truthy, scope));
  if ("status" in o) {
    const [id, st] = o.status as [string, string];
    return scope.nodes[id]?.status === st;
  }
  if ("and" in o) return (o.and as Cond[]).every((x) => evalCond(x, scope));
  if ("or" in o) return (o.or as Cond[]).some((x) => evalCond(x, scope));
  if ("not" in o) return !evalCond(o.not as Cond, scope);
  throw new Error(`unknown condition ${JSON.stringify(c)}`);
}

const MAX_REGEX_PATTERN = 512;
const MAX_REGEX_INPUT = 20_000;
const regexCache = new Map<string, RegExp>();

/**
 * Regex matching with ReDoS guards (audit finding): patterns are length-capped, nested quantifiers are refused,
 * inputs are truncated, and compiled patterns are cached.
 */
export function safeMatch(pattern: string, input: string, flags = ""): boolean {
  if (pattern.length > MAX_REGEX_PATTERN) throw new Error(`regex pattern longer than ${MAX_REGEX_PATTERN} chars`);
  if (/(\([^)]*[+*][^)]*\)[+*{])|(\[[^\]]*\][+*]\)?[+*])/.test(pattern)) throw new Error(`regex pattern "${pattern.slice(0, 60)}" has nested quantifiers (catastrophic backtracking risk)`);
  const key = `${flags}/${pattern}`;
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(pattern, flags);
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(key, re);
  }
  return re.test(input.length > MAX_REGEX_INPUT ? input.slice(0, MAX_REGEX_INPUT) : input);
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- static scanning (dependency derivation) ----------

const NODE_REF_RE = /\$nodes\.([a-zA-Z_][a-zA-Z0-9_\-]*)((?:\.[a-zA-Z0-9_\-]+|\[\d+\])*)/g;
/** Template form without the `$`: {{ nodes.a.output.x }} / {{ json nodes.a.outputs }} - the same dependency. */
const TEMPLATE_NODE_REF_RE = /\{\{\s*(?:json\s+)?nodes\.([a-zA-Z_][a-zA-Z0-9_\-]*)((?:\.[a-zA-Z0-9_\-]+|\[\d+\])*)\s*\}\}/g;

export interface FoundRef {
  node: string;
  /** e.g. ".output.items" or ".status" */
  path: string;
  /** where it was found (field name) */
  field: string;
}

/** Walk any value and collect every `$nodes.<id>...` reference with the field it lives in. */
export function collectNodeRefs(value: unknown, field = ""): FoundRef[] {
  const out: FoundRef[] = [];
  const walk = (v: unknown, f: string) => {
    if (typeof v === "string") {
      let m: RegExpExecArray | null;
      const re = new RegExp(NODE_REF_RE.source, "g");
      while ((m = re.exec(v))) out.push({ node: m[1]!, path: m[2] ?? "", field: f });
      const tre = new RegExp(TEMPLATE_NODE_REF_RE.source, "g");
      while ((m = tre.exec(v))) out.push({ node: m[1]!, path: m[2] ?? "", field: f });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${f}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, f ? `${f}.${k}` : k);
  };
  walk(value, field);
  return out;
}

/** Find `{ status: [nodeId, status] }` conditions - they are status-only dependencies too. */
export function collectStatusConds(value: unknown, field = ""): FoundRef[] {
  const out: FoundRef[] = [];
  const walk = (v: unknown, f: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${f}[${i}]`));
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.status) && typeof o.status[0] === "string" && Object.keys(o).length === 1) out.push({ node: o.status[0], path: ".status", field: f });
      for (const [k, x] of Object.entries(o)) walk(x, f ? `${f}.${k}` : k);
    }
  };
  walk(value, field);
  return out;
}

export function usesInput(value: unknown): boolean {
  let found = false;
  const walk = (v: unknown) => {
    if (found) return;
    if (typeof v === "string") {
      if (/\$(input|item|loop|repair)\b/.test(v) || /\{\{\s*(json\s+)?(input|item|loop|repair)\b/.test(v)) found = true;
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return found;
}
