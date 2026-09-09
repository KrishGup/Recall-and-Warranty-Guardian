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
