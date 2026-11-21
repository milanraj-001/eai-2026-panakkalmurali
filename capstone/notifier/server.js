import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, appendFile } from "node:fs/promises";
import path from "node:path";
import amqp from "amqplib";

const PORT = Number(process.env.PORT || 8803);
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const NOTIFICATION_URL = process.env.NOTIFICATION_URL || "http://notification:4004";
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 2500);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const DATA_DIR = process.env.DATA_DIR || "/data";
const QUEUE = "notifications.queue";
const PROCESSED_FILE = path.join(DATA_DIR, "processed-ids.json");
const LOG_FILE = path.join(DATA_DIR, "notification.log");

let processed = new Set();
let channel = null;
let brokerUp = false;
let consumerCount = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadProcessed() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const value = JSON.parse(await readFile(PROCESSED_FILE, "utf8"));
    if (!Array.isArray(value)) throw new Error("processed-ids.json is not an array");
    processed = new Set(value);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveProcessed();
  }
}

async function saveProcessed() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${PROCESSED_FILE}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify([...processed]), "utf8");
  await rename(tmp, PROCESSED_FILE);
}

// ---- trace hops: fire and forget, never block or fail the business operation
function newHop(operation, cid, causationId, attempt, messageId) {
  return { hopId: randomUUID(), operation, cid, causationId: causationId ?? null, attempt, messageId, startedAt: new Date() };
}

function emitHop(h, status, detail) {
  if (!h.cid) return;
  try {
    const finished = new Date();
    const body = {
      hopId: h.hopId,
      correlationId: h.cid,
      causationId: h.causationId,
      service: "notifier",
      operation: h.operation,
      status,
      attempt: h.attempt,
      ...(h.messageId ? { messageId: h.messageId } : {}),
      startedAt: h.startedAt.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - h.startedAt.getTime(),
      ...(detail ? { detail } : {})
    };
    channel?.publish("trace.events", "", Buffer.from(JSON.stringify(body)), {
      contentType: "application/json",
      messageId: randomUUID()
    });
  } catch (error) {
    console.error("[notifier] hop publish failed:", error.message);
  }
}

function retryCount(headers) {
  const deaths = headers?.["x-death"];
  if (!Array.isArray(deaths)) return 0;
  return deaths
    .filter(entry => entry.queue === QUEUE)
    .reduce((sum, entry) => sum + Number(entry.count || 0), 0);
}

function stripHistory(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith("x-")) continue;
    if (["originQueue", "lastError", "attempts", "deadLetteredAt", "causationId"].includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function publishConfirmed(exchange, routingKey, content, options) {
  return new Promise((resolve, reject) => {
    if (!channel) return reject(new Error("channel unavailable"));
    channel.publish(exchange, routingKey, content, options, error => (error ? reject(error) : resolve()));
  });
}

async function quarantine(msg, headers, cid, consume, error) {
  console.error(`[notifier] invalid message: ${error.message}`);
  await publishConfirmed("orders.invalid.exchange", "", msg.content, {
    persistent: true,
    contentType: msg.properties.contentType,
    messageId: randomUUID(),
    headers
  });
  if (cid) {
    const hop = newHop("invalid.quarantine", cid, consume.hopId, consume.attempt, msg.properties.messageId);
    emitHop(hop, "quarantined", { reason: error.message });
  }
  channel.ack(msg);
}

async function handle(msg) {
  const headers = msg.properties.headers || {};
  const cid = typeof headers.correlationId === "string" && headers.correlationId ? headers.correlationId : null;
  const attempt = retryCount(headers) + 1;
  const consume = newHop("notify.consume", cid, headers.causationId, attempt, msg.properties.messageId);

  let event;
  try {
    if (!cid) throw new Error("no correlationId header");
    event = JSON.parse(msg.content.toString("utf8"));
    if (
      !event || typeof event !== "object" ||
      typeof event.orderId !== "string" || !event.orderId ||
      typeof event.recipient !== "string" || !event.recipient
    ) {
      throw new Error("not a valid outcome event");
    }
  } catch (error) {
    await quarantine(msg, headers, cid, consume, error);
    return;
  }

  emitHop(consume, "success");

  if (processed.has(cid)) {
    emitHop(newHop("notify.duplicate", cid, consume.hopId, attempt, msg.properties.messageId), "duplicate");
    channel.ack(msg);
    return;
  }

  const send = newHop("notify.send", cid, consume.hopId, attempt, msg.properties.messageId);
  let failure = null;

  try {
    const response = await fetch(`${NOTIFICATION_URL}/notification/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-Id": cid,
        "X-Causation-Id": send.hopId
      },
      body: JSON.stringify({
        orderId: event.orderId,
        recipient: event.recipient,
        kind: "order_not_completed",
        reason: event.code ?? event.state
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    await response.text().catch(() => "");
    if (!response.ok) failure = `notification ${response.status}`;
  } catch (error) {
    failure = error.name === "TimeoutError" ? "timeout" : "unreachable";
  }

  if (!failure) {
    emitHop(send, "success");
    await appendFile(LOG_FILE, JSON.stringify({
      at: new Date().toISOString(),
      correlationId: cid,
      orderId: event.orderId,
      recipient: event.recipient,
      kind: "order_not_completed",
      reason: event.code ?? event.state
    }) + "\n");
    processed.add(cid);
    await saveProcessed();
    channel.ack(msg);
    return;
  }

  emitHop(send, failure === "timeout" ? "timeout" : "failed", { error: failure });

  if (attempt < MAX_RETRIES) {
    emitHop(newHop("notify.retry", cid, consume.hopId, attempt, msg.properties.messageId), "retried", { error: failure });
    channel.nack(msg, false, false); // into the retry path
    return;
  }

  const dead = newHop("notify.dead_letter", cid, consume.hopId, attempt, msg.properties.messageId);
  await publishConfirmed("orders.dlq.exchange", "", msg.content, {
    persistent: true,
    contentType: msg.properties.contentType,
    messageId: randomUUID(),
    headers: {
      ...stripHistory(headers),
      correlationId: cid,
      causationId: dead.hopId,
      originQueue: QUEUE,
      lastError: failure,
      attempts: attempt,
      deadLetteredAt: new Date().toISOString()
    }
  });
  emitHop(dead, "dead_lettered", { lastError: failure });
  channel.ack(msg);
}

async function connect() {
  let delay = 500;
  for (;;) {
    try {
      console.log("[notifier] connecting to RabbitMQ...");
      const connection = await amqp.connect(RABBITMQ_URL);
      const ch = await connection.createConfirmChannel();
      let closed = false;

      const onClose = () => {
        if (closed) return;
        closed = true;
        brokerUp = false;
        consumerCount = 0;
        channel = null;
        console.error("[notifier] RabbitMQ connection lost; reconnecting...");
        setTimeout(() => connect().catch(e => console.error(e)), 1000);
      };

      connection.on("error", e => console.error("[notifier] connection error:", e.message));
      connection.on("close", onClose);
      ch.on("error", e => console.error("[notifier] channel error:", e.message));
      ch.on("close", () => { connection.close().catch(() => {}); onClose(); });

      await ch.prefetch(1);
      channel = ch;
      await ch.consume(QUEUE, msg => {
        if (!msg) { connection.close().catch(() => {}); onClose(); return; }
        handle(msg).catch(error => {
          console.error("[notifier] handler error:", error.message);
          try { ch.nack(msg, false, true); } catch { /* channel gone: the broker requeues it */ }
        });
      });

      brokerUp = true;
      consumerCount = 1;
      console.log("[notifier] consuming", QUEUE);
      return;
    } catch (error) {
      console.error("[notifier] RabbitMQ unavailable:", error.message);
      await sleep(delay);
      delay = Math.min(delay * 2, 10000);
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const ok = brokerUp && consumerCount > 0;
    res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: ok ? "ok" : "degraded",
      checks: { broker: brokerUp ? "up" : "down", consumers: { [QUEUE]: consumerCount } }
    }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: "not_found" }));
});

await loadProcessed();
server.listen(PORT, "0.0.0.0", () => console.log(`[notifier] listening on ${PORT}`));
connect().catch(error => console.error("[notifier] connect failed:", error));
