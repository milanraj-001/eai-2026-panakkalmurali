import express from "express";
import { randomUUID } from "node:crypto";
import type { ConsumeMessage } from "amqplib";
import { connectWithRetry, withoutRetryHistory } from "../../shared/rabbit";
import type { CanonicalOrder } from "../../shared/canonical-order";

const PORT = Number(process.env.PORT ?? "3000");
const ORDERS_EXCHANGE = "orders.exchange";
const RETURN_EXCHANGE = "orders.return.exchange";
const DLQ_EXCHANGE = process.env.DLQ_EXCHANGE ?? "orders.dlq.exchange";
const DLQ_QUEUE = "orders.dlq";
const INVALID_EXCHANGE = "orders.invalid.exchange";

const orders = new Map<string, CanonicalOrder>();

// A handful of typeof checks, as the README allows.
function looksLikeOrder(body: unknown): body is CanonicalOrder {
  if (typeof body !== "object" || body === null) return false;
  const o = body as Record<string, unknown>;
  return (
    typeof o.orderId === "string" &&
    typeof o.customer === "object" &&
    o.customer !== null &&
    Array.isArray(o.items) &&
    o.items.length > 0
  );
}

async function main(): Promise<void> {
  const { channel } = await connectWithRetry(process.env.RABBITMQ_URL!);

  // Same properties as every other service, or RabbitMQ refuses with PRECONDITION_FAILED.
  await channel.assertExchange(DLQ_EXCHANGE, "fanout", { durable: true });
  await channel.assertQueue(DLQ_QUEUE, { durable: true });
  await channel.bindQueue(DLQ_QUEUE, DLQ_EXCHANGE, "");
  await channel.assertExchange(INVALID_EXCHANGE, "fanout", { durable: true });
  await channel.assertQueue("orders.invalid", { durable: true });
  await channel.bindQueue("orders.invalid", INVALID_EXCHANGE, "");

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/orders", (req, res) => {
    if (!looksLikeOrder(req.body)) {
      res.status(400).json({ error: "body is not a canonical order" });
      return;
    }
    const order = req.body;
    // The id travels in a header: the canonical schema forbids extra body fields.
    const correlationId = randomUUID();

    channel.publish(ORDERS_EXCHANGE, "", Buffer.from(JSON.stringify(order)), {
      headers: { correlationId },
      contentType: "application/json",
      persistent: true,
    });

    orders.set(correlationId, order);
    console.log(`[Order] Accepted ${order.orderId} as ${correlationId}`);
    res.status(201).json({ correlationId, status: "accepted" });
  });

  app.get("/orders/:correlationId", (req, res) => {
    const order = orders.get(req.params.correlationId);
    if (!order) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(200).json({ correlationId: req.params.correlationId, order });
  });

  app.post("/dlq/replay", async (_req, res) => {
    let replayed = 0;
    const unroutable: ConsumeMessage[] = [];

    for (;;) {
      const msg = await channel.get(DLQ_QUEUE, { noAck: false });
      if (msg === false) break;

      const originQueue = msg.properties.headers?.["originQueue"];
      if (typeof originQueue !== "string") {
        // Nowhere to send it back to. Put it back after the loop, otherwise
        // channel.get would hand it to us again immediately.
        unroutable.push(msg);
        continue;
      }

      // Direct return exchange + origin queue as routing key: only the
      // consumer that failed sees it again. History cleared = fresh 3 attempts.
      channel.publish(RETURN_EXCHANGE, originQueue, msg.content, {
        headers: withoutRetryHistory(msg.properties.headers),
        contentType: msg.properties.contentType,
        persistent: true,
      });
      channel.ack(msg);
      replayed += 1;
    }

    for (const msg of unroutable) {
      channel.nack(msg, false, true);
    }

    console.log(`[Order] Replayed ${replayed} message(s) from ${DLQ_QUEUE}`);
    res.status(200).json({ replayed });
  });

  app.listen(PORT, () => {
    console.log(`[Order] Listening on :${PORT}`);
  });
}

main().catch(console.error);