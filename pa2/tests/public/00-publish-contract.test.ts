/**
 * PA2 public tests — the HTTP contract of POST /publish.
 *
 * Run against the real stack: `docker compose up -d --wait && npm test` in
 * pa2/starter.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { publish, testCorrelationId, waitForProducerReady } from "./support";

beforeAll(async () => {
  await waitForProducerReady();
}, 150_000);

describe("POST /publish — contract", () => {
  it("accepts a JSON body and returns 202 with a correlationId", async () => {
    const { status, body } = await publish({ orderId: "ORD-1" });
    expect(status).toBe(202);
    expect(typeof body.correlationId).toBe("string");
    expect((body.correlationId as string).length).toBeGreaterThan(0);
  });

  it("generates a different correlationId for each request that supplies none", async () => {
    const first = await publish({ orderId: "ORD-2" });
    const second = await publish({ orderId: "ORD-3" });
    expect(first.body.correlationId).not.toBe(second.body.correlationId);
  });

  it("echoes back a supplied X-Correlation-Id instead of generating one", async () => {
    const correlationId = testCorrelationId("echo");
    const { status, body } = await publish({ orderId: "ORD-4" }, { correlationId });
    expect(status).toBe(202);
    expect(body.correlationId).toBe(correlationId);
  });

  it("rejects a malformed X-Correlation-Id instead of silently accepting it", async () => {
    // Whitespace is not in the allowed pattern. Silently accepting arbitrary
    // header content is how control characters end up inside received.jsonl.
    const { status } = await publish({ orderId: "ORD-5" }, { correlationId: "not a valid id" });
    expect(status).toBe(400);
  });

  it("rejects a body that is not valid JSON", async () => {
    const res = await fetch("http://localhost:3001/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown X-Publish-Mode instead of silently defaulting", async () => {
    const res = await fetch("http://localhost:3001/publish", {
      method: "POST",
      headers: { "content-type": "application/json", "x-publish-mode": "yolo" },
      body: JSON.stringify({ orderId: "ORD-6" }),
    });
    expect(res.status).toBe(400);
  });
});
