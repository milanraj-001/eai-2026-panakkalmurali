/**
 * AMQP helpers: a single shared consumer on orders.complete (buffering
 * every completion message by orderId, so tests can run one after another
 * without racing each other for the "right" message), plus a raw publish
 * helper for tests that need to inject a message directly.
 */

import amqp, { type ChannelModel, type Channel } from "amqplib";
import { QUEUES, RABBITMQ_AMQP_URL, sleep } from "./env.js";

export interface CompletionMessage {
  orderId: string;
  correlationId?: string;
  status: "complete" | "partial" | string;
  totalItems: number;
  receivedItems: number;
  itemResults: unknown[];
  missingItemIndexes: number[];
}

let connection: ChannelModel | undefined;
let channel: Channel | undefined;
const buffered = new Map<string, CompletionMessage>();

/**
 * Starts (once) a consumer on orders.complete that files every message it
 * sees into `buffered`, keyed by orderId. Call this in a beforeAll, then
 * use waitForCompletion() from individual tests.
 */
export async function startCompletionListener(): Promise<void> {
  if (channel) return;
  connection = await amqp.connect(RABBITMQ_AMQP_URL);
  channel = await connection.createChannel();
  await channel.assertQueue(QUEUES.complete, { durable: true });
  await channel.consume(
    QUEUES.complete,
    (msg) => {
      if (!msg) return;
      try {
        const parsed = JSON.parse(msg.content.toString()) as CompletionMessage;
        buffered.set(parsed.orderId, parsed);
      } finally {
        channel!.ack(msg);
      }
    },
    { noAck: false },
  );
}

export async function stopCompletionListener(): Promise<void> {
  await channel?.close().catch(() => {});
  await connection?.close().catch(() => {});
  channel = undefined;
  connection = undefined;
  buffered.clear();
}

/**
 * Waits until orderId shows up in the completion buffer (populated by the
 * listener started with startCompletionListener), or throws once
 * timeoutMs has elapsed.
 */
export async function waitForCompletion(
  orderId: string,
  timeoutMs = 20_000,
): Promise<CompletionMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = buffered.get(orderId);
    if (found) return found;
    await sleep(150);
  }
  throw new Error(
    `no completion message for order ${orderId} within ${timeoutMs}ms`,
  );
}

/** Publishes a raw JSON body to a named queue, bypassing the HTTP API entirely. */
export async function publishRaw(queueName: string, body: unknown): Promise<void> {
  const conn = await amqp.connect(RABBITMQ_AMQP_URL);
  try {
    const ch = await conn.createChannel();
    await ch.assertQueue(queueName, { durable: true });
    ch.sendToQueue(queueName, Buffer.from(JSON.stringify(body)), {
      persistent: true,
    });
    await ch.close();
  } finally {
    await conn.close();
  }
}
