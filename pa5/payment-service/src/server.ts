/**
 * PA5 payment-service — the reference consumer.
 */

import type { ConsumeMessage } from "amqplib";
import { connectWithRetry, getRetryCount } from "../../shared/rabbit";
import type { CanonicalOrder } from "../../shared/canonical-order";

const QUEUE = "payments.queue";
const RESULTS_EXCHANGE = "results.payment";
const DLQ_EXCHANGE = process.env.DLQ_EXCHANGE ?? "orders.dlq.exchange";
const INVALID_EXCHANGE = "orders.invalid.exchange";
// `?? "20"`, not `|| 20`: Number("0") is 0, and `0 || 20` is 20 — a
// configured fail rate of zero would silently become the default.
const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? "3");
const FAIL_RATE = Number(process.env.PAYMENT_FAIL_RATE ?? "20");

async function main(): Promise<void> {
  const { channel } = await connectWithRetry(process.env.RABBITMQ_URL!);
  await channel.prefetch(1);

  // Dead letter channel — identical properties in every service.
  await channel.assertExchange(DLQ_EXCHANGE, "fanout", { durable: true });
  await channel.assertQueue("orders.dlq", { durable: true });
  await channel.bindQueue("orders.dlq", DLQ_EXCHANGE, "");

  // Invalid message channel — identical properties in every service.
  await channel.assertExchange(INVALID_EXCHANGE, "fanout", { durable: true });
  await channel.assertQueue("orders.invalid", { durable: true });
  await channel.bindQueue("orders.invalid", INVALID_EXCHANGE, "");

  console.log(`[Payment] Consuming from ${QUEUE}, fail rate: ${FAIL_RATE}%`);

  await channel.consume(QUEUE, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    const correlationId = msg.properties.headers?.["correlationId"] as string | undefined;
    const retryCount = getRetryCount(msg);

    console.log(`[Payment] Processing ${correlationId} (attempt ${retryCount + 1})`);

    try {
      // Parsed inside the try block: a malformed body must not crash the consumer.
      const order = JSON.parse(msg.content.toString()) as CanonicalOrder;

      if (Math.random() * 100 < FAIL_RATE) {
        throw new Error("Simulated payment failure");
      }

      const result = {
        correlationId,
        source: "payment",
        status: "success",
        timestamp: new Date().toISOString(),
        details: { message: `Payment processed for order ${order.orderId}` },
      };

      channel.publish(RESULTS_EXCHANGE, "", Buffer.from(JSON.stringify(result)), {
        headers: { correlationId },
        contentType: "application/json",
        persistent: true,
      });
      channel.ack(msg);
      console.log(`[Payment] Done ${correlationId}`);
    } catch (err) {
      // Permanent failure: a body that is not valid JSON fails identically on
      // every attempt. Move it aside with its original bytes and headers; do
      // not retry it and do not send it to the DLQ.
      if (err instanceof SyntaxError) {
        channel.publish(INVALID_EXCHANGE, "", msg.content, {
          headers: msg.properties.headers,
          persistent: true,
        });
        channel.ack(msg);
        console.log(`[Payment] -> INVALID (not retried): ${err.message}`);
        return;
      }

      // Retry / DLQ logic (provided — study this for the other two services).
      // Do not modify.
      if (retryCount >= MAX_RETRIES - 1) {
        channel.publish(DLQ_EXCHANGE, "", msg.content, {
          // originQueue tells a later replay which queue to send it back to.
          headers: { ...msg.properties.headers, originQueue: QUEUE },
          persistent: true,
        });
        channel.ack(msg);
        console.log(`[Payment] -> DLQ after ${retryCount + 1} attempts: ${(err as Error).message}`);
      } else {
        channel.nack(msg, false, false);
        console.log(`[Payment] -> Retry (attempt ${retryCount + 1}): ${(err as Error).message}`);
      }
    }
  });
}

main().catch(console.error);