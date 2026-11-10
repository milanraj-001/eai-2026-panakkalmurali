/**
 * PA7 public tests. They need the stack from pa7/docker-compose.yml running
 * (`docker compose up -d --build --wait`) and talk to it on localhost.
 *
 * Every checkout uses a fresh orderId and a fresh Idempotency-Key, so the
 * suite can run as often as you like. Each test sets the mock behaviour it
 * needs through /admin/config and reads back, from /admin/logs, exactly
 * what each mock was called with — including how many times.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  FORWARD_STEPS,
  INVENTORY_URL,
  NOTIFICATION_URL,
  PAYMENT_URL,
  SHIPPING_URL,
  TEMPORAL_UI_URL,
  API_URL,
  WORKER_CONTAINER,
  actionsOf,
  assertValid,
  checkout,
  configureMock,
  docker,
  expectResponse,
  expectedAmount,
  httpStatusOf,
  loadStore,
  logsOf,
  makeOrder,
  newKey,
  pathExists,
  type Reply,
  resetAllMocks,
  sleep,
  stepNames,
  waitUntil,
} from "./helpers/stack.js";

async function countOf(serviceUrl: string, action: string): Promise<number> {
  return (await actionsOf(serviceUrl)).filter((a) => a === action).length;
}

/**
 * Starts a checkout without waiting for it, and waits until the saga is past
 * the inventory step. Fails at once if the checkout answers first. The reply
 * comes back wrapped, because an async function cannot return a promise
 * without its caller waiting for it.
 */
async function startAndWaitForInventory(order: unknown, key: string): Promise<{ reply: Promise<Reply> }> {
  let answered: Reply | undefined;
  const pending = checkout(order, key).then((reply) => (answered = reply));
  await waitUntil(
    async () => {
      if (answered) {
        throw new Error(`expected the saga to still be running, but it already answered HTTP ${answered.status}: ${JSON.stringify(answered.body)}`);
      }
      return (await countOf(INVENTORY_URL, "reserve")) === 1;
    },
    20_000,
    "the inventory step",
  );
  return { reply: pending };
}

describe("PA7 — the saga on Temporal", () => {
  beforeEach(async () => {
    await resetAllMocks();
  });

  afterAll(() => {
    // If the crash test failed halfway, do not leave the worker stopped.
    try {
      docker("start", WORKER_CONTAINER);
    } catch {
      // nothing to do
    }
  });

  it("1) finds your PA6 mock services and the canonical schema", () => {
    for (const service of ["payment", "inventory", "shipping", "notification"]) {
      const dockerfile = `../pa6/mock-services/${service}/Dockerfile`;
      if (!pathExists(dockerfile)) {
        throw new Error(
          `${dockerfile} is missing. PA7 builds its mocks from your pa6/ folder: commit the whole pa6/, ` +
            "mock-services included, next to pa7/ in your repository.",
        );
      }
    }
    if (!pathExists("../canonical/order.schema.json")) {
      throw new Error("../canonical/order.schema.json is missing. Copy canonical/ from eai-2026 to your repository root.");
    }
  });

  it("2) the api, Temporal and the four mocks are up", async () => {
    expect(await httpStatusOf(`${API_URL}/health`)).toBe(200);
    expect(await httpStatusOf(TEMPORAL_UI_URL)).toBe(200);
    for (const url of [PAYMENT_URL, INVENTORY_URL, SHIPPING_URL, NOTIFICATION_URL]) {
      expect(await httpStatusOf(`${url}/health`)).toBe(200);
    }
  });

  it("3) happy path: all four steps, the derived amount and the recipient", async () => {
    const order = makeOrder();
    const reply = await checkout(order, newKey("happy"));

    expectResponse(reply, 200);
    expect(reply.body.status).toBe("completed");
    expect(reply.body.orderId).toBe(order.orderId);
    assertValid("checkoutResponse", reply.body);
    expect(stepNames(reply.body.trace)).toEqual(FORWARD_STEPS);
    expect(reply.body.trace.map((t: { status: string }) => t.status)).toEqual(["success", "success", "success", "success"]);

    const payment = await logsOf(PAYMENT_URL);
    expect(payment.map((e) => [e.action, e.amount])).toEqual([["authorize", expectedAmount(order)]]);
    const notification = await logsOf(NOTIFICATION_URL);
    expect(notification.map((e) => [e.action, e.recipient])).toEqual([["send", order.customer.email]]);
  });

  it("4) the steps reach the mocks strictly one after another", async () => {
    const reply = await checkout(makeOrder(), newKey("sequence"));
    expectResponse(reply, 200);

    const times: number[] = [];
    for (const [url, action] of [
      [PAYMENT_URL, "authorize"],
      [INVENTORY_URL, "reserve"],
      [SHIPPING_URL, "create"],
      [NOTIFICATION_URL, "send"],
    ] as const) {
      const entry = (await logsOf(url)).find((e) => e.action === action);
      expect(entry, `${action} was never called`).toBeDefined();
      times.push(new Date(entry!.at).getTime());
    }
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    }
  });

  it("5) a refused payment is not retried, and nothing downstream is called", async () => {
    await configureMock(PAYMENT_URL, { paymentFailMode: "always" });

    const reply = await checkout(makeOrder(), newKey("pay-refused"));

    expectResponse(reply, 422);
    expect(reply.body.status).toBe("failed");
    expect(stepNames(reply.body.trace)).toEqual(["payment"]);
    expect(await actionsOf(PAYMENT_URL)).toEqual(["authorize"]);
    expect(await actionsOf(INVENTORY_URL)).toEqual([]);
    expect(await actionsOf(SHIPPING_URL)).toEqual([]);
    expect(await actionsOf(NOTIFICATION_URL)).toEqual([]);
  });

  it("6) a refused reservation is not retried, and the payment is refunded", async () => {
    await configureMock(INVENTORY_URL, { inventoryFailMode: "always" });

    const reply = await checkout(makeOrder(), newKey("inv-refused"));

    expectResponse(reply, 422);
    expect(reply.body.status).toBe("compensated");
    expect(stepNames(reply.body.trace)).toEqual(["payment", "inventory", "payment_refund"]);
    expect(await actionsOf(INVENTORY_URL)).toEqual(["reserve"]);
    expect(await actionsOf(PAYMENT_URL)).toEqual(["authorize", "refund"]);
    expect(await actionsOf(SHIPPING_URL)).toEqual([]);
  });

  it("7) a slow shipping call is tried exactly three times, then compensated with 504", async () => {
    await configureMock(SHIPPING_URL, { shippingDelayMs: 9000, shippingFailMode: "never" });

    const reply = await checkout(makeOrder(), newKey("ship-timeout"));

    expectResponse(reply, 504);
    expect(reply.body.code).toBe("timeout");
    expect(reply.body.status).toBe("compensated");
    expect(stepNames(reply.body.trace)).toEqual([...FORWARD_STEPS.slice(0, 3), "inventory_release", "payment_refund"]);
    expect(reply.body.trace[2].status).toBe("timeout");
    expect(await actionsOf(INVENTORY_URL)).toEqual(["reserve", "release"]);
    expect(await actionsOf(PAYMENT_URL)).toEqual(["authorize", "refund"]);

    // The mock logs a call when it answers, 9 s after it arrived. Wait for
    // every attempt to land, then make sure there was no fourth.
    await waitUntil(async () => (await countOf(SHIPPING_URL, "create")) >= 3, 20_000, "three shipping attempts");
    await sleep(1500);
    expect(await countOf(SHIPPING_URL, "create")).toBe(3);
  });

  it("8) killing the worker mid-saga: it resumes, and payment is not taken twice", async () => {
    await configureMock(SHIPPING_URL, { shippingDelayMs: 2000, shippingFailMode: "never" });
    const order = makeOrder();

    const { reply: pending } = await startAndWaitForInventory(order, newKey("crash"));
    await sleep(300); // shipping is now in flight
    docker("kill", WORKER_CONTAINER);
    await sleep(2000);
    docker("start", WORKER_CONTAINER);
    const reply = await pending;

    expectResponse(reply, 200);
    expect(reply.body.status).toBe("completed");
    expect(stepNames(reply.body.trace)).toEqual(FORWARD_STEPS);
    expect(await countOf(PAYMENT_URL, "authorize")).toBe(1);
    expect(await countOf(INVENTORY_URL, "reserve")).toBe(1);
    // The call that was in flight when the worker died did reach the mock.
    // Temporal cannot know that, so it runs the activity again: at least
    // once, not exactly once.
    expect([1, 2]).toContain(await countOf(SHIPPING_URL, "create"));
    expect(await countOf(NOTIFICATION_URL, "send")).toBe(1);
  });

  it("9) same key, same payload: the stored result, and the saga does not run again", async () => {
    const order = makeOrder();
    const key = newKey("replay");

    const first = await checkout(order, key);
    expectResponse(first, 200);
    const second = await checkout(order, key);

    expectResponse(second, 200);
    expect(second.body).toEqual(first.body);
    expect(await actionsOf(PAYMENT_URL)).toEqual(["authorize"]);
  });

  it("10) same key, different payload: 409 + idempotency_payload_mismatch", async () => {
    const order = makeOrder();
    const key = newKey("mismatch");

    const first = await checkout(order, key);
    expectResponse(first, 200);

    const changed = structuredClone(order);
    changed.items[0]!.quantity += 1;
    const mismatch = await checkout(changed, key);

    expectResponse(mismatch, 409);
    expect(mismatch.body.code).toBe("idempotency_payload_mismatch");
    expect(await actionsOf(PAYMENT_URL)).toEqual(["authorize"]);
  });

  it("11) same key while the first is still running: 409 + idempotency_conflict", async () => {
    await configureMock(SHIPPING_URL, { shippingDelayMs: 1500, shippingFailMode: "never" });
    const order = makeOrder();
    const key = newKey("in-flight");

    const { reply: pending } = await startAndWaitForInventory(order, key);
    const second = await checkout(order, key);
    const first = await pending;

    expectResponse(first, 200);
    expectResponse(second, 409);
    expect(second.body.code).toBe("idempotency_conflict");
    expect(await actionsOf(PAYMENT_URL)).toEqual(["authorize"]);
  });

  it("12) the audit mirror records the finished saga in PA6's schemas", async () => {
    const order = makeOrder();
    const key = newKey("mirror");

    const reply = await checkout(order, key);
    expectResponse(reply, 200);

    const idempotencyStore = loadStore("idempotency-store.json");
    const sagaStore = loadStore("saga-store.json");
    assertValid("idempotencyStore", idempotencyStore);
    assertValid("sagaStore", sagaStore);

    expect(idempotencyStore.records[key]).toMatchObject({ state: "completed", httpStatus: 200 });
    expect(idempotencyStore.records[key].response).toEqual(reply.body);
    expect(sagaStore.sagas[order.orderId]).toMatchObject({ idempotencyKey: key, state: "completed" });
    expect(stepNames(sagaStore.sagas[order.orderId].steps)).toEqual(FORWARD_STEPS);
  });
});
