/**
 * AGGREGATOR -- happy path.
 *
 * All workers are up, nothing is stopped: submit a 3-item order and
 * expect exactly one completion message on orders.complete, status
 * "complete", with all 3 results and no missing indexes.
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

describe("aggregator -- completes when every item reports in", () => {
  beforeAll(async () => {
    ensureAllWorkersRunning();
    await sleep(500);
    await startCompletionListener();
  });

  afterAll(async () => {
    await stopCompletionListener();
  });

  it("emits one completion message with all 3 results, correlated by orderId", async () => {
    const order = await submitOrder("cust-agg", [
      { type: "physical", name: "Laptop", price: 999.99 },
      { type: "digital", name: "E-Book", price: 19.99 },
      { type: "physical", name: "Mouse", price: 29.99 },
    ]);

    const completion = await waitForCompletion(order.orderId);

    expect(completion.orderId).toBe(order.orderId);
    expect(completion.status).toBe("complete");
    expect(completion.totalItems).toBe(3);
    expect(completion.receivedItems).toBe(3);
    expect(completion.itemResults).toHaveLength(3);
    expect(completion.missingItemIndexes).toEqual([]);
  });

  it("does not mix up two orders submitted back to back", async () => {
    const [orderA, orderB] = await Promise.all([
      submitOrder("cust-agg-a", [
        { type: "physical", name: "Chair", price: 59.99 },
        { type: "digital", name: "Manual PDF", price: 4.99 },
      ]),
      submitOrder("cust-agg-b", [
        { type: "digital", name: "Theme", price: 9.99 },
        { type: "digital", name: "Font Pack", price: 14.99 },
        { type: "physical", name: "Desk", price: 199.99 },
      ]),
    ]);

    const [completionA, completionB] = await Promise.all([
      waitForCompletion(orderA.orderId),
      waitForCompletion(orderB.orderId),
    ]);

    expect(completionA.orderId).toBe(orderA.orderId);
    expect(completionA.totalItems).toBe(2);
    expect(completionA.itemResults).toHaveLength(2);

    expect(completionB.orderId).toBe(orderB.orderId);
    expect(completionB.totalItems).toBe(3);
    expect(completionB.itemResults).toHaveLength(3);
  });
});
