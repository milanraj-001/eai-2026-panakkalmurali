import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ConsumeMessage } from "amqplib";
import { connectWithRetry, getRetryCount } from "../../shared/rabbit";
import type { CanonicalOrder } from "../../shared/canonical-order";

const QUEUE = "notifications.queue";
const RESULTS_EXCHANGE = "results.notification";
const DLQ_EXCHANGE = process.env.DLQ_EXCHANGE ?? "orders.dlq.exchange";
const INVALID_EXCHANGE = "orders.invalid.exchange";
const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? "3");
const FAIL_RATE = Number(process.env.NOTIFICATION_FAIL_RATE ?? "0");

const DATA_DIR = process.env.DATA_DIR ?? "/data";
const PROCESSED_IDS_PATH = path.join(DATA_DIR, "processed-ids.json");
const LOG_PATH = path.join(DATA_DIR, "notification.log");

// A failure that repeats identically on every attempt.
class PermanentError extends Error {}

function loadProcessedIds(): Set<string> {
  if (!existsSync(PROCESSED_IDS_PATH)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(PROCESSED_IDS_PATH, "utf8"));
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveProcessedIds(ids: Set<string>): void {
  writeFileSync(PROCESSED_IDS_PATH, JSON.stringify([...ids]), "utf8");
}

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });

  const { channel } = await connectWithRetry(process.env.RABBITMQ_URL!);
  await channel.prefetch(1);

  await channel.assertExchange(DLQ_EXCHANGE, "fanout", { durable: true });
  await channel.assertQueue("orders.dlq", { durable: true });
  await channel.bindQueue("orders.dlq", DLQ_EXCHANGE, "");

  await channel.assertExchange(INVALID_EXCHANGE, "fanout", { durable: true });
  await channel.assertQueue("orders.invalid", { durable: true });
  await channel.bindQueue("orders.invalid", INVALID_EXCHANGE, "");

  console.log(`[Notification] Consuming from ${QUEUE}`);

  await channel.consume(QUEUE, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    const correlationId = msg.properties.headers?.["correlationId"] as string | undefined;
    const retryCount = getRetryCount(msg);

    console.log(`[Notification] Processing ${correlationId} (attempt ${retryCount + 1})`);

    try {
      const order = JSON.parse(msg.content.toString()) as CanonicalOrder;

      // The correlation id is the idempotency key, so a message without one
      // can never be deduplicated: permanent, not retryable.
      if (typeof correlationId !== "string" || correlationId.length === 0) {
        throw new PermanentError("missing correlationId header");
      }

      const processed = loadProcessedIds();
      if (processed.has(correlationId)) {
        channel.ack(msg);
        console.log(`[Notification] duplicate skipped ${correlationId}`);
        return;
      }

      if (Math.random() * 100 < FAIL_RATE) {
        throw new Error("Simulated notification failure");
      }

      const line = {
        correlationId,
        orderId: order.orderId,
        customerEmail: order.customer.email,
        timestamp: new Date().toISOString(),
        message: "Order received",
      };
      appendFileSync(LOG_PATH, JSON.stringify(line) + "\n", "utf8");

      processed.add(correlationId);
      saveProcessedIds(processed);

      const result = {
        correlationId,
        source: "notification",
        status: "success",
        timestamp: new Date().toISOString(),
        details: { message: `Customer ${order.customer.email} notified` },
      };
      channel.publish(RESULTS_EXCHANGE, "", Buffer.from(JSON.stringify(result)), {
        headers: { correlationId },
        contentType: "application/json",
        persistent: true,
      });
      channel.ack(msg);
      console.log(`[Notification] Done ${correlationId}`);
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof PermanentError) {
        channel.publish(INVALID_EXCHANGE, "", msg.content, {
          headers: msg.properties.headers,
          persistent: true,
        });
        channel.ack(msg);
        console.log(`[Notification] -> INVALID (not retried): ${(err as Error).message}`);
        return;
      }

      if (retryCount >= MAX_RETRIES - 1) {
        channel.publish(DLQ_EXCHANGE, "", msg.content, {
          headers: { ...msg.properties.headers, originQueue: QUEUE },
          persistent: true,
        });
        channel.ack(msg);
        console.log(`[Notification] -> DLQ after ${retryCount + 1} attempts: ${(err as Error).message}`);
      } else {
        channel.nack(msg, false, false);
        console.log(`[Notification] -> Retry (attempt ${retryCount + 1}): ${(err as Error).message}`);
      }
    }
  });
}

main().catch(console.error);