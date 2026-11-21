import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import amqp from "amqplib";

const PORT = Number(process.env.PORT || 8801);
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const DATA_DIR = process.env.DATA_DIR || "/data";
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://orchestrator:8802";
const TRACE_FILE = path.join(DATA_DIR, "trace-store.jsonl");
const QUEUE = "trace.store";
const QUEUES = ["saga.queue", "notifications.queue", "orders.dlq", "orders.invalid", "trace.store"];

// Lag thresholds (README R-4.9.8, R-4.9.9): justified in docs/runbook.md.
const SAGA_LAG_THRESHOLD = 5;
const NOTIFIER_LAG_THRESHOLD = 5;

const brokerUrl = new URL(RABBITMQ_URL);
const MANAGEMENT_URL = process.env.MANAGEMENT_URL || `http://${brokerUrl.hostname}:15672`;
const MANAGEMENT_AUTH = "Basic " + Buffer.from(
  `${decodeURIComponent(brokerUrl.username)}:${decodeURIComponent(brokerUrl.password)}`
).toString("base64");

const traces = new Map(); // correlationId -> hops
const seen = new Set();   // hopIds, because delivery is at-least-once

let connection = null;
let channel = null;
let brokerUp = false;
let consumerCount = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function remember(hop) {
  if (seen.has(hop.hopId)) return false;
  seen.add(hop.hopId);
  if (!traces.has(hop.correlationId)) traces.set(hop.correlationId, []);
  traces.get(hop.correlationId).push(hop);
  return true;
}

async function loadTraces() {
  await mkdir(DATA_DIR, { recursive: true });
  let text = "";
  try {
    text = await readFile(TRACE_FILE, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const hop = JSON.parse(line);
      if (hop?.hopId && hop?.correlationId) remember(hop);
    } catch { /* a half-written last line after a crash */ }
  }
  console.log(`[observer] loaded ${seen.size} hops`);
}

function publishConfirmed(exchange, content, options) {
  return new Promise((resolve, reject) => {
    if (!channel) return reject(new Error("channel unavailable"));
    channel.publish(exchange, "", content, options, error => (error ? reject(error) : resolve()));
  });
}

async function handle(msg) {
  let hop;
  try {
    hop = JSON.parse(msg.content.toString("utf8"));
    if (!hop || typeof hop.hopId !== "string" || typeof hop.correlationId !== "string") {
      throw new Error("not a hop record");
    }
  } catch (error) {
    console.error("[observer] invalid message:", error.message);
    await publishConfirmed("orders.invalid.exchange", msg.content, {
      persistent: true,
      contentType: msg.properties.contentType,
      messageId: randomUUID(),
      headers: msg.properties.headers || {}
    });
    channel.ack(msg);
    return;
  }

  if (remember(hop)) {
    try {
      await appendFile(TRACE_FILE, JSON.stringify(hop) + "\n");
    } catch (error) {
      // Not stored: forget it so that the redelivery is stored.
      seen.delete(hop.hopId);
      const list = traces.get(hop.correlationId);
      list.splice(list.indexOf(hop), 1);
      throw error;
    }
  }
  channel.ack(msg);
}

async function connect() {
  let delay = 500;
  for (;;) {
    try {
      console.log("[observer] connecting to RabbitMQ...");
      const conn = await amqp.connect(RABBITMQ_URL);
      const ch = await conn.createConfirmChannel();
      let closed = false;

      const onClose = () => {
        if (closed) return;
        closed = true;
        brokerUp = false;
        consumerCount = 0;
        channel = null;
        connection = null;
        console.error("[observer] RabbitMQ connection lost; reconnecting...");
        setTimeout(() => connect().catch(e => console.error(e)), 1000);
      };

      conn.on("error", e => console.error("[observer] connection error:", e.message));
      conn.on("close", onClose);
      ch.on("error", e => console.error("[observer] channel error:", e.message));
      ch.on("close", () => { conn.close().catch(() => {}); onClose(); });

      await ch.prefetch(50);
      connection = conn;
      channel = ch;
      await ch.consume(QUEUE, msg => {
        if (!msg) { conn.close().catch(() => {}); onClose(); return; }
        handle(msg).catch(error => {
          console.error("[observer] handler error:", error.message);
          try { ch.nack(msg, false, true); } catch { /* channel gone */ }
        });
      });

      brokerUp = true;
      consumerCount = 1;
      console.log("[observer] consuming", QUEUE);
      return;
    } catch (error) {
      console.error("[observer] RabbitMQ unavailable:", error.message);
      await sleep(delay);
      delay = Math.min(delay * 2, 10000);
    }
  }
}

// ---- /ops/metrics ----
async function managementQueues() {
  try {
    const response = await fetch(`${MANAGEMENT_URL}/api/queues/%2F`, {
      headers: { Authorization: MANAGEMENT_AUTH },
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) return {};
    const out = {};
    for (const q of await response.json()) out[q.name] = q;
    return out;
  } catch {
    return {};
  }
}

async function passiveStats(name) {
  if (!connection) return null;
  let ch;
  try {
    ch = await connection.createChannel();
    ch.on("error", () => {});
    const q = await ch.checkQueue(name);
    return { ready: q.messageCount, consumers: q.consumerCount };
  } catch {
    return null;
  } finally {
    if (ch) await ch.close().catch(() => {});
  }
}

async function stuckSagas() {
  try {
    const response = await fetch(`${ORCHESTRATOR_URL}/sagas/stuck`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return 0;
    const body = await response.json();
    return Array.isArray(body.sagas) ? body.sagas.length : 0;
  } catch {
    return 0;
  }
}

async function metrics() {
  const [managed, stuck] = await Promise.all([managementQueues(), stuckSagas()]);
  const queues = {};

  for (const name of QUEUES) {
    const passive = await passiveStats(name);
    const m = managed[name] || {};
    queues[name] = {
      ready: passive ? passive.ready : (m.messages_ready ?? 0),
      unacked: m.messages_unacknowledged ?? 0,
      consumers: passive ? passive.consumers : (m.consumers ?? 0)
    };
  }

  const dlqDepth = queues["orders.dlq"].ready + queues["orders.dlq"].unacked;
  const invalidDepth = queues["orders.invalid"].ready + queues["orders.invalid"].unacked;

  const alert = (key, value, firing, threshold = null) => ({ key, firing, value, threshold });

  return {
    generatedAt: new Date().toISOString(),
    queues,
    dlqDepth,
    invalidDepth,
    stuckSagas: stuck,
    alerts: [
      alert("dlq_not_empty", dlqDepth, dlqDepth > 0),
      alert("invalid_not_empty", invalidDepth, invalidDepth > 0),
      alert("saga_consumer_missing", queues["saga.queue"].consumers, queues["saga.queue"].consumers === 0),
      alert("notifier_consumer_missing", queues["notifications.queue"].consumers, queues["notifications.queue"].consumers === 0),
      alert("saga_consumer_lag", queues["saga.queue"].ready, queues["saga.queue"].ready > SAGA_LAG_THRESHOLD, SAGA_LAG_THRESHOLD),
      alert("notifier_consumer_lag", queues["notifications.queue"].ready, queues["notifications.queue"].ready > NOTIFIER_LAG_THRESHOLD, NOTIFIER_LAG_THRESHOLD),
      alert("stuck_sagas", stuck, stuck > 0)
    ]
  };
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      const ok = brokerUp && consumerCount > 0;
      return send(res, ok ? 200 : 503, {
        status: ok ? "ok" : "degraded",
        checks: { broker: brokerUp ? "up" : "down", consumers: { [QUEUE]: consumerCount } }
      });
    }

    if (req.method === "GET" && url.pathname.startsWith("/trace/")) {
      const correlationId = decodeURIComponent(url.pathname.slice("/trace/".length));
      const hops = traces.get(correlationId);
      if (!hops || hops.length === 0) return send(res, 404, { code: "not_found" });
      const sorted = [...hops].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      return send(res, 200, { correlationId, hops: sorted });
    }

    if (req.method === "GET" && url.pathname === "/ops/metrics") {
      return send(res, 200, await metrics());
    }

    return send(res, 404, { code: "not_found" });
  } catch (error) {
    console.error("[observer] request failed:", error.message);
    if (!res.headersSent) send(res, 500, { code: "internal_error" });
  }
});

await loadTraces();
server.listen(PORT, "0.0.0.0", () => console.log(`[observer] listening on ${PORT}`));
connect().catch(error => console.error("[observer] connect failed:", error));
