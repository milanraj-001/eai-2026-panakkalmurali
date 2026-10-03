/**
 * SPLITTER + CONTENT-BASED ROUTER
 *
 * A 3-item order must become exactly 3 item messages, each carrying the
 * originating orderId, routed to the queue that matches its item type.
 *
 * To check this without racing the real workers for the messages, we stop
 * every downstream worker first, submit the order, then read the queues
 * back with the RabbitMQ management API's non-destructive "get"
 * (requeue=true) -- the messages go right back where they were, so the
 * workers still process them normally once restarted at the end.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitOrder } from "./lib/orders.js";
import { peekQueue } from "./lib/management.js";
import { ensureAllWorkersRunning, stopService } from "./lib/docker.js";
import { QUEUES, sleep } from "./lib/env.js";

interface ItemMessage {
  orderId: string;
  correlationId: string;
  itemIndex: number;
  totalItems: number;
  item: { type: string; name: string; price: number };
}

const DOWNSTREAM_WORKERS = [
  "inventory-worker",
  "digital-worker",
  "subscription-worker",
  "aggregator-service",
];

describe("splitter + content-based router", () => {
  let orderId: string;

  beforeAll(async () => {
    ensureAllWorkersRunning();
    // Give router-service a moment in case it was mid-restart.
    await sleep(500);

    stopService(...DOWNSTREAM_WORKERS);
    // Let the stop actually land before we publish.
    await sleep(500);

    const order = await submitOrder("cust-routing", [
      { type: "physical", name: "Keyboard", price: 79.99 },
      { type: "physical", name: "Mouse", price: 29.99 },
      { type: "digital", name: "Software License", price: 49.99 },
    ]);
    orderId = order.orderId;

    // Give router-service time to consume orders.incoming and publish.
    await sleep(2_000);
  });

  afterAll(() => {
    ensureAllWorkersRunning();
  });

  it("produces exactly 3 messages total across orders.physical and orders.digital", async () => {
    const physical = await peekQueue<ItemMessage>(QUEUES.physical);
    const digital = await peekQueue<ItemMessage>(QUEUES.digital);
    const mine = [...physical, ...digital].filter(
      (m) => m.payload.orderId === orderId,
    );
    expect(mine).toHaveLength(3);
  });

  it("routes the 2 physical items to orders.physical", async () => {
    const physical = await peekQueue<ItemMessage>(QUEUES.physical);
    const mine = physical.filter((m) => m.payload.orderId === orderId);
    expect(mine).toHaveLength(2);
    for (const m of mine) expect(m.payload.item.type).toBe("physical");
  });

  it("routes the 1 digital item to orders.digital", async () => {
    const digital = await peekQueue<ItemMessage>(QUEUES.digital);
    const mine = digital.filter((m) => m.payload.orderId === orderId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.payload.item.type).toBe("digital");
  });

  it("carries the originating orderId and correlationId on every item message", async () => {
    const physical = await peekQueue<ItemMessage>(QUEUES.physical);
    const digital = await peekQueue<ItemMessage>(QUEUES.digital);
    const mine = [...physical, ...digital].filter(
      (m) => m.payload.orderId === orderId,
    );
    expect(mine.length).toBeGreaterThan(0);
    for (const m of mine) {
      expect(m.payload.orderId).toBe(orderId);
      expect(m.payload.correlationId).toBe(orderId);
      expect(m.payload.totalItems).toBe(3);
    }
  });

  it("assigns each item a distinct itemIndex covering the whole order", async () => {
    const physical = await peekQueue<ItemMessage>(QUEUES.physical);
    const digital = await peekQueue<ItemMessage>(QUEUES.digital);
    const mine = [...physical, ...digital].filter(
      (m) => m.payload.orderId === orderId,
    );
    const indexes = mine.map((m) => m.payload.itemIndex).sort();
    expect(indexes).toEqual([0, 1, 2]);
  });
});
