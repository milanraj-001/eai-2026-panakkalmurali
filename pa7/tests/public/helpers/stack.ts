/**
 * Helpers for the PA7 public tests: the api, the four mocks, the audit
 * mirror on disk, and the docker CLI.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ajv2020Module from "ajv/dist/2020.js";
import ajvFormatsModule from "ajv-formats";

// tests/public/helpers -> pa7/
export const PA7_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const API_URL = process.env.API_URL ?? "http://localhost:3000";
export const TEMPORAL_UI_URL = process.env.TEMPORAL_UI_URL ?? "http://localhost:8233";
export const PAYMENT_URL = process.env.PAYMENT_URL ?? "http://localhost:4001";
export const INVENTORY_URL = process.env.INVENTORY_URL ?? "http://localhost:4002";
export const SHIPPING_URL = process.env.SHIPPING_URL ?? "http://localhost:4003";
export const NOTIFICATION_URL = process.env.NOTIFICATION_URL ?? "http://localhost:4004";
export const WORKER_CONTAINER = "pa7-worker";

export const FORWARD_STEPS = ["payment", "inventory", "shipping", "notification"];

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(condition: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(200);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

// ------------------------------------------------------------------ orders --

export interface Order {
  orderId: string;
  customer: { email: string };
  items: Array<{ quantity: number; unitPrice: string }>;
  [field: string]: unknown;
}

// A canonical order: 2 x "22.50" + 1 x "18.90" = "63.90".
const FIXTURE: Order = JSON.parse(readFileSync(path.join(PA7_ROOT, "tests", "public", "fixtures", "order.json"), "utf8"));

let counter = 0;
function unique(): string {
  counter += 1;
  return `${Date.now()}-${counter}`;
}

export function makeOrder(): Order {
  return { ...structuredClone(FIXTURE), orderId: `WEB-PA7-${unique()}` };
}

export function newKey(label: string): string {
  return `pa7-${label}-${unique()}`;
}

/** unitPrice x quantity summed in whole cents, as a two-digit decimal string. */
export function expectedAmount(order: Order): string {
  let cents = 0;
  for (const item of order.items) {
    const [whole, fraction] = item.unitPrice.split(".");
    cents += (Number(whole) * 100 + Number(fraction)) * item.quantity;
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

// --------------------------------------------------------------------- api --

export interface Reply {
  status: number;
  body: any;
}

export async function checkout(order: unknown, key: string): Promise<Reply> {
  const res = await fetch(`${API_URL}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(order),
    signal: AbortSignal.timeout(80_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave it as text; the assertion message will show it
  }
  return { status: res.status, body };
}

/** Fails with the response body in the message, so you can see why. */
export function expectResponse(reply: Reply, status: number): void {
  if (reply.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${reply.status}: ${JSON.stringify(reply.body)}`);
  }
}

export function stepNames(trace: Array<{ step: string }> | undefined): string[] {
  return (trace ?? []).map((t) => t.step);
}

export async function httpStatusOf(url: string): Promise<number> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(10_000) })).status;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------- mocks --

export interface LogEntry {
  seq: number;
  at: string;
  action: string;
  outcome: string;
  amount?: string | null;
  recipient?: string | null;
}

export async function logsOf(serviceUrl: string): Promise<LogEntry[]> {
  const res = await fetch(`${serviceUrl}/admin/logs`);
  const body = (await res.json()) as { logs?: LogEntry[] };
  return body.logs ?? [];
}

export async function actionsOf(serviceUrl: string): Promise<string[]> {
  return (await logsOf(serviceUrl)).map((entry) => entry.action);
}

export async function configureMock(serviceUrl: string, config: Record<string, unknown>): Promise<void> {
  await fetch(`${serviceUrl}/admin/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

export async function resetAllMocks(): Promise<void> {
  for (const url of [PAYMENT_URL, INVENTORY_URL, SHIPPING_URL, NOTIFICATION_URL]) {
    await fetch(`${url}/admin/reset`, { method: "POST" });
  }
  await configureMock(PAYMENT_URL, { paymentFailMode: "never", paymentRefundFailMode: "never" });
  await configureMock(INVENTORY_URL, { inventoryFailMode: "never", inventoryReleaseFailMode: "never" });
  await configureMock(SHIPPING_URL, { shippingFailMode: "never", shippingDelayMs: 0 });
  await configureMock(NOTIFICATION_URL, { notificationFailMode: "never" });
}

// ------------------------------------------------------------ audit mirror --

const DATA_DIR = path.join(PA7_ROOT, "api", "data");

export function loadStore(name: "idempotency-store.json" | "saga-store.json"): any {
  return JSON.parse(readFileSync(path.join(DATA_DIR, name), "utf8"));
}

// Both packages are CommonJS; under NodeNext their class and plugin are the
// modules' `default` export.
const Ajv2020 = ajv2020Module.default;
const addFormats = ajvFormatsModule.default;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function schema(name: string): object {
  return JSON.parse(readFileSync(path.join(PA7_ROOT, "grading", "schema", name), "utf8"));
}

// checkout-response and saga-store $ref "trace-item.schema.json" by filename.
ajv.addSchema(schema("trace-item.schema.json"), "trace-item.schema.json");
const validators = {
  checkoutResponse: ajv.compile(schema("checkout-response.schema.json")),
  idempotencyStore: ajv.compile(schema("idempotency-store.schema.json")),
  sagaStore: ajv.compile(schema("saga-store.schema.json")),
};

export function assertValid(which: keyof typeof validators, value: unknown): void {
  const validate = validators[which];
  if (!validate(value)) {
    throw new Error(`${which} does not match grading/schema: ${ajv.errorsText(validate.errors)}`);
  }
}

// ------------------------------------------------------------------ docker --

export function docker(...args: string[]): string {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new Error("the docker CLI is not on this machine's PATH; the crash test needs it to kill and start the worker");
    }
    throw new Error(`docker ${args.join(" ")} failed: ${e.stderr ?? e.message}`);
  }
}

export function pathExists(relativeToPa7: string): boolean {
  return existsSync(path.join(PA7_ROOT, relativeToPa7));
}
