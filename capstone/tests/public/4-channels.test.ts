/**
 * Stage 4: the invalid channel, the notifier, and the DLQ operations
 * (README §4.2, §4.5, §4.6). orders.dlq and orders.invalid are emptied before
 * each test, so the counts here are this test's own.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import {
  accepted,
  because,
  configure,
  drain,
  effects,
  get,
  post,
  peek,
  publishRaw,
  purge,
  show,
  sleep,
  spy,
  T,
  until,
  useStack,
  waitState,
  webOrder,
  withCorrelation,
} from "../lib/index.js";

useStack();

beforeEach(async () => {
  await purge("orders.dlq");
  await purge("orders.invalid");
});

const notices = async (orderId: string) => (await effects("notification", orderId)).filter((e) => e.kind === "order_not_completed");

async function dlqList(): Promise<{ count: number; entries: any[] }> {
  const r = await get(`${T.intake}/dlq`);
  expect(r.status, because("R-4.6.1", `GET /dlq answered ${r.status} ${show(r.body)}`)).toBe(200);
  return r.body;
}

/** A declined order whose notice cannot be delivered: after three attempts it is in the DLQ. */
async function noticeInDlq(): Promise<{ cid: string; orderId: string }> {
  await configure("payment", { authorize: { failMode: "always", failStatus: 402 } });
  await configure("notification", { send: { failMode: "always", failStatus: 503, failForKinds: ["order_not_completed"] } });
  const o = webOrder();
  const cid = await accepted(o);
  await waitState(cid, "failed", "R-4.3.1");
  await until(
    `an entry for ${cid} in GET /dlq`,
    async () => (await get(`${T.intake}/dlq`)).body,
    (d) => Array.isArray(d?.entries) && d.entries.some((e: any) => e?.correlationId === cid),
    20_000,
    250,
  ).catch((err) => {
    throw new Error(because("R-4.5.7, R-4.6.1", `the notification mock answered 503 to every attempt, so the notice belongs in the DLQ after MAX_RETRIES = 3 attempts. ${err.message}`));
  });
  return { cid, orderId: o.orderId };
}

describe("stage 4 · the invalid channel, the notifier and the DLQ", () => {
  test("P4.1 · `{ not json` on orders.exchange → orders.invalid with its original bytes; not in orders.dlq, and not retried", async () => {
    const retried = await spy("orders.retry.exchange", "saga.queue");
    const dead = await spy("orders.dlq.exchange");
    try {
      const bytes = Buffer.from("{ not json");
      await publishRaw("orders.exchange", "", bytes, { messageId: randomUUID() });
      const invalid = await until("the message in orders.invalid", () => peek("orders.invalid"), (m) => m.length > 0, 10_000, 200).catch(() => {
        throw new Error(because("R-4.2.2", "a message that is not JSON was published to orders.exchange; within 10 s nothing reached orders.invalid"));
      });
      expect(invalid[0]!.content.equals(bytes), because("R-4.2.2, R-4.6.7", `orders.invalid holds ${show(invalid[0]!.content.toString("utf8"))}; expected the original bytes "{ not json"`)).toBe(true);
      await sleep(2500); // past one retry TTL
      await drain();
      const again = await peek("orders.invalid");
      expect(again.length, because("R-4.2.2", `orders.invalid holds ${again.length} messages; the poison must arrive once`)).toBe(1);
      expect(retried.messages.length, because("R-4.2.2", "the poison went through the retry path (orders.retry.exchange): a malformed message is permanent, never retried")).toBe(0);
      expect(dead.messages.length, because("R-4.2.2", "the poison reached orders.dlq.exchange: it belongs in orders.invalid only")).toBe(0);
    } finally {
      await retried.stop();
      await dead.stop();
    }
  });

  test("P4.2 · a failed order → an order_not_completed notice", async () => {
    await configure("payment", { authorize: { failMode: "always", failStatus: 402 } });
    const o = webOrder();
    const cid = await accepted(o);
    await waitState(cid, "failed", "R-4.3.1");
    await until(`an order_not_completed notice for ${o.orderId}`, () => notices(o.orderId), (n) => n.length > 0, 10_000, 200).catch(async () => {
      throw new Error(
        because("R-4.5.4", `the order is failed, but within 10 s the notification mock sent no order_not_completed notice for ${o.orderId}; it sent ${show(await effects("notification", o.orderId))}`),
      );
    });
  });

  test("P4.3 · the same outcome event, published again by the test → still one notice", async () => {
    await configure("payment", { authorize: { failMode: "always", failStatus: 402 } });
    const s = await spy("orders.outcome", "order.failed");
    try {
      const o = webOrder();
      const cid = await accepted(o);
      await waitState(cid, "failed", "R-4.3.1");
      await until(`the first notice for ${o.orderId}`, () => notices(o.orderId), (n) => n.length === 1, 10_000, 200);
      const event = await until("the order.failed event", async () => withCorrelation(s, cid)[0], (m) => !!m, 5000).catch(() => {
        throw new Error(because("R-4.5.1, R-4.5.2", `no order.failed event with headers.correlationId ${cid} was published to orders.outcome`));
      });
      await publishRaw("orders.outcome", "order.failed", event!.content, { messageId: randomUUID(), headers: event!.properties.headers });
      await sleep(1000);
      await drain();
      const sent = await notices(o.orderId);
      expect(sent.length, because("R-4.5.3", `the same order.failed event, delivered twice, sent ${sent.length} notices; dedupe on correlationId`)).toBe(1);
    } finally {
      await s.stop();
    }
  });

  test("P4.4 · the notification mock fails (with no effect) → a GET /dlq entry with originQueue notifications.queue, attempts 3 and lastError", async () => {
    const { cid, orderId } = await noticeInDlq();
    const entry = (await dlqList()).entries.find((e) => e.correlationId === cid);
    expect(entry.originQueue, because("R-4.5.7, R-3.3.7", `the entry is ${show(entry)}`)).toBe("notifications.queue");
    expect(entry.attempts, because("R-4.6.1, R-4.5.7", `the entry is ${show(entry)}; MAX_RETRIES is 3`)).toBe(3);
    expect(typeof entry.lastError === "string" && entry.lastError.trim() !== "", because("R-3.3.8, R-4.5.7", `the entry is ${show(entry)}; lastError is a short reason`)).toBe(true);
    expect((await notices(orderId)).length, because("R-4.5.7", "every attempt failed, so no notice was sent")).toBe(0);
  });

  test("P4.5 · fixed, then POST /dlq/replay → exactly one notice, and the DLQ is empty", async () => {
    const { orderId } = await noticeInDlq();
    await configure("notification", { send: { failMode: "never" } });
    const r = await post(`${T.intake}/dlq/replay`, {});
    expect(r.status, because("R-4.6.3, R-4.6.6", `POST /dlq/replay {} answered ${r.status} ${show(r.body)}`)).toBe(200);
    await until(`the replayed notice for ${orderId}`, () => notices(orderId), (n) => n.length > 0, 10_000, 200).catch(() => {
      throw new Error(because("R-4.6.4", `after the replay, no notice for ${orderId} was sent within 10 s. The replay goes to orders.return.exchange with routing key = originQueue`));
    });
    await sleep(1000);
    await drain();
    expect((await notices(orderId)).length, because("R-4.6.4, R-4.6.8", "one replay of one entry sends one notice")).toBe(1);
    const left = await until("GET /dlq to be empty", dlqList, (d) => d.count === 0, 5000, 250).catch(async () => {
      throw new Error(because("R-4.6.5, R-4.6.6", `after the replay GET /dlq still answers ${show(await dlqList())}`));
    });
    expect(left.entries.length).toBe(0);
  });
});
