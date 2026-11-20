import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import amqp from "amqplib";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const PORT = Number(process.env.PORT || 8802);
const DATA_DIR = process.env.DATA_DIR || "/data";
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const PAYMENT_URL = process.env.PAYMENT_URL || "http://payment:4001";
const INVENTORY_URL = process.env.INVENTORY_URL || "http://inventory:4002";
const SHIPPING_URL = process.env.SHIPPING_URL || "http://shipping:4003";
const NOTIFICATION_URL = process.env.NOTIFICATION_URL || "http://notification:4004";
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 2500);
const CONCURRENCY = Number(process.env.SAGA_CONCURRENCY || 5);

const canonicalSchema = JSON.parse(
  await readFile("/canonical/order.schema.json", "utf8")
);
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateCanonicalOrder = ajv.compile(canonicalSchema);

const STORE_FILE = path.join(DATA_DIR, "saga-store.json");

let store = { sagas: {}, businessKeys: {} };
let connection;
let channel;
let brokerStatus = "down";

async function saveStore() {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
  await rename(temporary, STORE_FILE);
}

async function loadStore() {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    store = JSON.parse(await readFile(STORE_FILE, "utf8"));
    if (!store.sagas || !store.businessKeys) {
      throw new Error("Invalid saga store format");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveStore();
  }
}

function amountInCents(items) {
  const total = items.reduce((sum, item) => {
    const match = /^(\d+)\.(\d{2})$/.exec(item.unitPrice);
    if (!match) throw new Error("Invalid canonical unit price");
    return sum + (Number(match[1]) * 100 + Number(match[2])) * item.quantity;
  }, 0);

  return `${Math.floor(total / 100)}.${String(total % 100).padStart(2, "0")}`;
}

async function providerCall(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(result.code || `Provider returned HTTP ${response.status}`);
    error.status = response.status;
    error.code = result.code || "provider_error";
    throw error;
  }

  return result;
}

async function publishOutcome(envelope, correlationId) {
  const causationId = randomUUID();

  await new Promise((resolve, reject) => {
    channel.publish(
      "orders.outcome",
      `order.${envelope.state}`,
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        contentType: "application/json",
        messageId: randomUUID(),
        headers: { correlationId, causationId }
      },
      error => error ? reject(error) : resolve()
    );
  });
}

async function recordStep(saga, step) {
  saga.steps.push({
    step,
    status: "completed",
    at: new Date().toISOString()
  });
  saga.updatedAt = new Date().toISOString();
  await saveStore();
}

async function processOrder(message) {
  const order = JSON.parse(message.content.toString("utf8"));

  if (!validateCanonicalOrder(order)) {
    const details = ajv.errorsText(validateCanonicalOrder.errors);
    throw new Error(`Invalid canonical order: ${details}`);
  }
  const headers = message.properties.headers || {};
  const correlationId = headers.correlationId;
  const businessKey = headers.businessKey;

  if (!correlationId || !businessKey) {
    throw new Error("Order is missing correlationId or businessKey headers");
  }

  const existing = store.sagas[correlationId];

  if (existing?.outcome) {
    await publishOutcome(
      { ...existing.outcome.envelope },
      correlationId
    );
    return;
  }

  if (existing) {
    throw new Error("Saga already exists and requires recovery");
  }

  const firstCorrelationId = store.businessKeys[businessKey];

  if (firstCorrelationId && firstCorrelationId !== correlationId) {
    const envelope = {
      correlationId,
      businessKey,
      orderId: order.orderId,
      source: order.source,
      orderType: order.orderType,
      recipient: order.customer.email,
      state: "duplicate",
      duplicateOf: firstCorrelationId,
      occurredAt: new Date().toISOString()
    };

    await publishOutcome(envelope, correlationId);
    return;
  }

  const saga = {
    businessKey,
    state: "processing",
    steps: [],
    compensations: [],
    owner: "handrolled",
    updatedAt: new Date().toISOString()
  };

  store.sagas[correlationId] = saga;
  store.businessKeys[businessKey] = correlationId;
  await saveStore();

  const commonHeaders = {
    "X-Correlation-Id": correlationId
  };

  if (order.orderType !== "b2b") {
    await providerCall(
      `${PAYMENT_URL}/payment/authorize`,
      {
        orderId: order.orderId,
        amount: amountInCents(order.items)
      },
      {
        ...commonHeaders,
        "X-Causation-Id": randomUUID(),
        "Idempotency-Key": `authorize:${businessKey}`
      }
    );
    await recordStep(saga, "payment");
  }

  await providerCall(
    `${INVENTORY_URL}/inventory/reserve`,
    { orderId: order.orderId, items: order.items },
    {
      ...commonHeaders,
      "X-Causation-Id": randomUUID(),
      "Idempotency-Key": `reserve:${businessKey}`
    }
  );
  await recordStep(saga, "inventory");

  await providerCall(
    `${SHIPPING_URL}/shipping/create`,
    { orderId: order.orderId },
    {
      ...commonHeaders,
      "X-Causation-Id": randomUUID()
    }
  );
  await recordStep(saga, "shipping");

  await providerCall(
    `${NOTIFICATION_URL}/notification/send`,
    {
      orderId: order.orderId,
      recipient: order.customer.email,
      kind: "order_confirmed"
    },
    {
      ...commonHeaders,
      "X-Causation-Id": randomUUID()
    }
  );
  await recordStep(saga, "notification");

  const envelope = {
    correlationId,
    businessKey,
    orderId: order.orderId,
    source: order.source,
    orderType: order.orderType,
    recipient: order.customer.email,
    state: "completed",
    occurredAt: new Date().toISOString()
  };

  saga.state = "completed";
  saga.outcome = {
    routingKey: "order.completed",
    envelope
  };
  saga.updatedAt = new Date().toISOString();
  await saveStore();

  await publishOutcome(envelope, correlationId);
}

async function connectBroker() {
  let delay = 500;

  while (!channel) {
    try {
      connection = await amqp.connect(RABBITMQ_URL);
      channel = await connection.createConfirmChannel();

      await channel.prefetch(CONCURRENCY);

      await channel.consume("saga.queue", async message => {
        if (!message) return;

        try {
          await processOrder(message);
          channel.ack(message);
        } catch (error) {
          console.error("Saga processing failed:", error.message);
          channel.nack(message, false, false);
        }
      });

      connection.on("close", () => {
        channel = undefined;
        connection = undefined;
        brokerStatus = "down";
        connectBroker().catch(error =>
          console.error("RabbitMQ reconnect failed:", error)
        );
      });

      connection.on("error", error => {
        console.error("RabbitMQ error:", error.message);
      });

      brokerStatus = "up";
      console.log("Orchestrator connected to RabbitMQ");
    } catch (error) {
      channel = undefined;
      brokerStatus = "down";
      console.error("RabbitMQ unavailable:", error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10000);
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    const healthy = brokerStatus === "up";
    res.writeHead(healthy ? 200 : 503, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      status: healthy ? "ok" : "unhealthy",
      checks: { broker: brokerStatus }
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: "not_found" }));
});

await loadStore();
await connectBroker();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Orchestrator listening on port ${PORT}`);
});
