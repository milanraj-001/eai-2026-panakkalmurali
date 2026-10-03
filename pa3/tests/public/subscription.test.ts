/**
 * The router must genuinely extend to a third item type, not just
 * reproduce physical/digital. A 4-item order with one subscription item
 * should route it to the subscription worker and complete normally.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitOrder } from "./lib/orders.js";
import {
  startCompletionListener,
  stopCompletionListener,
  waitForCompletion,
} from "./lib/amqp.js";
import { ensureAllWorkersRunning } from "./lib/docker.js";
import { sleep } from "./lib/env.js";

describe("content-based router -- subscription item type", () => {
  beforeAll(async () => {
    ensureAllWorkersRunning();
    await sleep(500);
    await startCompletionListener();
  });

  afterAll(async () => {
    await stopCompletionListener();
  });

  it("routes a 4-item order including a subscription item, and completes with all 4 results", async () => {
    const order = await submitOrder("cust-sub", [
      { type: "physical", name: "Router", price: 129.99 },
      { type: "digital", name: "Firmware License", price: 9.99 },
      { type: "subscription", name: "Support Plan - Monthly", price: 14.99 },
      { type: "physical", name: "Cable", price: 12.99 },
    ]);

    const completion = await waitForCompletion(order.orderId);

    expect(completion.status).toBe("complete");
    expect(completion.totalItems).toBe(4);
    expect(completion.receivedItems).toBe(4);
    expect(completion.itemResults).toHaveLength(4);
    expect(completion.missingItemIndexes).toEqual([]);

    // The subscription worker's result carries a confirmationCode field
    // (see starter/subscription-worker/app.py) -- proof the item actually
    // went through the subscription path, not a physical/digital default.
    const results = completion.itemResults as Array<Record<string, unknown>>;
    const subscriptionResult = results.find(
      (r) => typeof r.confirmationCode === "string",
    );
    expect(subscriptionResult).toBeDefined();
  });
});
