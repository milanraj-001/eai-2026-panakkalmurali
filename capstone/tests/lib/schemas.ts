/**
 * The JSON Schemas in grading/schema/ (README §3.5, §4) and the canonical
 * order schema, compiled once. `valid(name, value)` returns null, or the
 * errors in a line.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import AjvModule, { type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import { CANONICAL_SCHEMA, SCHEMA_DIR } from "./targets.js";

// ajv and ajv-formats are CommonJS; their default export arrives wrapped.
const Ajv = AjvModule as unknown as typeof AjvModule.default;
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;

export type SchemaName =
  | "order-status"
  | "outcome-event"
  | "trace"
  | "trace-hop"
  | "ops-metrics"
  | "dlq-list"
  | "idempotency-store"
  | "saga-store"
  | "processed-ids"
  | "canonical";

let ajv: InstanceType<typeof Ajv> | undefined;
const compiled = new Map<SchemaName, ValidateFunction>();

function load(): InstanceType<typeof Ajv> {
  if (ajv) return ajv;
  ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(readFileSync(path.join(SCHEMA_DIR, file), "utf8")), file.replace(/\.schema\.json$/, ""));
  }
  ajv.addSchema(JSON.parse(readFileSync(CANONICAL_SCHEMA, "utf8")), "canonical");
  return ajv;
}

/** null when `value` is valid against the schema, otherwise its errors. */
export function valid(name: SchemaName, value: unknown): string | null {
  let validate = compiled.get(name);
  if (!validate) {
    validate = load().getSchema(name);
    if (!validate) throw new Error(`no schema ${name} in ${SCHEMA_DIR}`);
    compiled.set(name, validate);
  }
  return validate(value) ? null : load().errorsText(validate.errors, { dataVar: name === "canonical" ? "event" : "body" });
}
