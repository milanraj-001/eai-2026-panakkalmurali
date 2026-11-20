/**
 * The four provider mocks, as data for the engine. Routes, response ids,
 * failure codes and /admin/config aliases are PA6's. Payment and inventory
 * honour Idempotency-Key (authorize:/refund:, reserve:/release:). Shipping and
 * notification do not, by design (PA8 spec §4.5, §5.2).
 */
import type { OperationDef, ServiceDef } from "./engine.js";
import { type Body, isObject, nonEmptyString } from "./util.js";

const DECIMAL = /^[0-9]+\.[0-9]{2}$/;
const KINDS = ["order_confirmed", "order_not_completed"];

function requireOrderId(body: Body): string | null {
  return nonEmptyString(body.orderId) ? null : "orderId is required";
}

function amountOf(body: Body): Body {
  return { amount: typeof body.amount === "string" ? body.amount : null };
}

function kindOf(body: Body): string {
  return typeof body.kind === "string" ? body.kind : "order_confirmed";
}

const payment: ServiceDef = {
  name: "payment",
  defaultPort: 4001,
  operations: [
    {
      name: "authorize",
      path: "/payment/authorize",
      step: "payment",
      declineCode: "payment_declined",
      effect: "charge",
      resultId: ["authorizationId", "pay"],
      honoursIdempotencyKey: true,
      validate: (body) =>
        nonEmptyString(body.orderId) && typeof body.amount === "string" && DECIMAL.test(body.amount)
          ? null
          : 'orderId and amount are required; amount is a decimal string with two fraction digits, e.g. "49.50"',
      details: amountOf,
    },
    {
      name: "refund",
      path: "/payment/refund",
      step: "payment_refund",
      declineCode: "refund_failed",
      effect: "refund",
      resultId: ["refundId", "refund"],
      honoursIdempotencyKey: true,
      validate: requireOrderId,
      details: amountOf,
    },
  ],
  aliases: {
    paymentFailMode: { operation: "authorize", field: "failMode" },
    paymentRefundFailMode: { operation: "refund", field: "failMode" },
  },
};

const inventory: ServiceDef = {
  name: "inventory",
  defaultPort: 4002,
  operations: [
    {
      name: "reserve",
      path: "/inventory/reserve",
      step: "inventory",
      declineCode: "inventory_unavailable",
      effect: "reservation",
      resultId: ["reservationId", "inv"],
      honoursIdempotencyKey: true,
      validate: (body) =>
        nonEmptyString(body.orderId) && Array.isArray(body.items) ? null : "orderId and items[] are required",
      details: (body) => ({ items: Array.isArray(body.items) ? body.items : null }),
      productIds: (body) =>
        Array.isArray(body.items)
          ? body.items.flatMap((item: unknown) => (isObject(item) && nonEmptyString(item.productId) ? [item.productId] : []))
          : [],
    },
    {
      name: "release",
      path: "/inventory/release",
      step: "inventory_release",
      declineCode: "release_failed",
      effect: "release",
      resultId: ["releaseId", "rel"],
      honoursIdempotencyKey: true,
      validate: requireOrderId,
      details: () => ({}),
    },
  ],
  aliases: {
    inventoryFailMode: { operation: "reserve", field: "failMode" },
    inventoryReleaseFailMode: { operation: "release", field: "failMode" },
  },
};

const shipping: ServiceDef = {
  name: "shipping",
  defaultPort: 4003,
  operations: [
    {
      name: "create",
      path: "/shipping/create",
      step: "shipping",
      declineCode: "shipping_unavailable",
      effect: "shipment",
      resultId: ["shipmentId", "shp"],
      honoursIdempotencyKey: false,
      validate: requireOrderId,
      details: () => ({}),
    },
  ],
  aliases: {
    shippingFailMode: { operation: "create", field: "failMode" },
    shippingDelayMs: { operation: "create", field: "delayMs" },
  },
};

const notificationSend: OperationDef = {
  name: "send",
  path: "/notification/send",
  step: "notification",
  declineCode: "notification_failed",
  effect: "notice",
  resultId: ["notificationId", "ntf"],
  honoursIdempotencyKey: false,
  validate: (body) => {
    if (!nonEmptyString(body.orderId) || !nonEmptyString(body.recipient)) return "orderId and recipient are required";
    if (body.kind !== undefined && body.kind !== null && !KINDS.includes(body.kind as string)) {
      return `kind is optional; when present it is one of ${KINDS.join(", ")}`;
    }
    return null;
  },
  details: (body) => ({
    recipient: nonEmptyString(body.recipient) ? body.recipient : null,
    kind: kindOf(body),
    reason: typeof body.reason === "string" ? body.reason : null,
  }),
  kind: kindOf,
};

const notification: ServiceDef = {
  name: "notification",
  defaultPort: 4004,
  operations: [notificationSend],
  aliases: {
    notificationFailMode: { operation: "send", field: "failMode" },
  },
};

export const SERVICES: Record<string, ServiceDef> = { payment, inventory, shipping, notification };

/** The service MOCK_SERVICE names. Throws when it names none. */
export function serviceFromEnv(): ServiceDef {
  const name = process.env.MOCK_SERVICE ?? "";
  const service = SERVICES[name];
  if (!service) throw new Error(`MOCK_SERVICE must be one of ${Object.keys(SERVICES).join(", ")}; got "${name}"`);
  return service;
}

export function portFor(service: ServiceDef): number {
  return process.env.PORT ? Number(process.env.PORT) : service.defaultPort;
}
