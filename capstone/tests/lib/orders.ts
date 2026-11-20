/**
 * Orders: the three fixtures with a fresh orderId each time, submitting them,
 * and waiting on GET /orders/:cid and GET /trace/:cid.
 *
 * Every test rewrites the fixture's orderId, because the saga dedupes on the
 * business key (README §4.2): the same fixture twice would be a duplicate.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { because, get, http, type Reply, show, until } from "./http.js";
import { FIXTURES_DIR, T } from "./targets.js";

let counter = 0;
/** A fresh orderId: WEB-<time>-<n>. */
export function freshId(prefix: string): string {
  counter++;
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${counter}`;
}

/** windows-1257, built by inverting Node's decoder: Node ships no encoder for it. */
const CP1257 = (() => {
  const decoder = new TextDecoder("windows-1257");
  const map = new Map<string, number>();
  for (let b = 0; b < 256; b++) {
    const ch = decoder.decode(Uint8Array.of(b));
    if (ch !== "�" && !map.has(ch)) map.set(ch, b);
  }
  return map;
})();

export function encode1257(text: string): Buffer {
  return Buffer.from(
    [...text].map((ch) => {
      const b = CP1257.get(ch);
      if (b === undefined) throw new Error(`not in windows-1257: ${ch}`);
      return b;
    }),
  );
}

export const decode1257 = (bytes: Buffer) => new TextDecoder("windows-1257").decode(bytes);

export interface Submission {
  orderId: string;
  source: "web" | "mobile" | "b2b";
  body: Buffer;
  contentType: string;
  businessKey: string;
}

export interface OrderEdits {
  orderId?: string;
  /** Replaces the fixture's items. productId in pricing's form, PROD-nnn. */
  items?: Array<{ productId: string; productName?: string; quantity: number }>;
}

const fixture = (name: string) => readFileSync(path.join(FIXTURES_DIR, name));

/** The web fixture (fixtures/web-order.json), JSON. */
export function webOrder(edits: OrderEdits = {}): Submission {
  const doc = JSON.parse(fixture("web-order.json").toString("utf8"));
  const orderId = edits.orderId ?? freshId("WEB");
  doc.orderId = orderId;
  if (edits.items) doc.items = edits.items.map((i) => ({ productId: i.productId, productName: i.productName ?? "Item", quantity: i.quantity }));
  return { orderId, source: "web", body: Buffer.from(JSON.stringify(doc)), contentType: "application/json", businessKey: `web:${orderId}` };
}

/** The mobile fixture (fixtures/mobile-order.json), JSON with short field names. */
export function mobileOrder(edits: OrderEdits = {}): Submission {
  const doc = JSON.parse(fixture("mobile-order.json").toString("utf8"));
  const orderId = edits.orderId ?? freshId("MOB");
  doc.oid = orderId;
  if (edits.items) doc.items = edits.items.map((i) => ({ pid: i.productId.replace(/^PROD-/, ""), pname: i.productName ?? "Item", qty: i.quantity }));
  return { orderId, source: "mobile", body: Buffer.from(JSON.stringify(doc)), contentType: "application/json", businessKey: `mobile:${orderId}` };
}

/** The b2b fixture (fixtures/b2b-order.xml): XML, windows-1257 bytes, edited as text and encoded again. */
export function b2bOrder(edits: OrderEdits = {}): Submission {
  let xml = decode1257(fixture("b2b-order.xml"));
  const orderId = edits.orderId ?? freshId("B2B");
  xml = xml.replace(/orderId="[^"]*"/, `orderId="${orderId}"`);
  if (edits.items) {
    const lines = edits.items
      .map((i) => `    <LineItem sku="SKU-${i.productId}" quantity="${i.quantity}">\n      <Description>${i.productName ?? "Item"}</Description>\n    </LineItem>`)
      .join("\n");
    xml = xml.replace(/<LineItems currency="EUR">[\s\S]*<\/LineItems>/, `<LineItems currency="EUR">\n${lines}\n  </LineItems>`);
  }
  return { orderId, source: "b2b", body: encode1257(xml), contentType: "application/xml", businessKey: `b2b:${orderId}` };
}

/** POST /orders with the raw bytes. `key: null` sends no Idempotency-Key. */
export async function submit(order: Submission, key: string | null = randomUUID()): Promise<Reply> {
  const headers: Record<string, string> = { "Content-Type": order.contentType };
  if (key !== null) headers["Idempotency-Key"] = key;
  return http(`${T.intake}/orders`, { method: "POST", body: order.body, headers });
}

/** Submits, requires 202 (R-4.1.11), and returns the correlationId. */
export async function accepted(order: Submission): Promise<string> {
  const r = await submit(order);
  if (r.status !== 202 || typeof r.body?.correlationId !== "string") {
    throw new Error(because("R-4.1.11", `POST /orders with the ${order.source} fixture answered ${r.status} ${show(r.body)}; the test needs a 202 with a correlationId to go on`));
  }
  return r.body.correlationId;
}

/** GET /orders/:cid: the body, or null for anything but 200. */
export async function orderView(cid: string): Promise<any> {
  const r = await get(`${T.intake}/orders/${cid}`);
  return r.status === 200 ? r.body : null;
}

/**
 * Waits until GET /orders/:cid shows one of `states`. On timeout the message
 * names the state the order is stuck in.
 */
export async function waitState(cid: string, states: string | string[], ids = "R-4.4.1", timeoutMs = 15_000): Promise<any> {
  const wanted = Array.isArray(states) ? states : [states];
  try {
    return await until(`GET /orders/${cid} to show state ${wanted.join(" or ")}`, () => orderView(cid), (o) => wanted.includes(o?.state), timeoutMs, 150);
  } catch (err) {
    throw new Error(because(ids, (err as Error).message));
  }
}

export interface Hop {
  hopId: string;
  correlationId: string;
  causationId: string | null;
  service: string;
  operation: string;
  status: string;
  attempt: number;
  messageId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  detail?: Record<string, any>;
}

/** GET /trace/:cid's hops, or [] for anything but 200. */
export async function trace(cid: string): Promise<Hop[]> {
  const r = await get(`${T.observer}/trace/${cid}`);
  return r.status === 200 && Array.isArray(r.body?.hops) ? r.body.hops : [];
}

/** Waits until the trace holds every operation named: hops arrive asynchronously. */
export async function traceWith(cid: string, operations: string[], ids = "R-4.8.1", timeoutMs = 10_000): Promise<Hop[]> {
  try {
    return await until(
      `GET /trace/${cid} to hold the operations ${operations.join(", ")}`,
      () => trace(cid),
      (hops) => operations.every((op) => hops.some((h) => h.operation === op)),
      timeoutMs,
      200,
    );
  } catch (err) {
    const have = [...new Set((await trace(cid)).map((h) => h.operation))];
    throw new Error(because(ids, `${(err as Error).message.split(";")[0]}; the trace has: ${have.join(", ") || "no hops"}`));
  }
}
