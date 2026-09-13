/** JSON-schema validation of everything that crosses an edge (Ajv, compiled once per schema). */
import * as AjvModule from "ajv";
import type { ValidateFunction } from "ajv";
import * as AjvFormatsModule from "ajv-formats";

type AjvInstance = { compile(schema: Record<string, unknown>): ValidateFunction };
type AjvConstructor = new (opts?: Record<string, unknown>) => AjvInstance;

// ajv / ajv-formats are CommonJS; depending on the loader the class arrives as the module or as `.default`.
const unwrap = <T>(m: unknown): T => ((m as { default?: unknown }).default ?? m) as T;
const AjvClass = unwrap<AjvConstructor>(AjvModule);
let addFormats: unknown = unwrap<unknown>(AjvFormatsModule);
if (typeof addFormats !== "function") addFormats = unwrap<unknown>(addFormats);

const ajv = new AjvClass({ allErrors: true, strict: false, allowUnionTypes: true });
(addFormats as (a: AjvInstance) => void)(ajv);
const cache = new Map<string, ValidateFunction>();

export function compile(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = cache.get(key);
  if (cached) return cached;
  const fn = ajv.compile(schema);
  cache.set(key, fn);
  return fn;
}

/** Fill in `default` values declared in an object schema (top-level and nested objects). Does not mutate the input. */
export function applyDefaults(schema: Record<string, unknown> | undefined, value: unknown): unknown {
  if (!schema) return value;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (value === undefined && "default" in schema) return structuredClone(schema.default);
  if (type === "object" && schema.properties && typeof schema.properties === "object") {
    const src = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const out: Record<string, unknown> = { ...src };
    for (const [k, sub] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
      const v = applyDefaults(sub, src[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (type === "array" && Array.isArray(value) && schema.items && typeof schema.items === "object") {
    return value.map((v) => applyDefaults(schema.items as Record<string, unknown>, v));
  }
  return value;
}

export function validateAgainst(schema: Record<string, unknown> | undefined, value: unknown): { ok: boolean; errors: string[] } {
  if (!schema || Object.keys(schema).length === 0) return { ok: true, errors: [] };
  let fn: ValidateFunction;
  try {
    fn = compile(schema);
  } catch (e) {
    return { ok: false, errors: [`invalid JSON schema: ${(e as Error).message}`] };
  }
  const ok = fn(value);
  if (ok) return { ok: true, errors: [] };
  const errors = (fn.errors ?? []).map(
    (e) => `${e.instancePath || "<root>"} ${e.message ?? "invalid"}${e.params && Object.keys(e.params).length ? ` (${JSON.stringify(e.params)})` : ""}`,
  );
  return { ok: false, errors };
}
