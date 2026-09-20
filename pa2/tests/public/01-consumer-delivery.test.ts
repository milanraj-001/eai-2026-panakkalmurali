/**
 * PA2 public tests — end to end delivery, and the correlationId reaching
 * the consumer's log line via received.jsonl.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  publish,
  readReceivedLines,
  testCorrelationId,
  waitForCorrelationIds,
  waitForProducerReady,
} from "./support";

beforeAll(async () => {
  await waitForProducerReady();
}, 150_000);

describe("delivery — producer to consumer to received.jsonl", () => {
  it("delivers a published message to received.jsonl with the same correlationId", async () => {
    const correlationId = testCorrelationId("delivery");
    const payload = { orderId: "ORD-100", note: "round trip" };

    const { status } = await publish(payload, { correlationId });
    expect(status).toBe(202);

    const found = await waitForCorrelationIds([correlationId], 30_000);
    const line = found.get(correlationId);
    expect(line, "message never appeared in received.jsonl").toBeDefined();
    expect(line?.payload).toEqual(payload);
  });

  it("writes one well-formed JSON object per line", async () => {
    const correlationId = testCorrelationId("jsonl-shape");
    await publish({ orderId: "ORD-101" }, { correlationId });
    await waitForCorrelationIds([correlationId], 30_000);

    // If this throws, something is writing content that is not valid JSONL.
    const lines = readReceivedLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(typeof line.correlationId).toBe("string");
      expect(typeof line.receivedAt).toBe("string");
      expect(Number.isNaN(Date.parse(line.receivedAt))).toBe(false);
    }
  });

  it("keeps unrelated messages out of each other's way", async () => {
    const a = testCorrelationId("a");
    const b = testCorrelationId("b");
    await publish({ orderId: "ORD-A" }, { correlationId: a });
    await publish({ orderId: "ORD-B" }, { correlationId: b });

    const found = await waitForCorrelationIds([a, b], 30_000);
    expect(found.get(a)?.payload).toEqual({ orderId: "ORD-A" });
    expect(found.get(b)?.payload).toEqual({ orderId: "ORD-B" });
  });
});
