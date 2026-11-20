/**
 * Stage 1: intake, the Normalizer (README §4.1). The three formats, the
 * order.accepted event, idempotency at the door, an unknown product and a
 * pricing outage.
 *
 * A spy queue bound to orders.exchange captures the events. Nothing here needs
 * the orchestrator: events that nobody consumes yet wait in saga.queue.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  b2bOrder,
  because,
  configurePricing,
  get,
  header,
  mobileOrder,
  show,
  sleep,
  spy,
  type Spy,
  submit,
  type Submission,
  T,
  until,
  useStack,
  valid,
  webOrder,
} from "../lib/index.js";

useStack();

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The events on the spy whose body is this order. Found by body, so a missing header cannot hide one. */
const eventsFor = (s: Spy, orderId: string) =>
  s.messages.filter((m) => {
    try {
      return JSON.parse(m.content.toString("utf8")).orderId === orderId;
    } catch {
      return false;
    }
  });

async function theEvent(s: Spy, o: Submission) {
  const found = await until(`an order.accepted event for ${o.orderId} on orders.exchange`, async () => eventsFor(s, o.orderId), (e) => e.length > 0, 5000).catch(
    () => {
      throw new Error(because("R-4.1.19", `POST /orders answered 202, but no event with orderId ${o.orderId} reached orders.exchange within 5 s`));
    },
  );
  return found[0]!;
}

/** Submits and expects 202 {correlationId: <UUID v4>, status: "accepted"}. */
async function expectAccepted(o: Submission, key = randomUUID()): Promise<string> {
  const r = await submit(o, key);
  const said = `POST /orders with the ${o.source} fixture answered ${r.status} ${show(r.body)}`;
  expect(r.status, because("R-4.1.11", `${said}; expected 202`)).toBe(202);
  expect(r.body?.status, because("R-4.1.11", `${said}; expected status "accepted"`)).toBe("accepted");
  expect(String(r.body?.correlationId), because("R-3.3.1", `${said}; expected a UUID v4 correlationId`)).toMatch(UUID_V4);
  return r.body.correlationId;
}

describe("stage 1 · intake", () => {
  test("P1.1 · web JSON → 202 with a UUID v4 correlationId, and GET /orders/:cid answers 200", async () => {
    const o = webOrder();
    const cid = await expectAccepted(o);
    const view = await get(`${T.intake}/orders/${cid}`);
    expect(view.status, because("R-4.4.1, R-4.4.2", `GET /orders/${cid} right after the 202 answered ${view.status} ${show(view.body)}`)).toBe(200);
  });

  test("P1.2 · mobile JSON → 202", async () => {
    await expectAccepted(mobileOrder());
  });

  test("P1.3 · b2b XML in windows-1257 → 202; the event is a valid canonical order with the diacritics intact", async () => {
    const s = await spy("orders.exchange");
    try {
      const o = b2bOrder();
      await expectAccepted(o);
      const msg = await theEvent(s, o);
      const event = JSON.parse(msg.content.toString("utf8"));
      const errors = valid("canonical", event);
      expect(errors, because("R-4.1.9, R-4.1.19", `the event is not valid against canonical/order.schema.json: ${errors}`)).toBeNull();
      const c = event.customer ?? {};
      expect(
        [c.name, c.address?.street, c.address?.city],
        because("R-4.1.1", `decode the bytes by the XML declaration's encoding (windows-1257). The event has name ${show(c.name)}, street ${show(c.address?.street)}, city ${show(c.address?.city)}`),
      ).toEqual(["Anna Bērziņa", "Brīvības iela 100", "Rīga"]);
    } finally {
      await s.stop();
    }
  });

  test("P1.4 · the event carries the headers correlationId (the one returned), causationId and businessKey, a messageId, and is persistent", async () => {
    const s = await spy("orders.exchange");
    try {
      const o = webOrder();
      const cid = await expectAccepted(o);
      const msg = await theEvent(s, o);
      const headers = show(msg.properties.headers ?? {});
      expect(header(msg, "correlationId"), because("R-4.1.20, R-3.3.1", `the event's headers are ${headers}; correlationId must be ${cid}, the one POST returned`)).toBe(cid);
      expect(header(msg, "causationId") ?? "", because("R-4.1.20, R-3.3.2", `the event's headers are ${headers}; causationId must be the intake.publish hop's id`)).not.toBe("");
      expect(header(msg, "businessKey"), because("R-4.1.20, R-3.3.4", `the event's headers are ${headers}`)).toBe(o.businessKey);
      expect(msg.properties.messageId ?? "", because("R-4.1.20, R-3.3.3", "the event has no properties.messageId")).not.toBe("");
      expect(msg.properties.deliveryMode, because("R-4.1.19", `the event's delivery mode is ${show(msg.properties.deliveryMode)}; publish with persistent: true (delivery mode 2)`)).toBe(2);
    } finally {
      await s.stop();
    }
  });

  test("P1.5 · a missing Idempotency-Key → 400; the same key and body → the same correlationId, and exactly one event", async () => {
    const s = await spy("orders.exchange");
    try {
      const o = webOrder();
      const none = await submit(o, null);
      expect(none.status, because("R-4.1.12, R-3.3.5", `POST /orders without an Idempotency-Key answered ${none.status} ${show(none.body)}`)).toBe(400);
      expect(none.body?.code, because("R-4.1.12", `the 400 body is ${show(none.body)}`)).toBe("validation_error");

      const key = randomUUID();
      const first = await submit(o, key);
      const second = await submit(o, key);
      expect(first.status, because("R-4.1.11", `the first POST answered ${first.status} ${show(first.body)}`)).toBe(202);
      expect(second.status, because("R-4.1.13", `the same key and body again answered ${second.status} ${show(second.body)}`)).toBe(first.status);
      expect(second.body?.correlationId, because("R-4.1.13", `the first answer was ${show(first.body)}, the second ${show(second.body)}`)).toBe(first.body.correlationId);
      await sleep(1000);
      expect(eventsFor(s, o.orderId).length, because("R-4.1.13", "one order sent twice with the same key must be published once")).toBe(1);
    } finally {
      await s.stop();
    }
  });

  test("P1.6 · an unknown product → 422 unknown_product, and no event", async () => {
    const s = await spy("orders.exchange");
    try {
      const o = webOrder({ items: [{ productId: "PROD-001", quantity: 1 }, { productId: "PROD-999", quantity: 1 }] });
      const r = await submit(o);
      expect(r.status, because("R-4.1.16", `an order with PROD-999, which pricing does not know, answered ${r.status} ${show(r.body)}; the whole order is rejected`)).toBe(422);
      expect(r.body?.code, because("R-4.1.16", `the 422 body is ${show(r.body)}`)).toBe("unknown_product");
      await sleep(1000);
      expect(eventsFor(s, o.orderId).length, because("R-4.1.16", "a rejected order must not be published")).toBe(0);
    } finally {
      await s.stop();
    }
  });

  test("P1.7 · a pricing outage → 503 with Retry-After, and no event; after recovery the same key → 202", async () => {
    const s = await spy("orders.exchange");
    try {
      await configurePricing({ outage: true });
      const o = webOrder();
      const key = randomUUID();
      const down = await submit(o, key);
      expect(down.status, because("R-4.1.17", `with pricing answering 500, POST /orders answered ${down.status} ${show(down.body)}`)).toBe(503);
      expect(down.body?.code, because("R-4.1.17", `the 503 body is ${show(down.body)}`)).toBe("pricing_unavailable");
      const retryAfter = down.headers.get("retry-after");
      expect(/^\d+$/.test(retryAfter ?? "") && Number(retryAfter) >= 1, because("R-4.1.17", `Retry-After is ${show(retryAfter)}; expected whole seconds, at least 1`)).toBe(true);

      await configurePricing({ outage: false });
      const up = await submit(o, key);
      expect(up.status, because("R-4.1.17", `after pricing recovered, the same key and body answered ${up.status} ${show(up.body)}: a 503 must not use up the key`)).toBe(202);
      await sleep(1000);
      expect(eventsFor(s, o.orderId).length, because("R-4.1.17, R-4.1.11", "the outage must publish nothing, and the accepted retry exactly one event")).toBe(1);
    } finally {
      await s.stop();
    }
  });
});
