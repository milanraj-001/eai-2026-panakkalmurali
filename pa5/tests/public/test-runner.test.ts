/**
 * Tests 1–7 are ported from the JS lab's test/test-runner.test.js and are
 * unchanged in behaviour — every assertion about retry counts, DLQ arrival,
 * idempotency, correlation-id propagation, timing, and exchange/queue
 * topology is the same. Tests 8–10 were added for autumn 2026: the services
 * declare the dead letter and invalid message channels themselves, classify
 * a malformed message as permanent, and replay the DLQ. The one deliberate
 * change to tests 1–7 is postOrder(): it now
 * POSTs a canonical order (../../canonical/order.schema.json) instead of the
 * lab's ad-hoc {customerId, items, totalAmount, orderType} shape — see
 * docs/adr-004.md.
 *
 * Two fixes applied during the TS port, both operational, neither changing
 * what is asserted:
 *   - `docker-compose` (hyphenated v1 CLI) -> `docker compose` (v2), which is
 *     the only CLI installed in this course's environment.
 *   - restartService() retries its "up" step once if it throws, so a
 *     transient docker-daemon hiccup between "stop" and "up" cannot leave a
 *     service down for every later test in this file — tests run serially
 *     (fileParallelism: false, see ../vitest.config.ts), so a service left
 *     down here would otherwise fail every subsequent test for an unrelated
 *     reason.
 */

import { exec } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import amqp from "amqplib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  closeQuietly,
  connectToRabbit,
  consumeFromQueue,
  getBindings,
  getConsumerCount,
  getExchangeInfo,
  getQueueInfo,
  purgeQueue,
} from "./helpers/rabbit-helper.js";
import type { CanonicalOrder } from "../../shared/canonical-order.js";

const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL ?? "http://localhost:3002";
const RABBIT_MGMT_URL = process.env.RABBITMQ_MGMT_URL_OVERVIEW ?? "http://localhost:15674/api/overview";
const RABBIT_MGMT_USER = process.env.RABBITMQ_MGMT_USER ?? "eai";
const RABBIT_MGMT_PASS = process.env.RABBITMQ_MGMT_PASS ?? "eai-pa5";
const RABBITMQ_URL = process.env.RABBITMQ_URL ?? "amqp://eai:eai-pa5@localhost:5674";

// tests/public/test-runner.test.ts -> pa5/
const PA5_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const COMPOSE_FILE = path.join(PA5_ROOT, "docker-compose.yml");
const NOTIFICATION_LOG_FILE = path.join(PA5_ROOT, "notification-service", "data", "notification.log");
const PROCESSED_IDS_FILE = path.join(PA5_ROOT, "notification-service", "data", "processed-ids.json");

const resultQueues = ["payment.results", "inventory.results", "notification.results"];
const allQueues = [
  "payments.queue",
  "inventory.queue",
  "notifications.queue",
  "payments.retry.queue",
  "inventory.retry.queue",
  "notifications.retry.queue",
  "orders.dlq",
  "orders.invalid",
  ...resultQueues,
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command: string, envOverrides: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { cwd: PA5_ROOT, env: { ...process.env, ...envOverrides } },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${command}\n${stderr || stdout || error.message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function restartService(serviceName: string, envOverrides: Record<string, string> = {}): Promise<void> {
  await runCommand(`docker compose -f "${COMPOSE_FILE}" stop ${serviceName}`);

  const upCmd = `docker compose -f "${COMPOSE_FILE}" up -d ${serviceName}`;
  try {
    await runCommand(upCmd, envOverrides);
  } catch (err) {
    // A stopped service that never comes back up would fail every later
    // test in this file, for a reason unrelated to whatever that test is
    // actually checking (see file header). One retry before giving up.
    console.warn(
      `[Test] restartService: first "up" attempt for ${serviceName} failed (${(err as Error).message}); retrying once`,
    );
    await runCommand(upCmd, envOverrides);
  } finally {
    await sleep(4000);
  }
}

function canonicalOrderFixture(): CanonicalOrder {
  return {
    orderId: "WEB-2026-001",
    orderType: "standard",
    source: "web",
    receivedAt: new Date().toISOString(),
    orderDate: "2026-09-01T10:30:00Z",
    customer: {
      name: "Anna Bērziņa",
      email: "anna.berzina@example.com",
      address: {
        street: "Brīvības iela 100",
        city: "Rīga",
        postalCode: "LV-1001",
        country: "LV",
      },
    },
    items: [
      { productId: "PROD-001", productName: "Wireless Mouse", quantity: 2, unitPrice: "22.50", currency: "EUR", taxRate: 0.21 },
      { productId: "PROD-002", productName: "USB-C Hub", quantity: 1, unitPrice: "45.30", currency: "EUR", taxRate: 0.21 },
    ],
    currency: "EUR",
    status: "new",
  };
}

async function postOrder(): Promise<{ response: Response; body: unknown; payload: CanonicalOrder }> {
  const payload = canonicalOrderFixture();

  const response = await fetch(`${ORDER_SERVICE_URL}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  const body = await response.json().catch(() => undefined);
  return { response, body, payload };
}

function isUuidV4(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

async function purgeKnownQueues(): Promise<void> {
  for (const queueName of allQueues) {
    try {
      await purgeQueue(queueName);
    } catch (err) {
      console.warn(`[Test] Failed to purge ${queueName}: ${(err as Error).message}`);
    }
  }
}

describe("Practice 2 Event-Driven Messaging (ported to TypeScript)", () => {
  // Not part of the ported behavior — infrastructure only, added during
  // verification. `docker compose up --wait` confirms each service's HTTP
  // health endpoint answers, but that says nothing about whether it has
  // finished connecting to RabbitMQ and registering as a consumer yet
  // (tsx's startup overhead widens this window compared to the original
  // plain-node lab). Without this, test 1's one-shot consumer-count check
  // can race a not-yet-registered consumer on a cold start and fail for a
  // reason that has nothing to do with what it's actually testing. Counts
  // come live from the broker (getConsumerCount), not from the management
  // API's stats, which lag by up to ~5 s after a container is replaced.
  beforeAll(async () => {
    const deadline = Date.now() + 60_000;
    const queues = ["payments.queue", "inventory.queue", "notifications.queue"];
    for (const queueName of queues) {
      for (;;) {
        try {
          if ((await getConsumerCount(queueName)) >= 1) break;
        } catch {
          // queue may not be declared yet; keep polling
        }
        if (Date.now() > deadline) {
          throw new Error(`consumer for ${queueName} never registered within 60s`);
        }
        await sleep(1_000);
      }
    }
  }, 90_000);

  afterAll(async () => {
    // Best effort: restore defaults expected by other tests/other runs.
    try {
      await restartService("payment-service", { PAYMENT_FAIL_RATE: "20" });
    } catch (err) {
      console.warn(`[Test] Payment service reset warning: ${(err as Error).message}`);
    }

    try {
      await restartService("inventory-service", { INVENTORY_FAIL_RATE: "10" });
    } catch (err) {
      console.warn(`[Test] Inventory service reset warning: ${(err as Error).message}`);
    }

    try {
      await restartService("notification-service");
    } catch (err) {
      console.warn(`[Test] Notification service reset warning: ${(err as Error).message}`);
    }
  });

  test("1) services start without errors", async () => {
    const health = await fetch(`${ORDER_SERVICE_URL}/health`, { signal: AbortSignal.timeout(10_000) });
    expect(health.status).toBe(200);

    const mgmtAuth = "Basic " + Buffer.from(`${RABBIT_MGMT_USER}:${RABBIT_MGMT_PASS}`).toString("base64");
    const mgmt = await fetch(RABBIT_MGMT_URL, {
      headers: { Authorization: mgmtAuth },
      signal: AbortSignal.timeout(10_000),
    });
    expect(mgmt.status).toBe(200);

    for (const queueName of ["payments.queue", "inventory.queue", "notifications.queue"]) {
      expect(await getConsumerCount(queueName), `${queueName} must have a consumer`).toBeGreaterThan(0);
    }
  });

  test("2) POST /orders returns valid correlation ID and order can be fetched", async () => {
    const { response, body } = await postOrder();
    expect(response.status).toBe(201);
    expect(body).toBeDefined();
    const data = body as { correlationId?: string; status?: string };
    expect(data.status).toBe("accepted");
    expect(typeof data.correlationId).toBe("string");
    expect(isUuidV4(data.correlationId)).toBe(true);

    const getResp = await fetch(`${ORDER_SERVICE_URL}/orders/${data.correlationId}`, {
      signal: AbortSignal.timeout(10_000),
    });
    expect(getResp.status).toBe(200);
    const getBody = (await getResp.json()) as { correlationId?: string };
    expect(getBody.correlationId).toBe(data.correlationId);
  });

  test("3) exchange and queue topology is correct", async () => {
    const exchange = await getExchangeInfo("orders.exchange");
    expect(exchange).toBeDefined();
    expect(exchange.type).toBe("fanout");

    for (const queueName of ["payments.queue", "inventory.queue", "notifications.queue"]) {
      const info = await getQueueInfo(queueName);
      expect(info).toBeDefined();
      expect(await getConsumerCount(queueName), `${queueName} must have a consumer`).toBeGreaterThanOrEqual(1);
    }
  });

  test("4) DLQ receives failed messages after retries", async () => {
    await purgeKnownQueues();
    await restartService("payment-service", { PAYMENT_FAIL_RATE: "100" });

    const { response, body } = await postOrder();
    expect(response.status).toBe(201);
    const expectedCorrelationId = (body as { correlationId: string }).correlationId;

    await sleep(6000);

    const { connection, channel } = await connectToRabbit();
    const dlqMessages = await consumeFromQueue(channel, "orders.dlq", 10_000, 3);
    await channel.close();
    await connection.close();

    expect(dlqMessages.length).toBeGreaterThan(0);

    const matching = dlqMessages.find(
      (m) => (m.properties?.headers as Record<string, unknown> | undefined)?.["correlationId"] === expectedCorrelationId,
    );
    expect(matching).toBeDefined();
  });

  test("5) correlation ID is propagated through all consumers", async () => {
    await purgeKnownQueues();
    await restartService("payment-service", { PAYMENT_FAIL_RATE: "0" });
    await restartService("inventory-service", { INVENTORY_FAIL_RATE: "0" });

    const { response, body } = await postOrder();
    expect(response.status).toBe(201);
    const expectedCorrelationId = (body as { correlationId: string }).correlationId;

    const { connection, channel } = await connectToRabbit();

    const paymentMsgs = await consumeFromQueue(channel, "payment.results", 10_000, 5);
    const inventoryMsgs = await consumeFromQueue(channel, "inventory.results", 10_000, 5);
    const notificationMsgs = await consumeFromQueue(channel, "notification.results", 10_000, 5);

    await channel.close();
    await connection.close();

    const headerCorrelationId = (m: { properties?: { headers?: unknown } }) =>
      (m.properties?.headers as Record<string, unknown> | undefined)?.["correlationId"];

    const payment = paymentMsgs.find((m) => headerCorrelationId(m) === expectedCorrelationId);
    const inventory = inventoryMsgs.find((m) => headerCorrelationId(m) === expectedCorrelationId);
    const notification = notificationMsgs.find((m) => headerCorrelationId(m) === expectedCorrelationId);

    expect(payment).toBeDefined();
    expect(inventory).toBeDefined();
    expect(notification).toBeDefined();
  });

  test("6) notification service is idempotent", async () => {
    await purgeKnownQueues();

    try {
      unlinkSync(NOTIFICATION_LOG_FILE);
    } catch {
      // fine if it does not exist yet
    }
    try {
      unlinkSync(PROCESSED_IDS_FILE);
    } catch {
      // fine if it does not exist yet
    }

    await restartService("notification-service");

    const { response, body } = await postOrder();
    expect(response.status).toBe(201);
    const correlationId = (body as { correlationId: string }).correlationId;

    await sleep(3000);

    const logContent = readFileSync(NOTIFICATION_LOG_FILE, "utf8").trim();
    const lines = logContent ? logContent.split("\n") : [];
    expect(lines.length).toBe(1);

    const firstEntry = JSON.parse(lines[0]!) as { correlationId: string; orderId: string; customerEmail: string };
    expect(firstEntry.correlationId).toBe(correlationId);

    const processedRaw = readFileSync(PROCESSED_IDS_FILE, "utf8");
    const processedIds = JSON.parse(processedRaw) as unknown[];
    expect(Array.isArray(processedIds)).toBe(true);
    expect(processedIds).toContain(correlationId);

    const { connection, channel } = await connectToRabbit();

    // Simulates an at-least-once redelivery — an ack lost after the log line
    // was written, or a producer that published twice: the same
    // correlationId, sent again directly to notifications.queue. Content is
    // a fresh canonical order (reusing the logged orderId) — irrelevant to
    // the assertion, which is about correlationId-keyed dedup, not the body.
    const duplicateOrder: CanonicalOrder = {
      ...canonicalOrderFixture(),
      orderId: firstEntry.orderId,
      customer: {
        ...canonicalOrderFixture().customer,
        email: firstEntry.customerEmail,
      },
    };

    channel.sendToQueue("notifications.queue", Buffer.from(JSON.stringify(duplicateOrder)), {
      headers: { correlationId },
      contentType: "application/json",
    });

    await channel.close();
    await connection.close();

    await sleep(3000);

    const secondLogContent = readFileSync(NOTIFICATION_LOG_FILE, "utf8").trim();
    const secondLines = secondLogContent ? secondLogContent.split("\n") : [];
    expect(secondLines.length).toBe(1);
  });

  test("7) retry count indicates message retried before DLQ", async () => {
    await purgeKnownQueues();
    await restartService("payment-service", { PAYMENT_FAIL_RATE: "100" });

    const { response, body } = await postOrder();
    expect(response.status).toBe(201);
    const correlationId = (body as { correlationId: string }).correlationId;

    await sleep(6000);

    const conn = await amqp.connect(RABBITMQ_URL);
    const channel = await conn.createChannel();
    channel.on("error", () => {}); // see connectToRabbit in helpers/rabbit-helper.ts

    const deadline = Date.now() + 10_000;
    let found: import("amqplib").GetMessage | null = null;
    while (Date.now() < deadline && !found) {
      const msg = await channel.get("orders.dlq", { noAck: false });
      if (msg) {
        const headerCorrelationId = (msg.properties?.headers as Record<string, unknown> | undefined)?.["correlationId"];
        if (headerCorrelationId === correlationId) {
          found = msg;
        }
        channel.ack(msg);
      } else {
        await sleep(200);
      }
    }

    await channel.close();
    await conn.close();

    expect(found).toBeDefined();
    const xDeath = (found!.properties?.headers as Record<string, unknown> | undefined)?.["x-death"] as
      | Array<{ count?: number }>
      | undefined;
    expect(Array.isArray(xDeath)).toBe(true);

    const totalCount = (xDeath ?? []).reduce((sum, death) => sum + (Number(death?.count) || 0), 0);
    expect(totalCount).toBeGreaterThanOrEqual(2);
  });

  test("8) the dead letter and invalid message channels are declared", async () => {
    const channels: Array<[exchangeName: string, queueName: string]> = [
      ["orders.dlq.exchange", "orders.dlq"],
      ["orders.invalid.exchange", "orders.invalid"],
    ];

    for (const [exchangeName, queueName] of channels) {
      const exchange = await getExchangeInfo(exchangeName);
      expect(exchange.type, `${exchangeName} must be a fanout exchange`).toBe("fanout");
      expect(exchange["durable"], `${exchangeName} must be durable`).toBe(true);

      const queue = await getQueueInfo(queueName);
      expect(queue["durable"], `${queueName} must be durable`).toBe(true);

      const bindings = (await getBindings(exchangeName)) as Array<{ destination: string; destination_type: string }>;
      expect(
        bindings.some((b) => b.destination === queueName && b.destination_type === "queue"),
        `${queueName} must be bound to ${exchangeName}`,
      ).toBe(true);
    }
  });

  test("9) a malformed message goes to the invalid message channel, from every consumer, without a retry", async () => {
    await purgeKnownQueues();

    const correlationId = crypto.randomUUID();
    const poison = "{ this is not json";
    const { connection, channel } = await connectToRabbit();

    try {
      // A producer bug: bytes that no consumer can ever parse, sent through
      // the fanout, so all three consumers receive them.
      channel.publish("orders.exchange", "", Buffer.from(poison), {
        headers: { correlationId },
        contentType: "application/json",
        persistent: true,
      });

      const invalid = await consumeFromQueue(channel, "orders.invalid", 10_000, 3);
      const mine = invalid.filter((m) => headerCorrelationId(m) === correlationId);
      expect(mine.length, "each of the three consumers must move the malformed message to orders.invalid").toBe(3);

      for (const m of mine) {
        expect(m.payload, "the original bytes must be kept unchanged").toBe(poison);
        expect(
          (m.properties?.headers as Record<string, unknown> | undefined)?.["x-death"],
          "a permanent failure must not go through the retry path first",
        ).toBeUndefined();
      }

      const dlq = await consumeFromQueue(channel, "orders.dlq", 2_000, 10);
      expect(
        dlq.filter((m) => headerCorrelationId(m) === correlationId),
        "a malformed message belongs in orders.invalid, not orders.dlq",
      ).toHaveLength(0);
    } finally {
      await closeQuietly({ connection, channel });
      // A consumer that crashed on the poison leaves it unacked in its queue,
      // where it would crash the consumer again after every restart.
      await purgeKnownQueues();
    }
  });

  test("10) DLQ replay sends a message back to the consumer that failed it, and only that one", async () => {
    await purgeKnownQueues();
    await restartService("inventory-service", { INVENTORY_FAIL_RATE: "0" });
    await restartService("payment-service", { PAYMENT_FAIL_RATE: "100" });

    const { response, body } = await postOrder();
    expect(response.status).toBe(201);
    const correlationId = (body as { correlationId: string }).correlationId;

    const { connection, channel } = await connectToRabbit();

    try {
      const deadline = Date.now() + 15_000;
      while ((await channel.checkQueue("orders.dlq")).messageCount < 1) {
        if (Date.now() > deadline) {
          throw new Error("the failed payment never reached orders.dlq within 15s");
        }
        await sleep(250);
      }

      // The cause is fixed; now replay.
      await restartService("payment-service", { PAYMENT_FAIL_RATE: "0" });

      const replay = await fetch(`${ORDER_SERVICE_URL}/dlq/replay`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      expect(replay.status).toBe(200);
      const replayBody = (await replay.json()) as { replayed?: unknown };
      expect(replayBody.replayed).toBeGreaterThanOrEqual(1);

      const paymentResult = await waitForMessage(channel, "payment.results", correlationId, 10_000);
      expect(paymentResult, "the replayed payment must succeed and publish its result").toBeDefined();

      expect((await channel.checkQueue("orders.dlq")).messageCount, "replay must drain orders.dlq").toBe(0);

      // Inventory handled this order once, on the original delivery. A replay
      // through orders.exchange (the fanout) would make it handle it again.
      await sleep(2_000);
      const inventoryResults = await consumeFromQueue(channel, "inventory.results", 2_000, 10);
      expect(
        inventoryResults.filter((m) => headerCorrelationId(m) === correlationId),
        "replay must reach only the queue the message came from",
      ).toHaveLength(1);
    } finally {
      await closeQuietly({ connection, channel });
    }
  });
});

function headerCorrelationId(m: { properties?: { headers?: unknown } }): unknown {
  return (m.properties?.headers as Record<string, unknown> | undefined)?.["correlationId"];
}

async function waitForMessage(
  channel: import("amqplib").Channel,
  queueName: string,
  correlationId: string,
  timeout: number,
): Promise<unknown> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const msg = await channel.get(queueName, { noAck: false });
    if (msg) {
      channel.ack(msg);
      if (headerCorrelationId(msg) === correlationId) {
        return msg;
      }
      continue;
    }
    await sleep(200);
  }
  return undefined;
}
