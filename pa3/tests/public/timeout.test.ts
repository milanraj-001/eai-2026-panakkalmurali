/**
 * AGGREGATOR -- timeout / partial result.
 *
 * One worker never responds (we stop digital-worker outright, rather than
 * just being slow) -- the aggregator must not hang forever waiting for
 * that item. It must emit a partial completion once its idle timeout
 * elapses, flagging what it never received.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitOrder } from "./lib/orders.js";
import {
  startCompletionListener,
  stopCompletionListener,
  waitForCompletion,
} from "./lib/amqp.js";
import {
  ensureAllWorkersRunning,
  startService,
  stopService,
} from "./lib/docker.js";
import { AGGREGATOR_IDLE_TIMEOUT_SECONDS, sleep } from "./lib/env.js";

describe("aggregator -- partial result when a worker never answers", () => {
  beforeAll(async () => {
    ensureAllWorkersRunning();
    await sleep(500);
    await startCompletionListener();
  });

  afterAll(async () => {
    ensureAllWorkersRunning();
    await stopCompletionListener();
  });

  it(
    "completes within the timeout, flagged partial, once one worker never answers",
    async () => {
      stopService("digital-worker");
      // Let the stop land before the order is even published, so there is
      // no chance the digital item slips through before the container
      // actually stops.
      await sleep(500);

      try {
        const order = await submitOrder("cust-timeout", [
          { type: "physical", name: "Monitor", price: 249.99 },
          // This is the item that will never get a result: digital-worker
          // is stopped, and nothing else consumes orders.digital.
          { type: "digital", name: "Streaming Pass", price: 9.99 },
        ]);

        const completion = await waitForCompletion(
          order.orderId,
          (AGGREGATOR_IDLE_TIMEOUT_SECONDS + 15) * 1000,
        );

        expect(completion.status).toBe("partial");
        expect(completion.totalItems).toBe(2);
        expect(completion.receivedItems).toBe(1);
        expect(completion.itemResults).toHaveLength(1);
        expect(completion.missingItemIndexes).toEqual([1]);
      } finally {
        // Restore the worker regardless of outcome, so later tests (and
        // later runs) start from a healthy stack.
        startService("digital-worker");
      }
    },
    (AGGREGATOR_IDLE_TIMEOUT_SECONDS + 20) * 1000,
  );
});
