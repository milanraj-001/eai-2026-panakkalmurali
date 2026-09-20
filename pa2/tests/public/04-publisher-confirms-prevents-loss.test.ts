/**
 * PA2 public tests — demonstration (c): a message published WITHOUT
 * publisher confirms can be lost when the broker dies at the wrong moment;
 * publishing WITH confirms fixes it.
 *
 * How this is made deterministic rather than a network timing race:
 * `X-Publish-Mode: fire-and-forget` does not just skip the confirm
 * handshake, it also skips `persistent: true` — see src/producer.ts and
 * docs/adr-001.md. A non-persistent message on a durable queue is dropped
 * whenever the broker goes down without a clean shutdown. `docker restart`
 * is not that: it sends SIGTERM and waits, giving RabbitMQ time to perform
 * an orderly shutdown that can flush even non-persistent messages to disk
 * first — which would turn this into a race this test sometimes loses. So
 * this test kills the broker outright (SIGKILL, no grace period) rather
 * than restarting it, the same way the hidden suite's larger-batch version
 * of this scenario does.
 *
 * The trade-off that comes with the persistent-flag choice: this test
 * demonstrates "no confirms behaves unsafely" rather than isolating the
 * confirm mechanism from the persistent-delivery-mode flag byte-for-byte.
 * In real, unguarded fire-and-forget code the two failures show up together
 * anyway — a producer that never waits for a confirm has no way to know
 * whether a message reached disk, so it has no reason to be disciplined
 * about the persistent flag either. Flagged in the WP-10 report for a
 * second look.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  CONSUMER_CONTAINER,
  RABBITMQ_CONTAINER,
  dockerKill,
  dockerStart,
  dockerStop,
  publish,
  queueDepth,
  stableQueueDepth,
  readReceivedLines,
  testCorrelationId,
  waitForContainerHealthy,
  waitForCorrelationIds,
  waitForProducerReady,
  waitForQueueDepth,
} from "./support";

const BATCH_SIZE = 5;

beforeAll(async () => {
  await waitForProducerReady();
}, 150_000);

describe("demonstration (c) — confirms are what make delivery safe", () => {
  it(
    "without confirms (fire-and-forget), messages sitting in the queue do not survive a broker restart",
    async () => {
      await dockerStop(CONSUMER_CONTAINER);

      // Guarantee the consumer restart happens even if an assertion in
      // between throws — leaving it stopped would fail every later test
      // file's readiness check for a reason unrelated to what they test.
      let baseline!: number;
      let ids!: string[];
      try {
        baseline = await stableQueueDepth();

        ids = Array.from({ length: BATCH_SIZE }, (_, i) => testCorrelationId(`unsafe-${i}`));
        for (const [i, correlationId] of ids.entries()) {
          const { status } = await publish(
            { orderId: `ORD-4U${i}` },
            { correlationId, mode: "fire-and-forget" },
          );
          expect(status).toBe(202);
        }

        // Confirm they did land in the queue before the broker goes down —
        // otherwise "they're gone" would just mean "they never arrived",
        // which is a different (and less interesting) failure.
        await waitForQueueDepth((depth) => depth >= baseline + BATCH_SIZE, 15_000);

        await dockerKill(RABBITMQ_CONTAINER);
        await dockerStart(RABBITMQ_CONTAINER);
        await waitForContainerHealthy(RABBITMQ_CONTAINER, 60_000);

        // stableQueueDepth, not a single read: the management API's stats
        // snapshot needs a moment to catch up after the broker comes back, and
        // a read taken too early can still show the pre-restart count.
        const depthAfterRestart = await stableQueueDepth();
        expect(
          depthAfterRestart,
          "the non-persistent, unconfirmed messages should not have survived the restart",
        ).toBeLessThanOrEqual(baseline);
      } finally {
        await dockerStart(CONSUMER_CONTAINER);
      }
      await waitForProducerReady(60_000);

      // Give the consumer a real chance to catch up on anything that *did*
      // survive, then check the ids from this batch specifically.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const survivors = readReceivedLines().filter((line) => ids.includes(line.correlationId));
      expect(survivors.length, "fire-and-forget mode did not lose anything this run").toBeLessThan(
        BATCH_SIZE,
      );
    },
    120_000,
  );

  it(
    "with confirms (the default), the same scenario loses nothing",
    async () => {
      await dockerStop(CONSUMER_CONTAINER);

      // Same reasoning as the fire-and-forget scenario above: guarantee the
      // restart happens even if an assertion in between throws.
      let baseline!: number;
      let ids!: string[];
      try {
        baseline = await stableQueueDepth();

        ids = Array.from({ length: BATCH_SIZE }, (_, i) => testCorrelationId(`confirmed-${i}`));
        for (const [i, correlationId] of ids.entries()) {
          // Default mode: "confirmed". The 202 here does not return until the
          // broker has acknowledged the message, so by the time this loop
          // finishes every one of these is already durably in the queue.
          const { status } = await publish({ orderId: `ORD-4C${i}` }, { correlationId });
          expect(status).toBe(202);
        }

        const depthBeforeRestart = await waitForQueueDepth((depth) => depth >= baseline + BATCH_SIZE, 15_000);
        expect(depthBeforeRestart).toBeGreaterThanOrEqual(baseline + BATCH_SIZE);

        await dockerKill(RABBITMQ_CONTAINER);
        await dockerStart(RABBITMQ_CONTAINER);
        await waitForContainerHealthy(RABBITMQ_CONTAINER, 60_000);

        const depthAfterRestart = await stableQueueDepth();
        expect(depthAfterRestart).toBeGreaterThanOrEqual(baseline + BATCH_SIZE);
      } finally {
        await dockerStart(CONSUMER_CONTAINER);
      }
      await waitForProducerReady(60_000);

      const found = await waitForCorrelationIds(ids, 45_000);
      expect(found.size, `only ${found.size}/${BATCH_SIZE} confirmed messages survived — none should be lost`).toBe(
        BATCH_SIZE,
      );
    },
    120_000,
  );
});
