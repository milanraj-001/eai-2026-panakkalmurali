/**
 * Stage 5: the trace and operations (README §4.8, §4.9). Hops arrive
 * asynchronously, and the management API can report an idle queue late, so
 * these tests poll with a deadline instead of reading once.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
  accepted,
  because,
  containerName,
  containers,
  get,
  type Hop,
  publishRaw,
  purge,
  show,
  T,
  traceWith,
  until,
  useStack,
  valid,
  waitState,
  webOrder,
} from "../lib/index.js";

useStack();

beforeEach(async () => {
  await purge("orders.dlq");
  await purge("orders.invalid");
});

/** The completed order's operations, in this order; others may come between them (README §4.8). */
const SEQUENCE = ["intake.receive", "intake.publish", "saga.consume", "payment", "inventory", "shipping", "notification", "saga.outcome"];

async function metrics(): Promise<any> {
  const r = await get(`${T.observer}/ops/metrics`);
  if (r.status !== 200) throw new Error(`GET /ops/metrics answered ${r.status} ${show(r.body)}`);
  return r.body;
}

const alert = (m: any, key: string) => (Array.isArray(m?.alerts) ? m.alerts.find((a: any) => a?.key === key) : undefined);

describe("stage 5 · the trace and operations", () => {
  test("P5.1 · GET /trace/:cid is valid against trace.schema.json", async () => {
    const cid = await accepted(webOrder());
    await waitState(cid, "completed", "R-4.2.8, R-4.4.1");
    await traceWith(cid, ["intake.receive", "saga.outcome"], "R-4.8.1, R-4.8.4");
    const r = await get(`${T.observer}/trace/${cid}`);
    expect(r.status, because("R-4.8.4", `GET /trace/${cid} answered ${r.status}`)).toBe(200);
    const errors = valid("trace", r.body);
    const bad = errors ? (r.body?.hops ?? []).find((h: unknown) => valid("trace-hop", h) !== null) : undefined;
    expect(errors, because("R-4.8.4, R-4.8.5", `${errors}${bad ? `. The first invalid hop: ${show(bad)}` : ""}`)).toBeNull();
  });

  test("P5.2 · a completed order's trace holds intake.receive … intake.publish, saga.consume, payment, inventory, shipping, notification, saga.outcome in startedAt order, all with its correlationId", async () => {
    const cid = await accepted(webOrder());
    await waitState(cid, "completed", "R-4.2.8, R-4.4.1");
    const hops: Hop[] = await traceWith(cid, SEQUENCE, "R-4.8.1, R-4.8.6");
    const listed = hops.map((h) => h.operation).join(", ");

    const unsorted = hops.findIndex((h, i) => i > 0 && Date.parse(h.startedAt) < Date.parse(hops[i - 1]!.startedAt));
    expect(unsorted, because("R-4.8.4", `the hops are not sorted by startedAt: ${hops[unsorted - 1]?.operation} ${hops[unsorted - 1]?.startedAt} comes before ${hops[unsorted]?.operation} ${hops[unsorted]?.startedAt}`)).toBe(-1);

    let at = 0;
    for (const op of SEQUENCE) {
      const found = hops.findIndex((h, i) => i >= at && h.operation === op);
      expect(found, because("R-4.8.1, R-4.8.6", `${op} does not come after ${SEQUENCE[SEQUENCE.indexOf(op) - 1] ?? "the start"}. The trace, in startedAt order: ${listed}`)).toBeGreaterThanOrEqual(0);
      at = found + 1;
    }
    const others = hops.filter((h) => h.correlationId !== cid).map((h) => `${h.operation}: ${show(h.correlationId)}`);
    expect(others, because("R-4.8.5, R-3.3.1", `hops with another correlationId: ${others.join("; ")}`)).toEqual([]);
  });

  test("P5.3 · /ops/metrics is valid, has all seven alert keys, and a dead-lettered message shows in dlqDepth and fires dlq_not_empty", async () => {
    const before = await metrics().catch((err) => {
      throw new Error(because("R-4.9.1", err.message));
    });
    const errors = valid("ops-metrics", before);
    expect(errors, because("R-4.9.1, R-4.9.3", `GET /ops/metrics answered ${show(before)}: ${errors}`)).toBeNull();

    const cid = randomUUID();
    await publishRaw("orders.dlq.exchange", "", Buffer.from(JSON.stringify({ orderId: "P5-3" })), {
      messageId: randomUUID(),
      headers: { correlationId: cid, causationId: randomUUID(), originQueue: "notifications.queue", lastError: "notification 503" },
    });
    try {
      await until("dlqDepth 1 and dlq_not_empty firing", metrics, (m) => m.dlqDepth === 1 && alert(m, "dlq_not_empty")?.firing === true && alert(m, "dlq_not_empty")?.value === 1, 15_000, 500).catch(
        async (err) => {
          const m = await metrics().catch(() => null);
          throw new Error(
            because("R-4.9.2, R-4.9.4", `one message is in orders.dlq. After 15 s /ops/metrics shows dlqDepth ${show(m?.dlqDepth)} and dlq_not_empty ${show(alert(m, "dlq_not_empty"))}. ${err.message.split(";")[0]}`),
          );
        },
      );
    } finally {
      await purge("orders.dlq");
    }
  });

  describe("the notifier stopped", () => {
    afterAll(() => {
      // Never leave the notifier stopped, even when the test failed halfway.
      try {
        containers.start("notifier");
      } catch {
        // it was running
      }
    });

    test("P5.4 · the notifier stopped, then threshold + 1 order.failed events → notifier_consumer_missing and notifier_consumer_lag fire; both clear after it starts and drains", async () => {
      const lag = alert(await metrics(), "notifier_consumer_lag");
      const threshold = lag?.threshold;
      expect(Number.isInteger(threshold) && threshold >= 1 && threshold <= 20, because("R-4.9.9", `notifier_consumer_lag's threshold is ${show(threshold)}; declare a whole number from 1 to 20`)).toBe(true);

      containers.stop("notifier");
      try {
        await until("notifier_consumer_missing to fire", metrics, (m) => alert(m, "notifier_consumer_missing")?.firing === true, 15_000, 500).catch(async () => {
          throw new Error(because("R-4.9.7", `${containerName("notifier")} is stopped; after 15 s /ops/metrics shows ${show(alert(await metrics(), "notifier_consumer_missing"))}`));
        });
        for (let i = 0; i <= threshold; i++) {
          const cid = randomUUID();
          const orderId = `LAG-${cid.slice(0, 8)}`;
          const envelope = {
            correlationId: cid,
            businessKey: `web:${orderId}`,
            orderId,
            source: "web",
            orderType: "standard",
            recipient: "lag.test@example.com",
            state: "failed",
            code: "payment_declined",
            occurredAt: new Date().toISOString(),
          };
          await publishRaw("orders.outcome", "order.failed", Buffer.from(JSON.stringify(envelope)), {
            messageId: randomUUID(),
            headers: { correlationId: cid, causationId: randomUUID() },
          });
        }
        await until("notifier_consumer_lag to fire", metrics, (m) => alert(m, "notifier_consumer_lag")?.firing === true, 15_000, 500).catch(async () => {
          throw new Error(
            because("R-4.9.9", `${threshold + 1} events wait in notifications.queue, one past the threshold ${threshold}; after 15 s /ops/metrics shows ${show(alert(await metrics(), "notifier_consumer_lag"))}`),
          );
        });
      } finally {
        containers.start("notifier");
      }
      await until(
        "both notifier alerts to clear",
        metrics,
        (m) => alert(m, "notifier_consumer_missing")?.firing === false && alert(m, "notifier_consumer_lag")?.firing === false,
        45_000,
        500,
      ).catch(async () => {
        const m = await metrics().catch(() => null);
        throw new Error(
          because("R-4.9.7, R-4.9.9", `the notifier was started 45 s ago; /ops/metrics still shows ${show(alert(m, "notifier_consumer_missing"))} and ${show(alert(m, "notifier_consumer_lag"))}`),
        );
      });
    }, 150_000);
  });
});
