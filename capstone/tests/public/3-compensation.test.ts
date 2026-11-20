/**
 * Stage 3: the compensation matrix (README §4.3). Each test makes one mock
 * fail through /admin/config, then reads the outcome from GET /orders and the
 * side effects from /admin/effects.
 *
 * The notifier's order_not_completed notice goes to the notification mock
 * too. It is not a saga step, so "nothing downstream" leaves it out.
 */
import { describe, expect, test } from "vitest";
import {
  accepted,
  b2bOrder,
  because,
  configure,
  effects,
  listCalls,
  logs,
  sagaCalls,
  show,
  sleep,
  useStack,
  waitState,
  webOrder,
} from "../lib/index.js";

useStack();

describe("stage 3 · the compensation matrix", () => {
  test("P3.1 · payment declined → failed with payment_declined, and nothing downstream is called", async () => {
    await configure("payment", { authorize: { failMode: "always", failStatus: 402 } });
    const o = webOrder();
    const cid = await accepted(o);
    const done = await waitState(cid, ["failed", "parked", "compensated", "completed", "compensation_failed"], "R-4.3.1");
    expect(done.state, because("R-4.3.1, R-4.2.15", `a 402 from payment is permanent. GET /orders shows ${show(done)}`)).toBe("failed");
    expect(done.code, because("R-4.3.1, R-4.4.3", `GET /orders shows ${show(done)}; the code is the mock's`)).toBe("payment_declined");
    await sleep(500);
    const calls = await sagaCalls(o.orderId);
    expect(listCalls(calls), because("R-4.3.1", "after a declined payment nothing else may run")).toBe("payment authorize");
  });

  test("P3.2 · inventory unavailable → compensated, with exactly one refund", async () => {
    await configure("inventory", { reserve: { failMode: "always" } });
    const o = webOrder();
    const cid = await accepted(o);
    const done = await waitState(cid, ["compensated", "failed", "completed", "compensation_failed"], "R-4.3.3");
    expect(done.state, because("R-4.3.3, R-4.2.16", `GET /orders shows ${show(done)}`)).toBe("compensated");
    const refunds = (await effects("payment", o.orderId)).filter((e) => e.type === "refund");
    expect(refunds.length, because("R-4.3.3", `payment performed ${refunds.length} refunds for ${o.orderId}`)).toBe(1);
  });

  test("P3.3 · a shipping timeout → compensated with timeout; the release comes before the refund", async () => {
    await configure("shipping", { create: { delayMs: 3500 } }); // REQUEST_TIMEOUT_MS is 2500
    const o = webOrder();
    const cid = await accepted(o);
    const done = await waitState(cid, ["compensated", "failed", "completed", "compensation_failed"], "R-4.3.4", 20_000);
    expect(done.state, because("R-4.3.4, R-4.2.11", `shipping answered after 3.5 s. GET /orders shows ${show(done)}`)).toBe("compensated");
    expect(done.code, because("R-4.3.4, R-4.2.16", `GET /orders shows ${show(done)}`)).toBe("timeout");
    const release = (await logs("inventory", o.orderId)).find((l) => l.action === "release");
    const refund = (await logs("payment", o.orderId)).find((l) => l.action === "refund");
    expect(release && refund, because("R-4.3.4", `the calls were: ${listCalls(await sagaCalls(o.orderId))}`)).toBeTruthy();
    expect(
      Date.parse(release!.respondedAt) <= Date.parse(refund!.receivedAt),
      because("R-4.3.4, R-4.2.16", `compensate in reverse: release was answered at ${release!.respondedAt}, refund received at ${refund!.receivedAt}`),
    ).toBe(true);
  });

  test("P3.4 · b2b with a shipping failure → compensated: a release, and no refund", async () => {
    await configure("shipping", { create: { failMode: "always" } });
    const o = b2bOrder();
    const cid = await accepted(o);
    const done = await waitState(cid, ["compensated", "failed", "completed", "compensation_failed"], "R-4.3.8");
    expect(done.state, because("R-4.3.8", `GET /orders shows ${show(done)}`)).toBe("compensated");
    const releases = (await effects("inventory", o.orderId)).filter((e) => e.type === "release");
    expect(releases.length, because("R-4.3.8", `inventory performed ${releases.length} releases`)).toBe(1);
    const paid = await logs("payment", o.orderId);
    expect(paid.map((l) => l.action), because("R-4.3.8, R-4.2.8", "a b2b order is never charged, so there is nothing to refund")).toEqual([]);
  });
});
