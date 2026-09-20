/**
 * PA2 public tests — demonstration (b): with the consumer stopped, messages
 * accumulate in the queue rather than being lost, and nothing goes missing
 * once the consumer comes back.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  CONSUMER_CONTAINER,
  dockerStart,
  dockerStop,
  publish,
  queueDepth,
  stableQueueDepth,
  testCorrelationId,
  waitForCorrelationIds,
  waitForProducerReady,
  waitForQueueDepth,
} from "./support";

const BATCH_SIZE = 5;

beforeAll(async () => {
  await waitForProducerReady();
}, 150_000);

describe("demonstration (b) — consumer stopped, messages accumulate", () => {
  it(
    "the queue depth rises by exactly the number sent while the consumer is down, then drains to zero loss once it restarts",
    async () => {
      await dockerStop(CONSUMER_CONTAINER);

      // The consumer being stopped for the rest of this run — if anything
      // below throws — would fail every later test file's readiness check
      // for a reason that has nothing to do with what they're testing. A
      // try/finally guarantees the restart happens exactly once, whether or
      // not the assertions in between pass.
      let baseline!: number;
      let ids!: string[];
      try {
        baseline = await stableQueueDepth();

        ids = Array.from({ length: BATCH_SIZE }, (_, i) => testCorrelationId(`accumulate-${i}`));
        for (const [i, correlationId] of ids.entries()) {
          const { status } = await publish({ orderId: `ORD-3${i}` }, { correlationId });
          expect(status).toBe(202);
        }

        const depthWithConsumerStopped = await waitForQueueDepth(
          (depth) => depth >= baseline + BATCH_SIZE,
          20_000,
        );
        expect(depthWithConsumerStopped).toBeGreaterThanOrEqual(baseline + BATCH_SIZE);
      } finally {
        await dockerStart(CONSUMER_CONTAINER);
      }

      const found = await waitForCorrelationIds(ids, 45_000);
      expect(found.size, `only ${found.size}/${BATCH_SIZE} messages were delivered after the consumer restarted`).toBe(
        BATCH_SIZE,
      );

      const depthAfterDrain = await waitForQueueDepth((depth) => depth <= baseline, 30_000);
      expect(depthAfterDrain).toBeLessThanOrEqual(baseline);
    },
    120_000,
  );
});
