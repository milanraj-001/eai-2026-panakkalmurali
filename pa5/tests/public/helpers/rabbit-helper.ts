/**
 * Ported from the JS lab's test/helpers/rabbit-helper.js. Behaviour is
 * unchanged; axios is replaced with Node 20's built-in fetch (no extra
 * dependency, and it is what PA3's equivalent helper already does in this
 * repo — see ../../../pa3/tests/public/lib/management.ts).
 *
 * consumeFromQueue polls with raw AMQP channel.get(), not the management
 * API's queue "messages" count — the management API's stats snapshot only
 * refreshes roughly every 5 seconds, so polling it faster than that for a
 * "has it settled" check gives false confidence. This is exactly the
 * approach the original test suite used; see docs/adr-004.md.
 */

import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from "amqplib";

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? "amqp://eai:eai-pa5@localhost:5674";
const MGMT_BASE_URL = process.env.RABBITMQ_MGMT_URL ?? "http://localhost:15674/api";
const MGMT_USER = process.env.RABBITMQ_MGMT_USER ?? "eai";
const MGMT_PASS = process.env.RABBITMQ_MGMT_PASS ?? "eai-pa5";

const authHeader = "Basic " + Buffer.from(`${MGMT_USER}:${MGMT_PASS}`).toString("base64");

async function mgmtFetch(pathname: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${MGMT_BASE_URL}${pathname}`, {
    ...init,
    headers: { Authorization: authHeader, ...(init?.headers ?? {}) },
  });
  return res;
}

export interface RabbitConnection {
  connection: ChannelModel;
  channel: Channel;
}

export async function connectToRabbit(): Promise<RabbitConnection> {
  const connection = await amqp.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();
  // When the broker closes a channel (e.g. NOT_FOUND on a queue nobody has
  // declared yet), amqplib rejects the pending call AND emits "error". The
  // rejection already fails the test that made the call; without a listener
  // the event would also crash the whole test run.
  channel.on("error", () => {});
  return { connection, channel };
}

/** Close without throwing — a channel the broker already closed rejects close(). */
export async function closeQuietly({ connection, channel }: RabbitConnection): Promise<void> {
  await channel.close().catch(() => {});
  await connection.close().catch(() => {});
}

/**
 * Live consumer count, straight from the broker (a passive queue.declare).
 * The management API's `consumers` figure is a stats snapshot refreshed
 * about every 5 seconds: right after `docker compose up --build` replaces a
 * container it can still report the old container's consumer, or none for
 * the new one.
 */
export async function getConsumerCount(queueName: string): Promise<number> {
  const conn = await connectToRabbit();
  try {
    const { consumerCount } = await conn.channel.checkQueue(queueName);
    return consumerCount;
  } finally {
    await closeQuietly(conn);
  }
}

export interface ConsumedMessage {
  payload: unknown;
  properties: ConsumeMessage["properties"];
  // channel.get() returns GetMessageFields (no consumerTag — there is no
  // consumer here), a narrower type than ConsumeMessageFields. Nothing in
  // this test suite currently reads .fields; kept as unknown rather than
  // dragging in amqplib's internal type split for a value nobody inspects.
  fields: unknown;
}

export async function consumeFromQueue(
  channel: Channel,
  queueName: string,
  timeout = 10_000,
  maxMessages = 1,
): Promise<ConsumedMessage[]> {
  const messages: ConsumedMessage[] = [];
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline && messages.length < maxMessages) {
    const msg = await channel.get(queueName, { noAck: false });

    if (msg) {
      const payloadText = msg.content.toString();
      let payload: unknown;

      try {
        payload = JSON.parse(payloadText);
      } catch {
        payload = payloadText;
      }

      messages.push({ payload, properties: msg.properties, fields: msg.fields });
      channel.ack(msg);
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return messages;
}

export interface QueueInfo {
  name: string;
  consumers: number;
  messages: number;
  [key: string]: unknown;
}

export async function getQueueInfo(queueName: string): Promise<QueueInfo> {
  const res = await mgmtFetch(`/queues/%2F/${encodeURIComponent(queueName)}`);
  if (!res.ok) {
    throw new Error(`management API GET /queues/${queueName} -> ${res.status}`);
  }
  return (await res.json()) as QueueInfo;
}

export interface ExchangeInfo {
  name: string;
  type: string;
  [key: string]: unknown;
}

export async function getExchangeInfo(exchangeName: string): Promise<ExchangeInfo> {
  const res = await mgmtFetch(`/exchanges/%2F/${encodeURIComponent(exchangeName)}`);
  if (!res.ok) {
    throw new Error(`management API GET /exchanges/${exchangeName} -> ${res.status}`);
  }
  return (await res.json()) as ExchangeInfo;
}

export async function getBindings(exchangeName: string): Promise<unknown> {
  const res = await mgmtFetch(`/exchanges/%2F/${encodeURIComponent(exchangeName)}/bindings/source`);
  if (!res.ok) {
    throw new Error(`management API GET /exchanges/${exchangeName}/bindings/source -> ${res.status}`);
  }
  return res.json();
}

export async function purgeQueue(queueName: string): Promise<void> {
  const res = await mgmtFetch(`/queues/%2F/${encodeURIComponent(queueName)}/contents`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`management API DELETE /queues/${queueName}/contents -> ${res.status}`);
  }
}
