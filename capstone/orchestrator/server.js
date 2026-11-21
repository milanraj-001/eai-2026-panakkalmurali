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
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);

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
const consumers = {};

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

class InvalidMessageError extends Error {}

class RetryableError extends Error {
  constructor(cause, code) {
    super(cause.message);
    this.code = code;
  }
}

function retryCount(headers) {
  const deaths = headers?.["x-death"];
  if (!Array.isArray(deaths)) return 0;
  return deaths
    .filter(entry => entry.queue === "saga.queue")
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

function publishRaw(exchange, routingKey, content, options) {
  return new Promise((resolve, reject) => {
    if (!channel) {
      reject(new Error("channel unavailable"));
      return;
    }
    channel.publish(exchange, routingKey, content, options, error =>
      error ? reject(error) : resolve()
    );
  });
}

async function deadLetter(message, lastError, attempt) {
  const headers = message.properties.headers || {};
  await publishRaw("orders.dlq.exchange", "", message.content, {
    persistent: true,
    contentType: message.properties.contentType,
    messageId: randomUUID(),
    headers: {
      ...stripHistory(headers),
      correlationId: headers.correlationId,
      causationId: randomUUID(),
      originQueue: "saga.queue",
      lastError,
      attempts: attempt,
      deadLetteredAt: new Date().toISOString()
    }
  });
}

async function parkSaga(message, code, attempt) {
  const headers = message.properties.headers || {};
  const correlationId = headers.correlationId;

  await deadLetter(message, code, attempt);

  const order = JSON.parse(message.content.toString("utf8"));
  const saga = store.sagas[correlationId];

  if (saga) {
    saga.state = "parked";
    saga.updatedAt = new Date().toISOString();
    await saveStore();
  }

  await publishOutcome({
    correlationId,
    businessKey: saga?.businessKey ?? headers.businessKey ?? `${order.source}:${order.orderId}`,
    orderId: order.orderId,
    source: order.source,
    orderType: order.orderType,
    recipient: order.customer.email,
    state: "parked",
    occurredAt: new Date().toISOString()
  }, correlationId);
}

async function processOrder(message) {
  let order;
  try {
    order = JSON.parse(message.content.toString("utf8"));
  } catch (error) {
    throw new InvalidMessageError(`not JSON: ${error.message}`);
  }

  if (!validateCanonicalOrder(order)) {
    const details = ajv.errorsText(validateCanonicalOrder.errors);
    throw new InvalidMessageError(`invalid canonical order: ${details}`);
  }

  const headers = message.properties.headers || {};
  const correlationId = headers.correlationId;

  if (!correlationId) {
    throw new InvalidMessageError("no correlationId header");
  }

  const businessKey = headers.businessKey || `${order.source}:${order.orderId}`;

  const existing = store.sagas[correlationId];

  if (existing?.outcome) {
    await publishOutcome({ ...existing.outcome.envelope }, correlationId);
    return;
  }

  if (existing && existing.steps.length > 0) {
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

    store.sagas[correlationId] = {
      businessKey,
      state: "duplicate",
      steps: [],
      compensations: [],
      owner: "handrolled",
      outcome: { routingKey: "order.duplicate", envelope },
      updatedAt: new Date().toISOString()
    };
    await saveStore();
    await publishOutcome(envelope, correlationId);
    return;
  }

  const saga = existing || {
    businessKey,
    state: "processing",
    steps: [],
    compensations: [],
    owner: "handrolled",
    updatedAt: new Date().toISOString()
  };

  const resumingFromPark = existing?.state === "parked";

  if (!existing) {
    store.sagas[correlationId] = saga;
    store.businessKeys[businessKey] = correlationId;
  }

  if (!existing || resumingFromPark) {
    saga.state = "processing";
    saga.updatedAt = new Date().toISOString();
    await saveStore();
    await publishOutcome({
      correlationId,
      businessKey,
      orderId: order.orderId,
      source: order.source,
      orderType: order.orderType,
      recipient: order.customer.email,
      state: "processing",
      occurredAt: new Date().toISOString()
    }, correlationId);
  }

  const commonHeaders = {
    "X-Correlation-Id": correlationId
  };

  const steps = [
    ...(order.orderType === "b2b" ? [] : [{
      name: "payment",
      url: `${PAYMENT_URL}/payment/authorize`,
      body: {
        orderId: order.orderId,
        amount: amountInCents(order.items)
      },
      headers: {
        "Idempotency-Key": `authorize:${businessKey}`
      }
    }]),
    {
      name: "inventory",
      url: `${INVENTORY_URL}/inventory/reserve`,
      body: { orderId: order.orderId, items: order.items },
      headers: {
        "Idempotency-Key": `reserve:${businessKey}`
      }
    },
    {
      name: "shipping",
      url: `${SHIPPING_URL}/shipping/create`,
      body: { orderId: order.orderId },
      headers: {}
    },
    {
      name: "notification",
      url: `${NOTIFICATION_URL}/notification/send`,
      body: {
        orderId: order.orderId,
        recipient: order.customer.email,
        kind: "order_confirmed"
      },
      headers: {}
    }
  ];

  async function finish(state, code) {
    const envelope = {
      correlationId,
      businessKey,
      orderId: order.orderId,
      source: order.source,
      orderType: order.orderType,
      recipient: order.customer.email,
      state,
      ...(code ? { code } : {}),
      occurredAt: new Date().toISOString()
    };

    saga.state = state;
    saga.outcome = {
      routingKey: `order.${state}`,
      envelope
    };
    saga.updatedAt = new Date().toISOString();
    await saveStore();
    await publishOutcome(envelope, correlationId);
  }

  function errorCode(error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "timeout";
    }
    if (error instanceof TypeError || error.code === "ECONNREFUSED") {
      return "unreachable";
    }
    return error.code || "provider_error";
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];

    try {
      await providerCall(step.url, step.body, {
        ...commonHeaders,
        "X-Causation-Id": randomUUID(),
        ...step.headers
      });
      await recordStep(saga, step.name);
    } catch (error) {
      const code = errorCode(error);
      const permanent = error.status >= 400 && error.status < 500;

      // A permanent failure of the first step needs no compensation.
      if (index === 0 && permanent) {
        await finish("failed", code);
        return;
      }

      // Temporary failure of the first step is handled by the retry queue.
      if (index === 0 && !permanent) {
        throw new RetryableError(error, code);
      }

      // Compensate completed steps in reverse order.
      const compensationSteps = [...saga.steps].reverse()
        .map(item => item.step)
        .filter(name => name === "inventory" || name === "payment")
        .map(name => name === "inventory"
          ? {
              name: "inventory_release",
              url: `${INVENTORY_URL}/inventory/release`,
              key: `release:${businessKey}`
            }
          : {
              name: "payment_refund",
              url: `${PAYMENT_URL}/payment/refund`,
              key: `refund:${businessKey}`
            });

      for (const compensation of compensationSteps) {
        try {
          await providerCall(
            compensation.url,
            { orderId: order.orderId },
            {
              ...commonHeaders,
              "X-Causation-Id": randomUUID(),
              "Idempotency-Key": compensation.key
            }
          );

          saga.compensations.push({
            step: compensation.name,
            status: "completed",
            at: new Date().toISOString()
          });
          saga.updatedAt = new Date().toISOString();
          await saveStore();
        } catch (compensationError) {
          const compensationCode = errorCode(compensationError);
          saga.compensations.push({
            step: compensation.name,
            status: "failed",
            code: compensationCode,
            at: new Date().toISOString()
          });
          await saveStore();
          await finish("compensation_failed", compensationCode);
          return;
        }
      }

      await finish("compensated", code);
      return;
    }
  }

  await finish("completed");
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
        const headers = message.properties.headers || {};

        try {
          await processOrder(message);
          channel.ack(message);
        } catch (error) {
          try {
            if (error instanceof InvalidMessageError) {
              console.error("Invalid message quarantined:", error.message);
              await publishRaw("orders.invalid.exchange", "", message.content, {
                persistent: true,
                contentType: message.properties.contentType,
                messageId: randomUUID(),
                headers
              });
              channel.ack(message);
              return;
            }

            const attempt = retryCount(headers) + 1;
            const lastError = error instanceof RetryableError
              ? error.code
              : (error.message || "error").slice(0, 120);
            console.error(`Saga processing failed (attempt ${attempt}):`, error.message);

            if (attempt < MAX_RETRIES) {
              channel.nack(message, false, false);
              return;
            }

            if (error instanceof RetryableError) {
              await parkSaga(message, lastError, attempt);
            } else {
              await deadLetter(message, lastError, attempt);
            }
            channel.ack(message);
          } catch (handlingError) {
            console.error("Saga failure handling failed:", handlingError.message);
            try { channel.nack(message, false, true); } catch { /* channel closed */ }
          }
        }
      });
      
consumers["saga.queue"] = 1;

      connection.on("close", () => {
        consumers["saga.queue"] = 0;
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
      checks: {
        broker: brokerStatus,
        consumers
      }
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
