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
const SAGA_ENGINE = process.env.SAGA_ENGINE || "handrolled";
const RUN_ID = randomUUID(); // this orchestrator run; stored as saga.owner

const canonicalSchema = JSON.parse(await readFile("/canonical/order.schema.json", "utf8"));
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateCanonicalOrder = ajv.compile(canonicalSchema);

const STORE_FILE = path.join(DATA_DIR, "saga-store.json");

let store = { sagas: {}, businessKeys: {} };
let connection;
let channel;
let brokerStatus = "down";
const consumers = {};
const lastHop = new Map(); // correlationId -> hopId of the latest hop (in memory only)
const operatorRunning = new Set();

class InvalidMessageError extends Error {}

class RetryableError extends Error {
  constructor(cause, code, details) {
    super(cause.message);
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------- store
async function writeStore() {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), "utf8");
  await rename(temporary, STORE_FILE);
}

// Saves are serialized, and each one writes the latest in-memory state, so a
// slow earlier write can never land after a newer one (R-4.10.3).
let saveChain = Promise.resolve();
function saveStore() {
  const next = saveChain.then(writeStore, writeStore);
  saveChain = next.catch(() => {});
  return next;
}

async function loadStore() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    store = JSON.parse(await readFile(STORE_FILE, "utf8"));
    if (!store.sagas || !store.businessKeys) throw new Error("Invalid saga store format");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveStore();
  }
}

// ---------------------------------------------------------------- helpers
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
    headers: { "Content-Type": "application/json", ...headers },
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

function errorCode(error) {
  if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
  if (error instanceof TypeError || error.code === "ECONNREFUSED") return "unreachable";
  return error.code || "provider_error";
}

function publishConfirmed(exchange, routingKey, content, options) {
  return new Promise((resolve, reject) => {
    if (!channel) {
      reject(new Error("channel unavailable"));
      return;
    }
    channel.publish(exchange, routingKey, content, options, error => (error ? reject(error) : resolve()));
  });
}

function publishOutcome(envelope, correlationId, causationId) {
  return publishConfirmed(
    "orders.outcome",
    `order.${envelope.state}`,
    Buffer.from(JSON.stringify(envelope)),
    {
      persistent: true,
      contentType: "application/json",
      messageId: randomUUID(),
      headers: { correlationId, causationId }
    }
  );
}

// A hop is fire and forget: it never blocks or fails the business operation.
function emitHop(correlationId, operation, o = {}) {
  const hopId = o.hopId || randomUUID();
  const startedAt = o.startedAt || new Date();
  const finishedAt = new Date();
  if (correlationId) lastHop.set(correlationId, hopId);
  try {
    if (channel && correlationId) {
      channel.publish("trace.events", "", Buffer.from(JSON.stringify({
        hopId,
        correlationId,
        causationId: o.causationId ?? null,
        service: "orchestrator",
        operation,
        status: o.status || "success",
        attempt: o.attempt || 1,
        ...(o.messageId ? { messageId: o.messageId } : {}),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        ...(o.detail ? { detail: o.detail } : {})
      })), { contentType: "application/json", messageId: randomUUID() });
    }
  } catch (error) {
    console.error("Trace hop failed:", error.message);
  }
  return hopId;
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

async function deadLetter(message, lastError, attempt, causationId) {
  const headers = message.properties.headers || {};
  await publishConfirmed("orders.dlq.exchange", "", message.content, {
    persistent: true,
    contentType: message.properties.contentType,
    messageId: randomUUID(),
    headers: {
      ...stripHistory(headers),
      correlationId: headers.correlationId,
      causationId,
      originQueue: "saga.queue",
      lastError,
      attempts: attempt,
      deadLetteredAt: new Date().toISOString()
    }
  });
}

async function parkSaga(message, ctx, error, attempt) {
  const { order, businessKey } = error.details;
  const correlationId = ctx.cid;
  const deadLetterId = randomUUID();
  const startedAt = new Date();

  await deadLetter(message, error.details.lastError, attempt, deadLetterId);
  emitHop(correlationId, "saga.dead_letter", {
    hopId: deadLetterId,
    startedAt,
    causationId: ctx.consumeId,
    status: "dead_lettered",
    attempt,
    messageId: message.properties.messageId,
    detail: { lastError: error.details.lastError }
  });

  const saga = store.sagas[correlationId];
  saga.state = "parked";
  saga.updatedAt = new Date().toISOString();
  await saveStore();

  const outcomeId = randomUUID();
  const outcomeStart = new Date();
  await publishOutcome({
    correlationId,
    businessKey,
    orderId: order.orderId,
    source: order.source,
    orderType: order.orderType,
    recipient: order.customer.email,
    state: "parked",
    occurredAt: new Date().toISOString()
  }, correlationId, outcomeId);
  emitHop(correlationId, "saga.outcome", {
    hopId: outcomeId,
    startedAt: outcomeStart,
    causationId: deadLetterId,
    attempt,
    detail: { state: "parked" }
  });
}

async function recordStep(saga, step) {
  saga.steps.push({ step, status: "completed", at: new Date().toISOString() });
  saga.updatedAt = new Date().toISOString();
  await saveStore();
}

function compensationFor(stepName, businessKey) {
  return stepName === "inventory"
    ? { name: "inventory_release", url: `${INVENTORY_URL}/inventory/release`, key: `release:${businessKey}` }
    : { name: "payment_refund", url: `${PAYMENT_URL}/payment/refund`, key: `refund:${businessKey}` };
}

// ---------------------------------------------------------------- the saga
async function processOrder(message, ctx) {
  let order;
  try {
    order = JSON.parse(message.content.toString("utf8"));
  } catch (error) {
    throw new InvalidMessageError(`not JSON: ${error.message}`);
  }

  if (!validateCanonicalOrder(order)) {
    throw new InvalidMessageError(`invalid canonical order: ${ajv.errorsText(validateCanonicalOrder.errors)}`);
  }

  const headers = message.properties.headers || {};
  const correlationId = headers.correlationId;
  if (!correlationId) throw new InvalidMessageError("no correlationId header");

  const businessKey = headers.businessKey || `${order.source}:${order.orderId}`;

  emitHop(correlationId, "saga.consume", {
    hopId: ctx.consumeId,
    startedAt: ctx.startedAt,
    causationId: headers.causationId ?? null,
    attempt: ctx.attempt,
    messageId: message.properties.messageId
  });
  ctx.consumed = true;
  let prev = ctx.consumeId;

  const base = (state, extra = {}) => ({
    correlationId,
    businessKey,
    orderId: order.orderId,
    source: order.source,
    orderType: order.orderType,
    recipient: order.customer.email,
    state,
    ...extra,
    occurredAt: new Date().toISOString()
  });

  async function publishWithHop(envelope, causationId) {
    const outcomeId = randomUUID();
    const startedAt = new Date();
    await publishOutcome(envelope, correlationId, outcomeId);
    emitHop(correlationId, "saga.outcome", {
      hopId: outcomeId,
      startedAt,
      causationId,
      attempt: ctx.attempt,
      detail: { state: envelope.state, ...(envelope.code ? { code: envelope.code } : {}) }
    });
  }

  const existing = store.sagas[correlationId];

  // R-4.2.4: a saga that already has an outcome: republish it, run nothing.
  if (existing?.outcome) {
    const dedupeId = emitHop(correlationId, "saga.dedupe", {
      causationId: prev,
      status: "skipped",
      attempt: ctx.attempt,
      detail: { reason: "redelivery" }
    });
    await publishWithHop({ ...existing.outcome.envelope }, dedupeId);
    return;
  }

  // R-4.2.5, R-4.7.1: steps ran under a run that is gone, and no outcome exists: stuck.
  if (existing && existing.steps.length > 0) {
    const stuckId = emitHop(correlationId, "saga.stuck", {
      causationId: prev,
      attempt: ctx.attempt,
      detail: { completedSteps: existing.steps.map(item => item.step) }
    });
    const envelope = base("needs_attention");
    existing.state = "needs_attention";
    existing.outcome = { routingKey: "order.needs_attention", envelope };
    existing.updatedAt = envelope.occurredAt;
    await saveStore();
    await publishWithHop(envelope, stuckId);
    return;
  }

  // R-4.2.3: the same business key under another correlationId. Check and set
  // happen with no await between them, so two sagas never share a business key.
  const firstCorrelationId = store.businessKeys[businessKey];
  if (firstCorrelationId && firstCorrelationId !== correlationId) {
    const dedupeId = emitHop(correlationId, "saga.dedupe", {
      causationId: prev,
      status: "duplicate",
      attempt: ctx.attempt,
      detail: { duplicateOf: firstCorrelationId }
    });
    const envelope = base("duplicate", { duplicateOf: firstCorrelationId });
    store.sagas[correlationId] = {
      businessKey,
      state: "duplicate",
      steps: [],
      compensations: [],
      owner: RUN_ID,
      outcome: { routingKey: "order.duplicate", envelope },
      updatedAt: envelope.occurredAt
    };
    await saveStore();
    await publishWithHop(envelope, dedupeId);
    return;
  }

  const resumingFromPark = existing?.state === "parked";
  const saga = existing || {
    businessKey,
    state: "processing",
    steps: [],
    compensations: [],
    owner: RUN_ID,
    updatedAt: new Date().toISOString()
  };

  if (!existing) {
    store.sagas[correlationId] = saga;
    store.businessKeys[businessKey] = correlationId;
  }
  saga.owner = RUN_ID;

  // R-4.2.7: the semantic lock, before the first step (and again after a replay).
  if (!existing || resumingFromPark) {
    saga.state = "processing";
    saga.updatedAt = new Date().toISOString();
    await saveStore();
    await publishOutcome(base("processing"), correlationId, ctx.consumeId);
  }

  const commonHeaders = { "X-Correlation-Id": correlationId };

  const steps = [
    ...(order.orderType === "b2b" ? [] : [{
      name: "payment",
      url: `${PAYMENT_URL}/payment/authorize`,
      body: { orderId: order.orderId, amount: amountInCents(order.items) },
      headers: { "Idempotency-Key": `authorize:${businessKey}` }
    }]),
    {
      name: "inventory",
      url: `${INVENTORY_URL}/inventory/reserve`,
      body: { orderId: order.orderId, items: order.items },
      headers: { "Idempotency-Key": `reserve:${businessKey}` }
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
      body: { orderId: order.orderId, recipient: order.customer.email, kind: "order_confirmed" },
      headers: {}
    }
  ];

  async function finish(state, code) {
    const envelope = base(state, code ? { code } : {});
    saga.state = state;
    saga.outcome = { routingKey: `order.${state}`, envelope };
    saga.updatedAt = envelope.occurredAt;
    await saveStore();
    await publishWithHop(envelope, prev);
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const stepHopId = randomUUID();
    const startedAt = new Date();

    let failure = null;
    try {
      await providerCall(step.url, step.body, {
        ...commonHeaders,
        "X-Causation-Id": stepHopId,
        ...step.headers
      });
    } catch (error) {
      failure = error;
    }

    if (!failure) {
      emitHop(correlationId, step.name, { hopId: stepHopId, startedAt, causationId: prev, attempt: ctx.attempt });
      prev = stepHopId;
      await recordStep(saga, step.name);
      continue;
    }

    const code = errorCode(failure);
    emitHop(correlationId, step.name, {
      hopId: stepHopId,
      startedAt,
      causationId: prev,
      status: code === "timeout" ? "timeout" : "failed",
      attempt: ctx.attempt,
      detail: { code }
    });
    prev = stepHopId;

    const permanent = failure.status >= 400 && failure.status < 500;

    // R-4.2.15: a permanent failure of the first step needs no compensation.
    if (index === 0 && permanent) {
      await finish("failed", code);
      return;
    }

    // R-4.2.12: a temporary failure of the first step goes to the retry path.
    if (index === 0) {
      throw new RetryableError(failure, code, {
        order,
        businessKey,
        lastError: `${step.name} ${failure.status ?? code}`
      });
    }

    // R-4.2.16: compensate the completed steps in reverse order.
    saga.failureCode = code;
    const compensations = [...saga.steps].reverse()
      .map(item => item.step)
      .filter(name => name === "inventory" || name === "payment")
      .map(name => compensationFor(name, businessKey));

    for (const compensation of compensations) {
      const compensationHopId = randomUUID();
      const compensationStart = new Date();

      let compensationError = null;
      try {
        await providerCall(compensation.url, { orderId: order.orderId }, {
          ...commonHeaders,
          "X-Causation-Id": compensationHopId,
          "Idempotency-Key": compensation.key
        });
      } catch (error) {
        compensationError = error;
      }

      if (!compensationError) {
        emitHop(correlationId, compensation.name, {
          hopId: compensationHopId,
          startedAt: compensationStart,
          causationId: prev,
          attempt: ctx.attempt
        });
        prev = compensationHopId;
        saga.compensations.push({ step: compensation.name, status: "completed", at: new Date().toISOString() });
        saga.updatedAt = new Date().toISOString();
        await saveStore();
      } else {
        const compensationCode = errorCode(compensationError);
        emitHop(correlationId, compensation.name, {
          hopId: compensationHopId,
          startedAt: compensationStart,
          causationId: prev,
          status: compensationCode === "timeout" ? "timeout" : "failed",
          attempt: ctx.attempt,
          detail: { code: compensationCode }
        });
        prev = compensationHopId;
        saga.compensations.push({ step: compensation.name, status: "failed", code: compensationCode, at: new Date().toISOString() });
        await saveStore();
        await finish("compensation_failed", compensationCode);
        return;
      }
    }

    await finish("compensated", code);
    return;
  }

  await finish("completed");
}

// ---------------------------------------------------------------- operator
function stuckList() {
  return Object.entries(store.sagas)
    .filter(([, saga]) => saga.state === "needs_attention" || saga.state === "compensation_failed")
    .map(([correlationId, saga]) => ({
      correlationId,
      businessKey: saga.businessKey,
      state: saga.state,
      completedSteps: saga.steps.map(item => item.step),
      compensatedSteps: saga.compensations.filter(item => item.status === "completed").map(item => item.step),
      since: saga.updatedAt
    }));
}

async function operatorCompensate(correlationId) {
  const saga = store.sagas[correlationId];
  if (!saga) return { status: 404, body: { code: "not_found" } };

  if (operatorRunning.has(correlationId)) {
    return { status: 409, body: { code: "compensation_in_progress" } };
  }
  if (saga.state === "compensated" && saga.operatorCompensation) {
    return { status: 200, body: { correlationId, state: "compensated" } };
  }
  if (saga.state !== "needs_attention" && saga.state !== "compensation_failed") {
    return { status: 409, body: { code: "saga_not_stuck" } };
  }
  if (!channel) return { status: 503, body: { code: "broker_unavailable" } };

  operatorRunning.add(correlationId);
  try {
    const startedAt = new Date().toISOString();
    const wasStuck = saga.state === "needs_attention";
    const known = saga.outcome.envelope;

    let prev = emitHop(correlationId, "saga.operator_compensate", {
      causationId: lastHop.get(correlationId) ?? null,
      detail: { from: saga.state }
    });

    const done = new Set(saga.compensations.filter(item => item.status === "completed").map(item => item.step));
    const outstanding = [...saga.steps].reverse()
      .map(item => item.step)
      .filter(name => name === "inventory" || name === "payment")
      .map(name => compensationFor(name, saga.businessKey))
      .filter(compensation => !done.has(compensation.name));

    let state = "compensated";
    let code = wasStuck ? "operator_compensated" : (saga.failureCode || "operator_compensated");

    for (const compensation of outstanding) {
      const hopId = randomUUID();
      const started = new Date();

      let failure = null;
      try {
        await providerCall(compensation.url, { orderId: known.orderId }, {
          "X-Correlation-Id": correlationId,
          "X-Causation-Id": hopId,
          "Idempotency-Key": compensation.key
        });
      } catch (error) {
        failure = error;
      }

      if (!failure) {
        emitHop(correlationId, compensation.name, { hopId, startedAt: started, causationId: prev });
        prev = hopId;
        saga.compensations.push({ step: compensation.name, status: "completed", at: new Date().toISOString() });
        await saveStore();
      } else {
        const failureCode = errorCode(failure);
        emitHop(correlationId, compensation.name, {
          hopId,
          startedAt: started,
          causationId: prev,
          status: failureCode === "timeout" ? "timeout" : "failed",
          detail: { code: failureCode }
        });
        prev = hopId;
        saga.compensations.push({ step: compensation.name, status: "failed", code: failureCode, at: new Date().toISOString() });
        state = "compensation_failed";
        code = failureCode;
        break;
      }
    }

    const envelope = {
      correlationId,
      businessKey: saga.businessKey,
      orderId: known.orderId,
      source: known.source,
      orderType: known.orderType,
      recipient: known.recipient,
      state,
      code,
      occurredAt: new Date().toISOString()
    };

    saga.state = state;
    saga.outcome = { routingKey: `order.${state}`, envelope };
    saga.operatorCompensation = { startedAt, finishedAt: envelope.occurredAt, result: state };
    saga.updatedAt = envelope.occurredAt;
    await saveStore();

    const outcomeId = randomUUID();
    const outcomeStart = new Date();
    await publishOutcome(envelope, correlationId, outcomeId);
    emitHop(correlationId, "saga.outcome", {
      hopId: outcomeId,
      startedAt: outcomeStart,
      causationId: prev,
      detail: { state, code }
    });

    return { status: 200, body: { correlationId, state } };
  } finally {
    operatorRunning.delete(correlationId);
  }
}

// ---------------------------------------------------------------- broker
async function connectBroker() {
  let delay = 500;

  while (!channel) {
    try {
      connection = await amqp.connect(RABBITMQ_URL);
      channel = await connection.createConfirmChannel();
      const ch = channel;

      await ch.prefetch(CONCURRENCY);

      await ch.consume("saga.queue", async message => {
        if (!message) return;

        const headers = message.properties.headers || {};
        const ctx = {
          cid: headers.correlationId,
          consumeId: randomUUID(),
          startedAt: new Date(),
          attempt: retryCount(headers) + 1,
          consumed: false
        };

        try {
          await processOrder(message, ctx);
          ch.ack(message);
        } catch (error) {
          try {
            // R-4.2.2: a permanent failure: quarantined with its original bytes, never retried.
            if (error instanceof InvalidMessageError) {
              console.error("Invalid message quarantined:", error.message);
              if (ctx.cid && !ctx.consumed) {
                emitHop(ctx.cid, "saga.consume", {
                  hopId: ctx.consumeId,
                  startedAt: ctx.startedAt,
                  causationId: headers.causationId ?? null,
                  status: "failed",
                  attempt: ctx.attempt,
                  messageId: message.properties.messageId
                });
                emitHop(ctx.cid, "invalid.quarantine", {
                  causationId: ctx.consumeId,
                  status: "quarantined",
                  attempt: ctx.attempt,
                  detail: { reason: error.message.slice(0, 200) }
                });
              }
              await publishConfirmed("orders.invalid.exchange", "", message.content, {
                persistent: true,
                contentType: message.properties.contentType,
                messageId: randomUUID(),
                headers
              });
              ch.ack(message);
              return;
            }

            const attempt = ctx.attempt;
            const lastError = error instanceof RetryableError
              ? error.details.lastError
              : (error.message || "error").slice(0, 120);
            console.error(`Saga processing failed (attempt ${attempt}):`, error.message);

            if (attempt < MAX_RETRIES) {
              if (ctx.cid && ctx.consumed) {
                emitHop(ctx.cid, "saga.retry", {
                  causationId: ctx.consumeId,
                  status: "retried",
                  attempt,
                  detail: { lastError }
                });
              }
              ch.nack(message, false, false); // into the retry path
              return;
            }

            if (error instanceof RetryableError) {
              await parkSaga(message, ctx, error, attempt);
            } else {
              const deadLetterId = randomUUID();
              const startedAt = new Date();
              await deadLetter(message, lastError, attempt, deadLetterId);
              if (ctx.cid && ctx.consumed) {
                emitHop(ctx.cid, "saga.dead_letter", {
                  hopId: deadLetterId,
                  startedAt,
                  causationId: ctx.consumeId,
                  status: "dead_lettered",
                  attempt,
                  detail: { lastError }
                });
              }
            }
            ch.ack(message);
          } catch (handlingError) {
            console.error("Saga failure handling failed:", handlingError.message);
            try { ch.nack(message, false, true); } catch { /* channel closed */ }
          }
        }
      });
      consumers["saga.queue"] = 1;

      connection.on("close", () => {
        consumers["saga.queue"] = 0;
        channel = undefined;
        connection = undefined;
        brokerStatus = "down";
        connectBroker().catch(error => console.error("RabbitMQ reconnect failed:", error));
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

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      const healthy = brokerStatus === "up";
      return sendJson(res, healthy ? 200 : 503, {
        status: healthy ? "ok" : "degraded",
        checks: { broker: brokerStatus, consumers }
      });
    }

    if (req.method === "GET" && url.pathname === "/sagas/stuck") {
      return sendJson(res, 200, { sagas: SAGA_ENGINE === "temporal" ? [] : stuckList() });
    }

    const match = /^\/sagas\/([^/]+)\/compensate$/.exec(url.pathname);
    if (req.method === "POST" && match) {
      req.resume();
      if (SAGA_ENGINE === "temporal") return sendJson(res, 409, { code: "saga_not_stuck" });
      const result = await operatorCompensate(decodeURIComponent(match[1]));
      return sendJson(res, result.status, result.body);
    }

    return sendJson(res, 404, { code: "not_found" });
  } catch (error) {
    console.error("Request failed:", error.message);
    if (!res.headersSent) sendJson(res, 500, { code: "internal_error" });
  }
});

await loadStore();
await connectBroker();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Orchestrator listening on port ${PORT}`);
});
