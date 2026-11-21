import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import amqp from "amqplib";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const PORT = Number(process.env.PORT || 8800);
const DATA_DIR = process.env.DATA_DIR || "/data";
const PRICING_URL = process.env.PRICING_URL || "http://pricing:4100";
const PRICING_KEY = process.env.PRICING_API_KEY || "";
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 2500);
const MAX_ITEMS = Number(process.env.ORDER_ITEMS_MAX || 50);

const IDEMPOTENCY_FILE = path.join(DATA_DIR, "idempotency-store.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true
});

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const schema = JSON.parse(
  await readFile("/canonical/order.schema.json", "utf8")
);
const validateOrder = ajv.compile(schema);

let idempotency = {};
let orders = {};
let channel;
let outcomeChannel;
let brokerConnection;

async function atomicWrite(file, value) {
  await mkdir(DATA_DIR, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, file);
}

async function saveIdempotency() {
  await atomicWrite(IDEMPOTENCY_FILE, idempotency);
}

async function saveOrders() {
  await atomicWrite(ORDERS_FILE, orders);
}

async function loadStores() {
  await mkdir(DATA_DIR, { recursive: true });

  for (const [file, assign] of [
    [IDEMPOTENCY_FILE, value => { idempotency = value; }],
    [ORDERS_FILE, value => { orders = value; }]
  ]) {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid store format: ${file}`);
      }
      assign(value);
    } catch (error) {
      if (error.code === "ENOENT") {
        await atomicWrite(file, {});
      } else {
        throw error;
      }
    }
  }
}

const allowedTransitions = {
  accepted: ["processing", "parked", "completed", "failed", "compensated", "compensation_failed", "needs_attention", "duplicate"],
  processing: ["parked", "completed", "failed", "compensated", "compensation_failed", "needs_attention"],
  parked: ["processing", "completed", "failed", "compensated", "compensation_failed", "needs_attention"],
  compensation_failed: ["compensated", "compensation_failed"],
  needs_attention: ["compensated", "compensation_failed"],
  completed: [],
  failed: [],
  compensated: [],
  duplicate: []
};

async function handleOutcome(message) {
  let event;

  try {
    event = JSON.parse(message.content.toString("utf8"));

    if (
      !event ||
      typeof event.correlationId !== "string" ||
      typeof event.state !== "string" ||
      !allowedTransitions[event.state]
    ) {
      throw new Error("Invalid outcome event");
    }

    if (
      ["failed", "compensated", "compensation_failed"].includes(event.state) &&
      (typeof event.code !== "string" || !event.code)
    ) {
      throw new Error("Outcome event is missing its required code");
    }

    if (event.state === "duplicate" &&
        typeof event.duplicateOf !== "string") {
      throw new Error("Duplicate outcome is missing duplicateOf");
    }
  } catch (error) {
    console.error("Invalid outcome event:", error.message);
    outcomeChannel.ack(message);
    return;
  }

  const order = orders[event.correlationId];

  if (!order) {
    outcomeChannel.nack(message, false, true);
    return;
  }

  if (!allowedTransitions[order.state]?.includes(event.state)) {
    outcomeChannel.ack(message);
    return;
  }

  order.state = event.state;
  order.updatedAt = event.occurredAt || new Date().toISOString();

  if (event.code !== undefined) {
    order.code = event.code;
  }

  if (event.duplicateOf !== undefined) {
    order.duplicateOf = event.duplicateOf;
  }

  try {
    await saveOrders();
    outcomeChannel.ack(message);
  } catch (error) {
    console.error("Could not save order outcome:", error.message);
    outcomeChannel.nack(message, false, true);
  }
}

async function connectBroker() {
  let delay = 500;

  while (!channel || !outcomeChannel) {
    try {
      brokerConnection = await amqp.connect(RABBITMQ_URL);
      channel = await brokerConnection.createConfirmChannel();
      outcomeChannel = await brokerConnection.createChannel();

      await outcomeChannel.prefetch(10);
      await outcomeChannel.consume(
        "intake.outcomes.queue",
        message => {
          if (message) {
            handleOutcome(message).catch(error => {
              console.error("Outcome consumer error:", error);
              if (outcomeChannel) {
                outcomeChannel.nack(message, false, true);
              }
            });
          }
        }
      );

      brokerConnection.on("close", () => {
        channel = undefined;
        outcomeChannel = undefined;
        brokerConnection = undefined;
        connectBroker().catch(error =>
          console.error("RabbitMQ reconnect failed:", error)
        );
      });

      brokerConnection.on("error", error => {
        console.error("RabbitMQ connection error:", error.message);
      });

      console.log("Intake connected to RabbitMQ");
    } catch (error) {
      channel = undefined;
      outcomeChannel = undefined;
      console.error("RabbitMQ unavailable:", error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10000);
    }
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) {
      throw Object.assign(new Error("Request body too large"), {
        status: 400
      });
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function parseContentType(value = "") {
  const [mediaType, ...parameters] = value.split(";");

  const charset = parameters.map(part => {
    const separator = part.indexOf("=");
    if (separator < 0) return null;

    const name = part.slice(0, separator).trim().toLowerCase();
    if (name !== "charset") return null;

    let result = part.slice(separator + 1).trim();

    if (result.length >= 2) {
      const first = result.charCodeAt(0);
      const last = result.charCodeAt(result.length - 1);

      if ((first === 34 || first === 39) && first === last) {
        result = result.slice(1, -1);
      }
    }

    return result;
  }).find(Boolean);

  return {
    mediaType: mediaType.trim().toLowerCase(),
    charset
  };
}

function parseJsonBuffer(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Request body contains invalid JSON");
  }
}

function parseXmlBuffer(bytes, charsetParameter) {
  const declarationText = bytes.subarray(0, 300).toString("ascii");
  const lowerDeclaration = declarationText.toLowerCase();
  const encodingIndex = lowerDeclaration.indexOf("encoding");

  let declaredCharset;

  if (encodingIndex >= 0) {
    const equalsIndex = declarationText.indexOf("=", encodingIndex + 8);

    if (equalsIndex >= 0) {
      let quoteIndex = -1;

      for (let i = equalsIndex + 1; i < declarationText.length; i++) {
        const code = declarationText.charCodeAt(i);

        if (code === 34 || code === 39) {
          quoteIndex = i;
          break;
        }
      }

      if (quoteIndex >= 0) {
        const quote = declarationText[quoteIndex];
        const endQuote = declarationText.indexOf(quote, quoteIndex + 1);

        if (endQuote > quoteIndex) {
          declaredCharset = declarationText.slice(quoteIndex + 1, endQuote);
        }
      }
    }
  }

  // The HTTP charset parameter takes precedence over the XML declaration.
  const charset = charsetParameter || declaredCharset || "utf-8";

  let xml;
  try {
    xml = new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Unsupported or invalid XML charset: ${charset}`);
  }

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error("Request body contains invalid XML");
  }

  const parsed = parser.parse(xml);
  if (!parsed?.PurchaseOrder) {
    throw new Error("XML must contain a PurchaseOrder element");
  }

  return parsed.PurchaseOrder;
}

function required(value, field) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required field: ${field}`);
  }
  return value;
}

function normalizeProductId(source, rawId) {
  const id = String(required(rawId, "product ID"));

  if (source === "mobile") return `PROD-${id}`;
  if (source === "b2b") return id.replace(/^SKU-/, "");

  return id;
}

function mobileAddress(value) {
  const parts = String(required(value, "addr")).split(", ");
  if (parts.length !== 4 || parts.some(part => !part.trim())) {
    throw new Error("Mobile address must contain street, city, postal code and country");
  }

  return {
    street: parts[0],
    city: parts[1],
    postalCode: parts[2],
    country: parts[3]
  };
}

function mobileStatus(code) {
  const statuses = {
    1: "new",
    2: "processing",
    3: "shipped",
    4: "delivered"
  };

  const result = statuses[Number(code)];
  if (!result) throw new Error(`Unrecognized mobile status code: ${code}`);
  return result;
}

function b2bStatus(value) {
  const status = String(required(value, "Status")).trim().toLowerCase();
  if (!["new", "processing", "shipped", "delivered"].includes(status)) {
    throw new Error(`Unrecognized B2B status: ${value}`);
  }
  return status;
}

function currencyCode(value) {
  const code = Number(value);
  return ({
    978: "EUR",
    840: "USD",
    826: "GBP"
  })[code] || String(value);
}

function isoDate(value, field) {
  const date = new Date(required(value, field));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${field}`);
  }
  return date.toISOString();
}

function extractInput(req, bytes) {
  const { mediaType, charset } = parseContentType(
    req.headers["content-type"] || ""
  );

  if (mediaType === "application/xml" || mediaType === "text/xml") {
    const po = parseXmlBuffer(bytes, charset);

    const rawItems = po.LineItems?.LineItem;
    const lineItems = Array.isArray(rawItems)
      ? rawItems
      : rawItems ? [rawItems] : [];

    const buyer = po.BuyerParty;
    const address = buyer?.ShipToAddress;

    return {
      source: "b2b",
      orderId: required(po["@_orderId"], "PurchaseOrder.orderId"),
      orderType: required(po["@_orderType"], "PurchaseOrder.orderType"),
      orderDate: isoDate(po["@_orderDate"], "PurchaseOrder.orderDate"),
      customer: {
        name: required(buyer?.Name, "BuyerParty.Name"),
        email: required(buyer?.ContactEmail, "BuyerParty.ContactEmail"),
        address: {
          street: required(address?.Street, "ShipToAddress.Street"),
          city: required(address?.City, "ShipToAddress.City"),
          postalCode: required(address?.PostalCode, "ShipToAddress.PostalCode"),
          country: required(address?.["@_country"], "ShipToAddress.country")
        }
      },
      currency: required(po.LineItems?.["@_currency"], "LineItems.currency"),
      status: b2bStatus(po.Status),
      items: lineItems.map((item, index) => ({
        productId: normalizeProductId("b2b", item["@_sku"]),
        productName: String(required(item.Description, `LineItem[${index}].Description`)),
        quantity: Number(required(item["@_quantity"], `LineItem[${index}].quantity`))
      }))
    };
  }

  if (mediaType !== "application/json") {
    throw Object.assign(new Error("Content-Type must be application/json, application/xml or text/xml"), {
      status: 415
    });
  }

  const input = parseJsonBuffer(bytes);

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("JSON body must be an object");
  }

  // Web JSON has orderId and a customer object.
  if (input.orderId !== undefined && input.customer &&
      typeof input.customer === "object" && !Array.isArray(input.customer)) {
    const customer = input.customer;
    const address = customer.address;

    return {
      source: "web",
      orderId: required(input.orderId, "orderId"),
      orderType: required(input.orderType, "orderType"),
      orderDate: isoDate(input.orderDate, "orderDate"),
      customer: {
        name: required(customer.name, "customer.name"),
        email: required(customer.email, "customer.email"),
        address: {
          street: required(address?.street, "customer.address.street"),
          city: required(address?.city, "customer.address.city"),
          postalCode: required(address?.postalCode, "customer.address.postalCode"),
          country: required(address?.country, "customer.address.country")
        }
      },
      currency: required(input.currency, "currency"),
      status: required(input.status, "status"),
      items: (required(input.items, "items")).map((item, index) => ({
        productId: normalizeProductId("web", item.productId),
        productName: String(required(item.productName, `items[${index}].productName`)),
        quantity: Number(required(item.quantity, `items[${index}].quantity`))
      }))
    };
  }

  // Mobile JSON uses abbreviated field names.
  if (input.oid !== undefined) {
    return {
      source: "mobile",
      orderId: required(input.oid, "oid"),
      orderType: required(input.ot, "ot"),
      orderDate: isoDate(
        Number(required(input.ts, "ts")) * 1000,
        "ts"
      ),
      customer: {
        name: required(input.cust_name, "cust_name"),
        email: required(input.cust_email, "cust_email"),
        address: mobileAddress(input.addr)
      },
      currency: currencyCode(required(input.cur, "cur")),
      status: mobileStatus(input.st),
      items: (required(input.items, "items")).map((item, index) => ({
        productId: normalizeProductId("mobile", item.pid),
        productName: String(required(item.pname, `items[${index}].pname`)),
        quantity: Number(required(item.qty, `items[${index}].qty`))
      }))
    };
  }

  throw new Error("Unrecognized JSON order format");
}

async function priceItem(item, correlationId) {
  const causationId = randomUUID();

  let response;
  try {
    response = await fetch(
      `${PRICING_URL}/pricing/${encodeURIComponent(item.productId)}`,
      {
        headers: {
          "X-API-Key": PRICING_KEY,
          "X-Correlation-Id": correlationId,
          "X-Causation-Id": causationId
        },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      }
    );
  } catch (error) {
    return { kind: "unavailable", error };
  }

  if (response.status === 404) {
    return { kind: "unknown", productId: item.productId };
  }

  if (!response.ok) {
    return { kind: "unavailable", error: new Error(`Pricing returned ${response.status}`) };
  }

  try {
    const data = await response.json();

    if (
      typeof data.unitPrice !== "number" ||
      !Number.isFinite(data.unitPrice) ||
      typeof data.currency !== "string" ||
      typeof data.taxRate !== "number"
    ) {
      throw new Error("Invalid pricing response");
    }

    return {
      kind: "ok",
      item: {
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: data.unitPrice.toFixed(2),
        currency: data.currency,
        taxRate: data.taxRate
      }
    };
  } catch (error) {
    return { kind: "unavailable", error };
  }
}

async function enrichOrder(input, correlationId) {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error("Order must contain at least one item");
  }

  if (input.items.length > MAX_ITEMS) {
    throw new Error(`Order exceeds the maximum of ${MAX_ITEMS} items`);
  }

  const results = [];
  for (const item of input.items) {
    results.push(await priceItem(item, correlationId));
  }

  const unknownIds = results
    .filter(result => result.kind === "unknown")
    .map(result => result.productId);

  if (unknownIds.length) {
    return { unknownIds };
  }

  if (results.some(result => result.kind === "unavailable")) {
    return { unavailable: true };
  }

  const order = {
    orderId: input.orderId,
    orderType: input.orderType,
    source: input.source,
    receivedAt: new Date().toISOString(),
    orderDate: input.orderDate,
    customer: input.customer,
    items: results.map(result => result.item),
    currency: input.currency,
    status: input.status
  };

  if (!validateOrder(order)) {
    const details = ajv.errorsText(validateOrder.errors, {
      separator: "; "
    });
    throw new Error(`Canonical order validation failed: ${details}`);
  }

  return { order };
}

function emitHop(h) {
  try {
    if (!channel) return;
    const finishedAt = h.finishedAt || new Date();
    channel.publish("trace.events", "", Buffer.from(JSON.stringify({
      hopId: h.hopId,
      correlationId: h.correlationId,
      causationId: h.causationId ?? null,
      service: "intake",
      operation: h.operation,
      status: h.status || "success",
      attempt: 1,
      startedAt: h.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - h.startedAt.getTime())
    })), { contentType: "application/json", messageId: randomUUID() });
  } catch (error) {
    console.error("Trace hop failed:", error.message);
  }
}

function publishConfirmed(exchange, body, options) {
  return new Promise((resolve, reject) => {
    if (!channel) {
      reject(new Error("RabbitMQ channel unavailable"));
      return;
    }

    channel.publish(
      exchange,
      "",
      Buffer.from(JSON.stringify(body)),
      options,
      error => error ? reject(error) : resolve()
    );
  });
}

async function processOrder(req, res) {
  const receiveStart = new Date();
  const key = req.headers["idempotency-key"];

  if (
    typeof key !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(key)
  ) {
    return sendJson(res, 400, {
      code: "validation_error",
      message: "A valid Idempotency-Key header is required"
    });
  }

  const bytes = await readBody(req);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const existing = idempotency[key];

  if (existing) {
    if (existing.hash !== hash) {
      return sendJson(res, 409, {
        code: "idempotency_payload_mismatch",
        message: "This Idempotency-Key was already used with a different payload"
      });
    }

    if (existing.state === "processing") {
      return sendJson(res, 409, {
        code: "idempotency_conflict",
        message: "A request with this Idempotency-Key is still processing"
      });
    }

    return sendJson(res, existing.status, existing.body, existing.headers || {});
  }

  idempotency[key] = {
    hash,
    state: "processing",
    createdAt: new Date().toISOString()
  };
  await saveIdempotency();

  const releaseKey = async () => {
    delete idempotency[key];
    await saveIdempotency();
  };

  const complete = async (status, body, headers = {}) => {
    idempotency[key] = {
      hash,
      state: "done",
      status,
      body,
      headers,
      createdAt: new Date().toISOString()
    };
    await saveIdempotency();
    return sendJson(res, status, body, headers);
  };

  try {
    const translateStart = new Date();
    const input = extractInput(req, bytes);
    const correlationId = randomUUID();
    const businessKey = `${input.source}:${input.orderId}`;

    const receiveId = randomUUID();
    const translateId = randomUUID();
    const enrichId = randomUUID();
    const pending = [];
    const mk = (operation, startedAt, hopId, causation) => ({
      hopId, correlationId, causationId: causation, operation, startedAt, finishedAt: new Date()
    });
    pending.push(mk("intake.translate", translateStart, translateId, receiveId));
    const enrichStart = new Date();
    const result = await enrichOrder(input, correlationId);
    pending.push(mk("intake.enrich", enrichStart, enrichId, translateId));

    if (result.unknownIds) {
      return await complete(422, {
        code: "unknown_product",
        productIds: [...new Set(result.unknownIds)]
      });
    }

    if (result.unavailable) {
      await releaseKey();
      return sendJson(res, 503, {
        code: "pricing_unavailable",
        message: "The pricing service is temporarily unavailable"
      }, { "Retry-After": "1" });
    }

    const order = result.order;
    const publishStart = new Date();
    const causationId = randomUUID();

    try {
      await publishConfirmed(
        "orders.exchange",
        order,
        {
          persistent: true,
          contentType: "application/json",
          messageId: randomUUID(),
          headers: {
            correlationId,
            causationId,
            businessKey
          }
        }
      );
    } catch (error) {
      console.error("Order publish failed:", error.message);
      await releaseKey();
      return sendJson(res, 503, {
        code: "broker_unavailable",
        message: "The order broker could not confirm publication"
      }, { "Retry-After": "1" });
    }

    pending.push(mk("intake.publish", publishStart, causationId, enrichId));
    emitHop(mk("intake.receive", receiveStart, receiveId, null));
    for (const h of pending) emitHop(h);

    const now = new Date().toISOString();

    const accepted = {
      correlationId,
      status: "accepted"
    };

    orders[correlationId] = {
      ...accepted,
      orderId: order.orderId,
      source: order.source,
      orderType: order.orderType,
      businessKey,
      state: "accepted",
      createdAt: now,
      updatedAt: now
    };

    await saveOrders();
    return await complete(202, accepted);
  } catch (error) {
    console.error("Order validation failed:", error.message);
    await releaseKey();

    return sendJson(res, 400, {
      code: "validation_error",
      message: error.message
    });
  }
}

// ---- DLQ operations (README §4.6) ----
const DLQ_QUEUE = "orders.dlq";
let dlqChain = Promise.resolve();

function withDlqLock(fn) {
  const run = dlqChain.then(fn, fn);
  dlqChain = run.catch(() => {});
  return run;
}

function dlqStripHistory(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith("x-")) continue;
    if (["originQueue", "lastError", "attempts", "deadLetteredAt", "causationId"].includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function dlqHop(operation, correlationId, causationId, hopId, startedAt, status, detail) {
  try {
    if (!correlationId || !channel) return;
    const finished = new Date();
    channel.publish("trace.events", "", Buffer.from(JSON.stringify({
      hopId,
      correlationId,
      causationId: causationId ?? null,
      service: "intake",
      operation,
      status,
      attempt: 1,
      startedAt: startedAt.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - startedAt.getTime(),
      ...(detail ? { detail } : {})
    })), { contentType: "application/json", messageId: randomUUID() });
  } catch (error) {
    console.error("Trace hop failed:", error.message);
  }
}

async function dlqTakeAll(ch) {
  const messages = [];
  for (;;) {
    const message = await ch.get(DLQ_QUEUE, { noAck: false });
    if (!message) break;
    messages.push(message);
  }
  return messages;
}

function dlqEntry(message) {
  const headers = message.properties.headers || {};
  const deaths = Array.isArray(headers["x-death"]) ? headers["x-death"] : [];
  const attempts = headers.attempts !== undefined && Number.isFinite(Number(headers.attempts))
    ? Number(headers.attempts)
    : deaths.reduce((sum, d) => sum + Number(d.count || 0), 0);
  return {
    messageId: message.properties.messageId ?? null,
    correlationId: headers.correlationId ?? null,
    originQueue: headers.originQueue ?? null,
    attempts,
    lastError: headers.lastError ?? "unknown",
    deadLetteredAt: headers.deadLetteredAt
      ?? (message.properties.timestamp ? new Date(message.properties.timestamp * 1000).toISOString() : new Date().toISOString())
  };
}

// Non-destructive: take every message, describe it, then give them all back.
function dlqList() {
  if (!brokerConnection) return Promise.resolve({ status: 503, body: { code: "broker_unavailable" } });
  return withDlqLock(async () => {
    const ch = await brokerConnection.createChannel();
    try {
      const messages = await dlqTakeAll(ch);
      const entries = messages.map(dlqEntry);
      ch.nackAll(true);
      return { status: 200, body: { count: entries.length, entries } };
    } finally {
      await ch.close().catch(() => {});
    }
  });
}

function dlqReplay(bytes) {
  let filter;
  try {
    const text = bytes.toString("utf8").trim();
    filter = text ? JSON.parse(text) : {};
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("body must be an object");
    if (filter.correlationId !== undefined && typeof filter.correlationId !== "string") throw new Error("correlationId must be a string");
  } catch (error) {
    return Promise.resolve({ status: 400, body: { code: "validation_error", message: error.message } });
  }
  if (!brokerConnection) return Promise.resolve({ status: 503, body: { code: "broker_unavailable" } });

  return withDlqLock(async () => {
    const ch = await brokerConnection.createConfirmChannel();
    try {
      const messages = await dlqTakeAll(ch);
      let replayed = 0;

      for (const message of messages) {
        const headers = message.properties.headers || {};
        const wanted = !filter.correlationId || headers.correlationId === filter.correlationId;

        if (!wanted || !headers.originQueue) {
          ch.nack(message, false, true);
          continue;
        }

        const hopId = randomUUID();
        const startedAt = new Date();

        try {
          await new Promise((resolve, reject) => {
            ch.publish(
              "orders.return.exchange",
              headers.originQueue,
              message.content,
              {
                persistent: true,
                contentType: message.properties.contentType,
                messageId: randomUUID(),
                headers: { ...dlqStripHistory(headers), causationId: hopId }
              },
              error => (error ? reject(error) : resolve())
            );
          });
          ch.ack(message);
          replayed += 1;
          dlqHop("dlq.replay", headers.correlationId, headers.causationId, hopId, startedAt, "success", { originQueue: headers.originQueue });
        } catch (error) {
          console.error("DLQ replay failed:", error.message);
          ch.nack(message, false, true);
        }
      }

      return { status: 200, body: { replayed, remaining: messages.length - replayed } };
    } finally {
      await ch.close().catch(() => {});
    }
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const healthy = Boolean(channel && channel.connection?.stream?.writable);
      return sendJson(res, healthy ? 200 : 503, {
        status: healthy ? "ok" : "unavailable",
        checks: {
          broker: healthy ? "up" : "down",
          consumers: {}
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/dlq") {
      const r = await dlqList();
      return sendJson(res, r.status, r.body);
    }

    if (req.method === "POST" && url.pathname === "/dlq/replay") {
      const r = await dlqReplay(await readBody(req));
      return sendJson(res, r.status, r.body);
    }

    if (req.method === "POST" && url.pathname === "/orders") {
      return await processOrder(req, res);
    }

    if (req.method === "GET" && url.pathname.startsWith("/orders/")) {
      const correlationId = decodeURIComponent(
        url.pathname.slice("/orders/".length)
      );
      const order = orders[correlationId];

      if (!order) {
        return sendJson(res, 404, {
          code: "not_found",
          message: "Order not found"
        });
      }

      return sendJson(res, 200, order);
    }

    return sendJson(res, 404, {
      code: "not_found",
      message: "Endpoint not found"
    });
  } catch (error) {
    console.error("Request failed:", error);
    if (!res.headersSent) {
      sendJson(res, error.status || 400, {
        code: "validation_error",
        message: error.message
      });
    }
  }
});

await loadStores();
await connectBroker();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Intake listening on port ${PORT}`);
});
