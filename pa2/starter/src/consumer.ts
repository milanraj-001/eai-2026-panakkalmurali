/**
 * PA2 — consumer: RabbitMQ -> data/received.jsonl.
 *
 * The connect/reconnect loop below is given. What you implement is the
 * messaging: a durable queue (must match the producer's), manual
 * acknowledgement, and writing each message plus its correlationId to
 * received.jsonl. See README.md and docs/adr-001.md.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import amqplib, { type Channel, type ConsumeMessage, type Connection } from "amqplib";

// ---------------------------------------------------------------- config --

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? "amqp://eai:eai-pa2@localhost:5673";
const QUEUE_NAME = process.env.QUEUE_NAME ?? "pa2.orders";
const OUTPUT_PATH = process.env.OUTPUT_PATH ?? path.join(process.cwd(), "..", "data", "received.jsonl");

// -------------------------------------------------------- channel, retry --

async function connectWithRetry(): Promise<Channel> {
  for (;;) {
    try {
      const channel = await connectConsumerChannel(RABBITMQ_URL, QUEUE_NAME);
      console.log(`[consumer] connected to ${RABBITMQ_URL}, queue "${QUEUE_NAME}"`);
      return channel;
    } catch (err) {
      console.error(`[consumer] connect failed, retrying in 2s: ${(err as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

// ------------------------------------------------------------------ TODO --

/**
 * Open a channel onto the SAME durable queue the producer declares. Also set
 * a small prefetch — this consumer acks manually, and without a prefetch
 * limit RabbitMQ will happily hand it every message in the queue at once.
 */
export async function connectConsumerChannel(url: string, queueName: string): Promise<Channel> {
  const connection = await amqplib.connect(url);
  const channel = await connection.createChannel();
  await channel.assertQueue(queueName, { durable: true });
  await channel.prefetch(1);
  return channel;
}
/**
 * Handle one delivered message: read its correlationId (RabbitMQ carries it
 * as a message property, not a header — see how the producer sets it),
 * append a JSON line to received.jsonl, and manually ack it.
 *
 * Manual ack matters for 03-consumer-stopped-accumulates.test.ts: a message
 * is only removed from the queue once you ack it, which is what lets
 * messages accumulate safely while this process is stopped rather than
 * being silently dropped.
 */
export async function handleMessage(channel: Channel, msg: ConsumeMessage): Promise<void> {
  const correlationId = msg.properties.correlationId as string | undefined;
  const payload = JSON.parse(msg.content.toString("utf8"));
  const record = {
    correlationId,
    payload,
    receivedAt: new Date().toISOString(),
  };

  appendFileSync(OUTPUT_PATH, JSON.stringify(record) + "\n", "utf8");
  channel.ack(msg);
}
// -------------------------------------------------------------------- run --

async function run(): Promise<void> {
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  for (;;) {
    const channel = await connectWithRetry();
    const connection = (channel as unknown as { connection: Connection }).connection;

    const disconnected = new Promise<void>((resolve) => {
      connection.on("error", (err: Error) => {
        console.error(`[consumer] connection error: ${err.message} — will reconnect`);
        resolve();
      });
      connection.on("close", () => {
        console.error("[consumer] connection closed — will reconnect");
        resolve();
      });
    });

    await channel.consume(
      QUEUE_NAME,
      (msg) => {
        if (!msg) return;
        handleMessage(channel, msg).catch((err: unknown) => {
          console.error(`[consumer] handleMessage failed: ${(err as Error).message}`);
          try {
            channel.nack(msg, false, false);
          } catch {
            /* channel may already be closed if this fired during a disconnect */
          }
        });
      },
      { noAck: false },
    );

    await disconnected;
  }
}

export function main(): void {
  run().catch((err: unknown) => {
    console.error(`[consumer] fatal: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}

if (process.argv[1] && process.argv[1].endsWith("consumer.ts")) {
  main();
}
