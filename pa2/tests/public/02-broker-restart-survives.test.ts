/**
 * PA2 public tests — demonstration (a): a published message survives
 * `docker restart pa2-rabbitmq`.
 *
 * The consumer is stopped first and deliberately restarted only near the
 * end. That is what makes this a test of the QUEUE's durability rather
 * than of a message that had already reached the consumer before the
 * broker went down — if the consumer were left running, a message could
 * pass this test just by having been consumed before the restart, which
 * would prove nothing about `durable: true` or `persistent: true`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  CONSUMER_CONTAINER,
  RABBITMQ_CONTAINER,
  dockerRestart,
  dockerStart,
  dockerStop,
  publish,
  queueDepth,
  stableQueueDepth,
  testCorrelationId,
  waitForContainerHealthy,
  waitForCorrelationIds,
  waitForProducerReady,
  waitForQueueDepth,
} from "./support";

beforeAll(async () => {
  await waitForProducerReady();
}, 150_000);

describe("demonstration (a) — survives docker restart pa2-rabbitmq", () => {
  it(
    "a durable, confirmed message is still in the queue after the broker restarts, and the consumer catches up",
    async () => {
      await dockerStop(CONSUMER_CONTAINER);

      // Guarantee the consumer restart happens even if an assertion in
      // between throws — leaving it stopped would fail every later test
      // file's readiness check for a reason unrelated to what they test.
      const before = testCorrelationId("restart-before");
      let baseline!: number;
      try {
        baseline = await stableQueueDepth();

        const publishResult = await publish({ orderId: "ORD-200" }, { correlationId: before });
        expect(publishResult.status).toBe(202);

        await waitForQueueDepth((depth) => depth >= baseline + 1, 15_000);

        await dockerRestart(RABBITMQ_CONTAINER);
        await waitForContainerHealthy(RABBITMQ_CONTAINER, 60_000);

        // Still there — nobody consumed it, and the broker restart did not
        // wipe it, because the queue is durable and the message persistent.
        // stableQueueDepth, not a single read: the management API's stats
        // snapshot needs a moment to catch up after the broker comes back.
        const depthAfterRestart = await stableQueueDepth();
        expect(depthAfterRestart).toBeGreaterThanOrEqual(baseline + 1);
      } finally {
        await dockerStart(CONSUMER_CONTAINER);
      }

      const after = testCorrelationId("restart-after");
      await waitForProducerReady(60_000); // the producer reconnects on its own; give it room
      const secondPublish = await publish({ orderId: "ORD-201" }, { correlationId: after });
      expect(secondPublish.status).toBe(202);

      const found = await waitForCorrelationIds([before, after], 45_000);
      expect(found.get(before), "the pre-restart message was lost").toBeDefined();
      expect(found.get(after), "publishing after the restart did not work").toBeDefined();
    },
    120_000,
  );
});
