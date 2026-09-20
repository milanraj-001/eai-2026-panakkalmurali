/**
 * PA2 — producer: HTTP POST /publish -> RabbitMQ.
 *
 * The HTTP server, request parsing and correlationId validation below are
 * given. What you implement is the messaging: a durable queue, publisher
 * confirms, and the fire-and-forget path that demonstrates why confirms
 * matter. See README.md and docs/adr-001.md.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";
import amqplib, { type ConfirmChannel, type Connection } from "amqplib";

// ---------------------------------------------------------------- config --

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? "amqp://eai:eai-pa2@localhost:5673";
const QUEUE_NAME = process.env.QUEUE_NAME ?? "pa2.orders";
const PORT = Number(process.env.PORT ?? 3000);

const CORRELATION_ID_HEADER = "x-correlation-id";
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const PUBLISH_MODE_HEADER = "x-publish-mode";
type PublishMode = "confirmed" | "fire-and-forget";

// -------------------------------------------------------- channel, retry --

let channelPromise: Promise<ConfirmChannel> | undefined;

function getChannel(): Promise<ConfirmChannel> {
  channelPromise ??= connectWithRetry();
  return channelPromise;
}

async function connectWithRetry(): Promise<ConfirmChannel> {
  for (;;) {
    try {
      const channel = await connectProducerChannel(RABBITMQ_URL, QUEUE_NAME);
      const connection = (channel as unknown as { connection: Connection }).connection;
      const drop = (reason: string) => (err?: unknown) => {
        console.error(
          `[producer] ${reason}${err ? `: ${(err as Error).message}` : ""} — will reconnect on next request`,
        );
        channelPromise = undefined;
      };
      connection.on("error", drop("connection error"));
      connection.on("close", drop("connection closed"));
      console.log(`[producer] connected to ${RABBITMQ_URL}, queue "${QUEUE_NAME}"`);
      return channel;
    } catch (err) {
      console.error(`[producer] connect failed, retrying in 2s: ${(err as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ------------------------------------------------------------------ TODO --

/**
 * Open a channel and make sure `queueName` exists as a DURABLE queue —
 * durability is what lets messages already in the queue survive a broker
 * restart. An un-declared or non-durable queue defeats every later
 * demonstration in this assignment before you get to publish anything.
 */
export async function connectProducerChannel(
  url: string,
  queueName: string,
): Promise<ConfirmChannel> {
  const connection = await amqplib.connect(url);
  const channel = await connection.createConfirmChannel();
  await channel.assertQueue(queueName, { durable: true });
  return channel;
}

/**
 * Publish `payload` to `queueName`.
 *
 * Two modes, and the difference between them is the actual point of this
 * assignment:
 *   - "confirmed" (the default): publish as a PERSISTENT message and do not
 *     resolve until the broker has confirmed it durably received the
 *     message (a confirm channel gives you a callback for this). Only once
 *     you have that confirmation can you honestly tell the HTTP caller
 *     "this is safely queued".
 *   - "fire-and-forget": publish without waiting for a confirm, and without
 *     the persistent flag. This path exists so you can observe — and then
 *     fix — the failure mode in 04-publisher-confirms-prevents-loss.test.ts:
 *     a message published this way can vanish if the broker goes down
 *     before it's written to disk, and the producer has no way to know.
 */
export async function publishMessage(
  channel: ConfirmChannel,
  queueName: string,
  payload: unknown,
  options: { correlationId: string; mode: PublishMode },
): Promise<void> {
  const content = Buffer.from(JSON.stringify(payload));
  const publishOptions = {
    correlationId: options.correlationId,
    persistent: options.mode === "confirmed",
  };

  if (options.mode === "fire-and-forget") {
    channel.publish("", queueName, content, publishOptions);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    channel.publish("", queueName, content, publishOptions, (err) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      } else {
        resolve();
      }
    });
  });
}

// -------------------------------------------------------------- http api --

function newCorrelationId(): string {
  return randomUUID();
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

async function handlePublish(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const rawBody = await readBody(req);
  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : {};
  } catch {
    sendJson(res, 400, { error: "body must be valid JSON" });
    return;
  }

  const suppliedCorrelationId = req.headers[CORRELATION_ID_HEADER];
  let correlationId: string;
  if (suppliedCorrelationId === undefined) {
    correlationId = newCorrelationId();
  } else if (
    typeof suppliedCorrelationId === "string" &&
    CORRELATION_ID_PATTERN.test(suppliedCorrelationId)
  ) {
    correlationId = suppliedCorrelationId;
  } else {
    sendJson(res, 400, {
      error: `${CORRELATION_ID_HEADER} must match ${CORRELATION_ID_PATTERN} and be a single value`,
    });
    return;
  }

  const modeHeader = req.headers[PUBLISH_MODE_HEADER];
  let mode: PublishMode = "confirmed";
  if (modeHeader !== undefined) {
    if (modeHeader === "confirmed" || modeHeader === "fire-and-forget") {
      mode = modeHeader;
    } else {
      sendJson(res, 400, { error: `${PUBLISH_MODE_HEADER} must be "confirmed" or "fire-and-forget"` });
      return;
    }
  }

  let channel: ConfirmChannel;
  try {
    channel = await withTimeout(getChannel(), 5000);
  } catch (err) {
    sendJson(res, 503, { error: `broker unavailable: ${(err as Error).message}` });
    return;
  }

  try {
    await publishMessage(channel, QUEUE_NAME, payload, { correlationId, mode });
    sendJson(res, 202, { correlationId, mode });
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
}

// -------------------------------------------------------------------- server --

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "POST" && req.url === "/publish") {
    handlePublish(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: (err as Error).message });
    });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

export function main(): void {
  server.listen(PORT, () => {
    console.log(`[producer] listening on :${PORT}, queue "${QUEUE_NAME}"`);
  });
  getChannel().catch(() => {
    /* connectWithRetry logs and keeps trying; nothing to do here */
  });
}

if (process.argv[1] && process.argv[1].endsWith("producer.ts")) {
  main();
}
