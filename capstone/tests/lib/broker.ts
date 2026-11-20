/**
 * The broker, as the tests see it: publish a raw message, capture events on a
 * spy queue, count a queue exactly, peek at one, and wait for the saga and
 * notifier queues to drain between tests (README §7).
 */
import amqp, { type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from "amqplib";
import { get, http, until } from "./http.js";
import { containerName, T } from "./targets.js";

const MANAGEMENT_AUTH = { Authorization: "Basic " + Buffer.from("eai:eai-capstone").toString("base64") };

/** The AMQP URL without its password, for messages. */
const where = () => T.amqp.replace(/\/\/([^:@/]+):[^@/]*@/, "//$1:***@");

async function connect(): Promise<ChannelModel> {
  try {
    const conn = await amqp.connect(T.amqp);
    conn.on("error", () => undefined);
    return conn;
  } catch (err) {
    const code = (err as { code?: string }).code ?? (err as Error).message;
    throw new Error(
      `cannot connect to RabbitMQ at ${where()} (${code}). Is ${containerName("rabbitmq")} running and healthy? \`docker compose ps\` shows it.`,
    );
  }
}

let connection: ChannelModel | undefined;
let confirm: ConfirmChannel | undefined;
let passive: Channel | undefined;

async function shared(): Promise<ChannelModel> {
  if (!connection) {
    connection = await connect();
    connection.on("close", () => {
      connection = undefined;
      confirm = undefined;
      passive = undefined;
    });
  }
  return connection;
}

/** Closes the tests' own connection. Called after each test file. */
export async function closeBroker(): Promise<void> {
  const c = connection;
  connection = undefined;
  confirm = undefined;
  passive = undefined;
  await c?.close().catch(() => undefined);
}

/** Publishes as a client would, persistent, and waits for the broker's confirm. */
export async function publishRaw(exchange: string, routingKey: string, content: Buffer, options: amqp.Options.Publish = {}): Promise<void> {
  if (!confirm) {
    confirm = await (await shared()).createConfirmChannel();
    confirm.on("error", () => undefined);
    confirm.on("close", () => (confirm = undefined));
  }
  confirm.publish(exchange, routingKey, content, { persistent: true, ...options });
  await confirm.waitForConfirms();
}

export interface Spy {
  messages: ConsumeMessage[];
  stop: () => Promise<void>;
}

/**
 * A temporary exclusive queue bound to an exchange: it captures everything
 * published there from now on, and disappears when stopped.
 */
export async function spy(exchange: string, routingKey = "#"): Promise<Spy> {
  const conn = await connect();
  const ch = await conn.createChannel();
  const { queue } = await ch.assertQueue("", { exclusive: true, autoDelete: true });
  await ch.bindQueue(queue, exchange, routingKey);
  const messages: ConsumeMessage[] = [];
  await ch.consume(queue, (msg) => msg && messages.push(msg), { noAck: true });
  return { messages, stop: () => conn.close().catch(() => undefined) };
}

/** The messages a spy captured with this `correlationId` header. */
export const withCorrelation = (s: Spy, cid: string) => s.messages.filter((m) => header(m, "correlationId") === cid);

/** A header as a string: amqplib gives some header values back as Buffers. */
export function header(msg: { properties: { headers?: Record<string, unknown> } }, name: string): string | undefined {
  const value = msg.properties.headers?.[name];
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * Ready messages and consumers from a passive declare: exact at the moment of
 * asking, unlike the management API, which can report an idle queue's figures
 * several seconds late (README §4.9).
 */
export async function exact(queue: string): Promise<{ ready: number; consumers: number }> {
  if (!passive) {
    passive = await (await shared()).createChannel();
    passive.on("error", () => undefined);
    passive.on("close", () => (passive = undefined));
  }
  const q = await passive.checkQueue(queue);
  return { ready: q.messageCount, consumers: q.consumerCount };
}

export interface QueueStats {
  name: string;
  messages_ready: number;
  messages_unacknowledged: number;
  consumers: number;
}

/** Every queue's figures from the management API. The only source of `unacked`. */
export async function queues(): Promise<Record<string, QueueStats>> {
  const r = await get(`${T.management}/api/queues/%2F?columns=name,messages_ready,messages_unacknowledged,consumers`, MANAGEMENT_AUTH);
  if (r.status !== 200) throw new Error(`the RabbitMQ management API answered ${r.status} at ${T.management}/api/queues`);
  return Object.fromEntries((r.body as QueueStats[]).map((q) => [q.name, q]));
}

/** GET on the management API, as the eai user. */
export const management = (pathAndQuery: string) => get(`${T.management}/api${pathAndQuery}`, MANAGEMENT_AUTH);

/** Empties a queue. The tests use it on orders.dlq and orders.invalid, before a test that counts them. */
export async function purge(queue: string): Promise<void> {
  const r = await http(`${T.management}/api/queues/%2F/${encodeURIComponent(queue)}/contents`, { method: "DELETE", headers: MANAGEMENT_AUTH });
  if (r.status !== 204 && r.status !== 200) throw new Error(`purging ${queue} failed: ${r.status}`);
}

/**
 * Every message in a queue, taken on a channel of the test's own and put back
 * by closing it. The queue keeps its messages; their order may change.
 */
export async function peek(queue: string): Promise<ConsumeMessage[]> {
  const conn = await connect();
  try {
    const ch = await conn.createChannel();
    const out: ConsumeMessage[] = [];
    for (;;) {
      const m = await ch.get(queue, { noAck: false });
      if (!m) break;
      out.push(m as unknown as ConsumeMessage);
    }
    return out;
  } finally {
    await conn.close().catch(() => undefined); // requeues them all
  }
}

/** Each consumed queue, and its retry queue. */
const DRAINED: Array<[string, string]> = [
  ["saga.queue", "saga.retry.queue"],
  ["notifications.queue", "notifications.retry.queue"],
];

/**
 * Waits until the saga and notifier queues, and their retry queues, hold no
 * message, ready or unacked, so that a late retry from one test cannot land
 * in the next (README §7). A queue nobody consumes yet (the orchestrator
 * before stage 2) is skipped: nothing of it is in flight.
 */
export async function drain(timeoutMs = 30_000): Promise<void> {
  await until(
    `${DRAINED.flat().join(", ")} to hold no ready and no unacked message before the next test`,
    async () => {
      const q = await queues();
      const out: Record<string, { ready: number; unacked: number }> = {};
      for (const [origin, retry] of DRAINED) {
        const o = await exact(origin);
        if (o.consumers === 0 && (q[origin]?.messages_unacknowledged ?? 0) === 0) continue;
        out[origin] = { ready: o.ready, unacked: q[origin]?.messages_unacknowledged ?? 0 };
        out[retry] = { ready: (await exact(retry)).ready, unacked: 0 };
      }
      return out;
    },
    (counts) => Object.values(counts).every((c) => c.ready === 0 && c.unacked === 0),
    timeoutMs,
    250,
  );
}
