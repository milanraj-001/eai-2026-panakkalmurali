/**
 * The kit's mocks (README §5.2): configure a failure, read what each call
 * carried (/admin/logs), and what really happened (/admin/effects).
 */
import { get, post, show } from "./http.js";
import { type Provider, T } from "./targets.js";

export const PROVIDERS: Provider[] = ["payment", "inventory", "shipping", "notification"];
export const PRICING_KEY = { "X-API-Key": "pa4-pricing-key-2026" };

/** Every mock back to its boot state: no failures, no delays, empty logs. */
export async function resetMocks(): Promise<void> {
  const replies = await Promise.all([
    ...PROVIDERS.map((p) => post(`${T[p]}/admin/reset`)),
    post(`${T.pricing}/admin/reset`, {}, PRICING_KEY),
  ]);
  for (const r of replies) if (r.status !== 200) throw new Error(`a mock refused /admin/reset: ${r.status} ${show(r.body)}`);
}

/** POST /admin/config on one provider mock, for example `{authorize: {failMode: "always", failStatus: 402}}`. */
export async function configure(provider: Provider, config: object): Promise<void> {
  const r = await post(`${T[provider]}/admin/config`, config);
  if (r.status !== 200) throw new Error(`the ${provider} mock refused /admin/config ${show(config)}: ${r.status} ${show(r.body)}`);
}

/** POST /admin/config on pricing: `delayMs`, `outage`, `status401`. */
export async function configurePricing(config: object): Promise<void> {
  const r = await post(`${T.pricing}/admin/config`, config, PRICING_KEY);
  if (r.status !== 200) throw new Error(`the pricing mock refused /admin/config ${show(config)}: ${r.status} ${show(r.body)}`);
}

/** A product's unit price as a decimal string, straight from the pricing mock. */
export async function unitPrice(productId: string): Promise<string> {
  const r = await get(`${T.pricing}/pricing/${productId}`, PRICING_KEY);
  if (r.status !== 200) throw new Error(`pricing has no ${productId}: ${r.status} ${show(r.body)}`);
  return Number(r.body.unitPrice).toFixed(2);
}

export interface MockEntry {
  seq: number;
  receivedAt: string;
  respondedAt: string;
  action: string;
  orderId: string | null;
  correlationId: string | null;
  causationId: string | null;
  idempotencyKey: string | null;
  outcome: string;
  status: number;
  effect: boolean;
  type?: string;
  kind?: string;
  [field: string]: unknown;
}

/** Every call one mock received for an order, oldest first. */
export async function logs(provider: Provider, orderId: string): Promise<MockEntry[]> {
  const r = await get(`${T[provider]}/admin/logs?orderId=${encodeURIComponent(orderId)}`);
  if (r.status !== 200) throw new Error(`GET ${provider} /admin/logs: ${r.status} ${show(r.body)}`);
  return r.body.logs;
}

/** Every side effect one mock performed for an order: charges, refunds, reservations, releases, shipments, notices. */
export async function effects(provider: Provider, orderId: string): Promise<MockEntry[]> {
  const r = await get(`${T[provider]}/admin/effects?orderId=${encodeURIComponent(orderId)}`);
  if (r.status !== 200) throw new Error(`GET ${provider} /admin/effects: ${r.status} ${show(r.body)}`);
  return r.body.effects;
}

/** Every call to any provider mock for an order, in the order they arrived. */
export async function allLogs(orderId: string): Promise<Array<MockEntry & { provider: Provider }>> {
  const out: Array<MockEntry & { provider: Provider }> = [];
  for (const p of PROVIDERS) for (const e of await logs(p, orderId)) out.push({ ...e, provider: p });
  return out.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.seq - b.seq);
}

/** The saga's own calls: the notifier's `order_not_completed` notices use the same mock (§4.5), so they are left out. */
export async function sagaCalls(orderId: string): Promise<Array<MockEntry & { provider: Provider }>> {
  return (await allLogs(orderId)).filter((c) => c.kind !== "order_not_completed");
}

/** "payment authorize, inventory reserve" — for failure messages. */
export const listCalls = (calls: Array<{ provider: string; action: string }>) =>
  calls.length === 0 ? "no calls" : calls.map((c) => `${c.provider} ${c.action}`).join(", ");
