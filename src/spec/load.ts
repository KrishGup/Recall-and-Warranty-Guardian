/** Load a graph spec from YAML/JSON, validate it, resolve subgraph files, and apply defaults. */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { GraphSpecZ, type GraphSpec, type NodeSpec } from "./schema.js";

export interface LoadedGraph {
  spec: GraphSpec;
  /** Absolute path of the spec file (or "<inline>"). */
  file: string;
  /** Directory used to resolve `module:` and `graph:` paths. */
  dir: string;
}

export class SpecError extends Error {
  constructor(
    message: string,
    public issues: string[] = [],
  ) {
    super(message);
  }
}

export function parseSpecText(text: string, file = "<inline>"): GraphSpec {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new SpecError(`${file}: could not parse YAML/JSON: ${(e as Error).message}`);
  }
  return validateSpecObject(raw, file);
}

export function validateSpecObject(raw: unknown, file = "<inline>"): GraphSpec {
  const res = GraphSpecZ.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    throw new SpecError(`${file}: invalid graph spec (${issues.length} issue${issues.length === 1 ? "" : "s"})`, issues);
  }
  return res.data;
}

export function loadGraph(file: string, seen: Set<string> = new Set()): LoadedGraph {
  const abs = path.resolve(file);
  if (seen.has(abs)) throw new SpecError(`subgraph cycle: ${abs} includes itself`);
  seen.add(abs);
  if (!fs.existsSync(abs)) throw new SpecError(`spec file not found: ${abs}`);
  const text = fs.readFileSync(abs, "utf8");
  const spec = parseSpecText(text, abs);
  const dir = path.dirname(abs);
  resolveNested(spec, dir, seen);
  return { spec, file: abs, dir };
}

export function loadGraphFromObject(raw: unknown, dir = process.cwd()): LoadedGraph {
  const spec = validateSpecObject(raw);
  resolveNested(spec, dir, new Set());
  return { spec, file: "<inline>", dir };
}

/** Inline `graph: ./file.yaml` subgraphs and make module paths absolute so nested runs don't depend on cwd. */
function resolveNested(spec: GraphSpec, dir: string, seen: Set<string>) {
  for (const node of spec.nodes as NodeSpec[]) {
    if (node.kind === "subgraph" && typeof node.graph === "string") {
      const sub = loadGraph(path.resolve(dir, node.graph), new Set(seen));
      node.graph = sub.spec;
    } else if (node.kind === "subgraph") {
      resolveNested(node.graph as GraphSpec, dir, seen);
    }
    if (node.kind === "loop") resolveNested(node.body, dir, seen);
    if ((node.kind === "code" || node.kind === "verify") && node.module && !path.isAbsolute(node.module)) {
      node.module = path.resolve(dir, node.module);
    }
  }
}

export function nodeById(spec: GraphSpec, id: string): NodeSpec | undefined {
  return spec.nodes.find((n) => n.id === id);
}
