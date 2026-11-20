/**
 * Stage 2: the saga's happy path (README §4.2, §4.4). The orchestrator
 * consumes order.accepted and calls the mocks; GET /orders shows the result.
 * What each mock received comes from its /admin/logs.
 */
import { describe, expect, test } from "vitest";
import {
  accepted,
  b2bOrder,
  because,
  get,
  listCalls,
  logs,
  sagaCalls,
  show,
  T,
  unitPrice,
  useStack,
  valid,
  waitState,
  webOrder,
} from "../lib/index.js";

useStack();

/** Σ unitPrice × quantity in whole cents, as "90.30". */
function amountOf(lines: Array<{ unitPrice: string; quantity: number }>): string {
  let cents = 0;
  for (const l of lines) cents += Math.round(Number(l.unitPrice) * 100) * l.quantity;
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

describe("stage 2 · the saga, happy path", () => {
  test("P2.1 · a web order → completed; each mock called once, in the order payment → inventory → shipping → notification", async () => {
    const o = webOrder();
    const cid = await accepted(o);
    await waitState(cid, "completed", "R-4.2.8, R-4.4.1");
    const calls = await sagaCalls(o.orderId);
    expect(
      calls.map((c) => `${c.provider} ${c.action}`),
      because("R-4.2.8, R-4.2.9", `the mocks received: ${listCalls(calls)}`),
    ).toEqual(["payment authorize", "inventory reserve", "shipping create", "notification send"]);
  });

  test("P2.2 · payment receives the exact amount as a decimal string, and Idempotency-Key authorize:<businessKey>", async () => {
    const o = webOrder(); // the fixture: PROD-001 × 2, PROD-002 × 1
    const expected = amountOf([
      { unitPrice: await unitPrice("PROD-001"), quantity: 2 },
      { unitPrice: await unitPrice("PROD-002"), quantity: 1 },
    ]);
    const cid = await accepted(o);
    await waitState(cid, "completed", "R-4.2.8, R-4.4.1");
    const pay = (await logs("payment", o.orderId)).filter((l) => l.action === "authorize");
    expect(pay.length, because("R-4.2.8", `payment received ${pay.length} authorize calls`)).toBe(1);
    expect(pay[0]!.amount, because("R-4.2.10", `payment received amount ${show(pay[0]!.amount)}; expected the string "${expected}"`)).toBe(expected);
    expect(pay[0]!.idempotencyKey, because("R-3.3.6, R-4.2.9", `payment received Idempotency-Key ${show(pay[0]!.idempotencyKey)}`)).toBe(`authorize:${o.businessKey}`);
  });

  test("P2.3 · every mock call carries X-Correlation-Id = the correlationId intake returned", async () => {
    const o = webOrder();
    const cid = await accepted(o);
    await waitState(cid, "completed", "R-4.2.8, R-4.4.1");
    const calls = await sagaCalls(o.orderId);
    expect(calls.length, because("R-4.2.8", `the mocks received: ${listCalls(calls)}`)).toBe(4);
    const wrong = calls.filter((c) => c.correlationId !== cid).map((c) => `${c.provider} ${c.action}: ${show(c.correlationId)}`);
    expect(wrong, because("R-3.3.9, R-3.3.1", `these calls carried another X-Correlation-Id than ${cid}: ${wrong.join("; ")}`)).toEqual([]);
  });

  test("P2.4 · a b2b order → completed; payment is never called; inventory receives Idempotency-Key reserve:<businessKey>", async () => {
    const o = b2bOrder();
    const cid = await accepted(o);
    await waitState(cid, "completed", "R-4.2.8, R-4.4.1");
    const paid = await logs("payment", o.orderId);
    expect(paid.length, because("R-4.2.8", `b2b is invoiced, but payment received: ${paid.map((l) => l.action).join(", ")}`)).toBe(0);
    const reserve = (await logs("inventory", o.orderId)).filter((l) => l.action === "reserve");
    expect(reserve.length, because("R-4.2.8", `inventory received ${reserve.length} reserve calls`)).toBe(1);
    expect(reserve[0]!.idempotencyKey, because("R-3.3.6, R-4.2.9", `inventory received Idempotency-Key ${show(reserve[0]!.idempotencyKey)}`)).toBe(`reserve:${o.businessKey}`);
  });

  test("P2.5 · GET /orders/:cid is valid against order-status.schema.json, with state completed and the right businessKey", async () => {
    const o = webOrder();
    const cid = await accepted(o);
    await waitState(cid, "completed", "R-4.2.8, R-4.4.1");
    const r = await get(`${T.intake}/orders/${cid}`);
    const errors = valid("order-status", r.body);
    expect(errors, because("R-4.4.1", `GET /orders/${cid} answered ${show(r.body)}: ${errors}`)).toBeNull();
    expect(r.body.state).toBe("completed");
    expect(r.body.businessKey, because("R-3.3.4, R-4.4.1", `GET /orders/${cid} answered ${show(r.body)}`)).toBe(o.businessKey);
    expect(r.body.correlationId, because("R-4.4.1", `GET /orders/${cid} answered ${show(r.body)}`)).toBe(cid);
  });
});
