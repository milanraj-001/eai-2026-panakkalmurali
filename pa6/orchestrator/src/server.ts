import express, { type Request, type Response } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { CanonicalOrder } from "./canonical-order.js";

const app = express();
app.use(express.json());

const config = {
  port: Number(process.env.ORCHESTRATOR_PORT || 3000),
  paymentUrl: process.env.PAYMENT_URL || "http://payment:4001",
  inventoryUrl: process.env.INVENTORY_URL || "http://inventory:4002",
  shippingUrl: process.env.SHIPPING_URL || "http://shipping:4003",
  notificationUrl: process.env.NOTIFICATION_URL || "http://notification:4004",
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 2500),
};

const DATA_DIR = "/data";
const IDEMPOTENCY_FILE = path.join(DATA_DIR, "idempotency-store.json");
const SAGA_FILE = path.join(DATA_DIR, "saga-store.json");

interface TraceItem {
  step: string;
  status: "success" | "failed" | "timeout";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

type CheckoutStatus = "completed" | "failed" | "compensated" | "in_progress";

interface CheckoutResponse {
  orderId: string;
  status: CheckoutStatus;
  trace: TraceItem[];
  code?: string;
}

interface IdempotencyRecord {
  requestHash: string;
  state: CheckoutStatus;
  httpStatus: number;
  response: CheckoutResponse;
  updatedAt: string;
}

interface IdempotencyStore {
  records: Record<string, IdempotencyRecord>;
}

interface SagaRecord {
  idempotencyKey: string;
  state: "completed" | "failed" | "compensated";
  steps: TraceItem[];
  updatedAt: string;
}

interface SagaStore {
  sagas: Record<string, SagaRecord>;
}

interface StepResult {
  success: boolean;
  timedOut: boolean;
  code?: string;
}

const traceStorage = new AsyncLocalStorage<TraceItem[]>();

function currentTrace(): TraceItem[] {
  const current = traceStorage.getStore();
  if (!current) throw new Error("Checkout trace context is missing.");
  return current;
}

fs.mkdirSync(DATA_DIR, { recursive: true });

function readStore<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeStore<T>(file: string, data: T): void {
  const temporaryFile = `${file}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2));
  fs.renameSync(temporaryFile, file);
}

function readIdempotencyStore(): IdempotencyStore {
  return readStore(IDEMPOTENCY_FILE, { records: {} });
}

function readSagaStore(): SagaStore {
  return readStore(SAGA_FILE, { sagas: {} });
}

function hashPayload(payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const canonicalSchema = JSON.parse(
  fs.readFileSync("/canonical/order.schema.json", "utf8")
);

const validateOrder = ajv.compile<CanonicalOrder>(canonicalSchema);

function calculateAmount(order: CanonicalOrder): string {
  let totalCents = 0n;

  for (const item of order.items) {
    const match = /^(-?)(\d+)\.(\d{2})$/.exec(item.unitPrice);

    if (!match) {
      throw new Error("Invalid unit price");
    }

    const sign = match[1] === "-" ? -1n : 1n;
    const whole = BigInt(match[2]!);
    const fraction = BigInt(match[3]!);
    const itemCents = sign * (whole * 100n + fraction);

    totalCents += itemCents * BigInt(item.quantity);
  }

  const sign = totalCents < 0n ? "-" : "";
  const absoluteCents = totalCents < 0n ? -totalCents : totalCents;
  const whole = absoluteCents / 100n;
  const fraction = String(absoluteCents % 100n).padStart(2, "0");

  return `${sign}${whole}.${fraction}`;
}

function serviceUrl(base: string, endpoint: string): string {
  return `${base.replace(/\/+$/, "")}${endpoint}`;
}

async function callStep(
  step: string,
  url: string,
  body: Record<string, unknown>,
  orderId: string
): Promise<StepResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  try {
    await axios.post(url, body, {
      timeout: config.requestTimeoutMs,
      headers: {
        "x-order-id": orderId,
        "x-correlation-id": orderId,
      },
    });

    const finished = Date.now();

    currentTrace().push({
      step,
      status: "success",
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: Math.max(0, finished - started),
    });

    return { success: true, timedOut: false };
  } catch (error: unknown) {
    const finished = Date.now();
    const timedOut =
      axios.isAxiosError(error) &&
      (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT");

    let downstreamCode: string | undefined;

    if (axios.isAxiosError(error)) {
      const responseData = error.response?.data as
        | { code?: unknown }
        | undefined;

      if (typeof responseData?.code === "string") {
        downstreamCode = responseData.code;
      }
    }

    currentTrace().push({
      step,
      status: timedOut ? "timeout" : "failed",
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: Math.max(0, finished - started),
    });

    return {
      success: false,
      timedOut,
      code: timedOut ? "timeout" : downstreamCode || "service_error",
    };
  }
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.post("/checkout", (req: Request, res: Response) => {
  return traceStorage.run([], async () => {
  const idempotencyKey = req.header("Idempotency-Key");

  if (
    !idempotencyKey ||
    idempotencyKey.trim().length === 0 ||
    idempotencyKey.length > 255
  ) {
    res.status(400).json({
      code: "validation_error",
      message: "A valid Idempotency-Key header is required (1-255 characters).",
    });
    return;
  }

  if (!validateOrder(req.body)) {
    res.status(400).json({
      code: "validation_error",
      message: "The request body is not a valid canonical order.",
      errors: validateOrder.errors,
    });
    return;
  }

  const order = req.body;
  if (order.items.length > 100) {
    res.status(400).json({
      code: "validation_error",
      message: "An order may contain at most 100 items.",
    });
    return;
  }

  const requestHash = hashPayload(req.body);
  const idempotencyStore = readIdempotencyStore();
  const existing = idempotencyStore.records[idempotencyKey];

  if (existing) {
    if (existing.requestHash !== requestHash) {
      res.status(409).json({
        code: "idempotency_payload_mismatch",
        message: "This Idempotency-Key was already used with a different payload.",
      });
      return;
    }

    if (existing.state === "in_progress") {
      res.status(409).json({
        code: "idempotency_conflict",
        message: "A request with this Idempotency-Key is still in progress.",
      });
      return;
    }

    res.status(existing.httpStatus).json(existing.response);
    return;
  }

  const inProgressResponse: CheckoutResponse = {
    orderId: order.orderId,
    status: "in_progress",
    trace: [],
  };

  idempotencyStore.records[idempotencyKey] = {
    requestHash,
    state: "in_progress",
    httpStatus: 202,
    response: inProgressResponse,
    updatedAt: new Date().toISOString(),
  };

  // Persist before the first downstream call, so concurrent requests conflict.
  writeStore(IDEMPOTENCY_FILE, idempotencyStore);

  const amount = calculateAmount(order);
  let paymentAuthorized = false;
  let inventoryReserved = false;

  const payment = await callStep(
    "payment",
    serviceUrl(config.paymentUrl, "/payment/authorize"),
    { orderId: order.orderId, amount },
    order.orderId
  );

  if (payment.success) {
    paymentAuthorized = true;
  } else {
    await finishCheckout(
      order.orderId,
      idempotencyKey,
      payment.timedOut ? 504 : 422,
      "failed",
      payment.code || "payment_failed",
      res
    );
    return;
  }

  const inventory = await callStep(
    "inventory",
    serviceUrl(config.inventoryUrl, "/inventory/reserve"),
    { orderId: order.orderId, items: order.items },
    order.orderId
  );

  if (inventory.success) {
    inventoryReserved = true;
  } else {
    await compensateAndFinish(
      order.orderId,
      idempotencyKey,
      paymentAuthorized,
      inventoryReserved,
      inventory,
      res
    );
    return;
  }

  const shipping = await callStep(
    "shipping",
    serviceUrl(config.shippingUrl, "/shipping/create"),
    { orderId: order.orderId },
    order.orderId
  );

  if (!shipping.success) {
    await compensateAndFinish(
      order.orderId,
      idempotencyKey,
      paymentAuthorized,
      inventoryReserved,
      shipping,
      res
    );
    return;
  }

  const notification = await callStep(
    "notification",
    serviceUrl(config.notificationUrl, "/notification/send"),
    { orderId: order.orderId, recipient: order.customer.email },
    order.orderId
  );

  if (!notification.success) {
    await compensateAndFinish(
      order.orderId,
      idempotencyKey,
      paymentAuthorized,
      inventoryReserved,
      notification,
      res
    );
    return;
  }

  await finishCheckout(
    order.orderId,
    idempotencyKey,
    200,
    "completed",
    undefined,
    res
  );
  });
});

async function compensateAndFinish(
  orderId: string,
  idempotencyKey: string,
  paymentAuthorized: boolean,
  inventoryReserved: boolean,
  originalFailure: StepResult,
  res: Response
): Promise<void> {
  let compensationFailed = false;

  // Compensate in reverse order: inventory first, then payment.
  if (inventoryReserved) {
    const release = await callStep(
      "inventory_release",
      serviceUrl(config.inventoryUrl, "/inventory/release"),
      { orderId },
      orderId
    );

    if (!release.success) {
      compensationFailed = true;
    }
  }

  if (paymentAuthorized) {
    const refund = await callStep(
      "payment_refund",
      serviceUrl(config.paymentUrl, "/payment/refund"),
      { orderId },
      orderId
    );

    if (!refund.success) {
      compensationFailed = true;
    }
  }

  if (compensationFailed) {
    await finishCheckout(
      orderId,
      idempotencyKey,
      422,
      "failed",
      "compensation_failed",
      res
    );
    return;
  }

  const hasCompensation =
    inventoryReserved || paymentAuthorized;

  const status: CheckoutStatus = hasCompensation
    ? "compensated"
    : "failed";

  const httpStatus = originalFailure.timedOut ? 504 : 422;

  await finishCheckout(
    orderId,
    idempotencyKey,
    httpStatus,
    status,
    originalFailure.code || "service_error",
    res
  );
}

async function finishCheckout(
  orderId: string,
  idempotencyKey: string,
  httpStatus: number,
  status: CheckoutStatus,
  code: string | undefined,
  res: Response
): Promise<void> {
  const response: CheckoutResponse = {
    orderId,
    status,
    trace: [...currentTrace()],
  };

  if (code) {
    response.code = code;
  }

  const updatedAt = new Date().toISOString();

  const idempotencyStore = readIdempotencyStore();
  const currentRecord = idempotencyStore.records[idempotencyKey];

  if (!currentRecord) {
    throw new Error("Idempotency record disappeared during checkout.");
  }

  currentRecord.state = status;
  currentRecord.httpStatus = httpStatus;
  currentRecord.response = response;
  currentRecord.updatedAt = updatedAt;

  const sagaStore = readSagaStore();
  sagaStore.sagas[orderId] = {
    idempotencyKey,
    state: status === "in_progress" ? "failed" : status,
    steps: [...currentTrace()],
    updatedAt,
  };

  writeStore(SAGA_FILE, sagaStore);
  writeStore(IDEMPOTENCY_FILE, idempotencyStore);

  res.status(httpStatus).json(response);
}

app.listen(config.port, () => {
  console.log(`[orchestrator] listening on ${config.port}`);
});
