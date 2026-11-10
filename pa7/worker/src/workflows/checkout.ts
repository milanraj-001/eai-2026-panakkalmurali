/**
 * The checkout workflow: the PA6 saga, ported. Same four steps, same
 * reverse-order compensation, same outcomes. What is gone is everything PA6
 * built around the saga: the per-call timeout, the retry loop, the
 * in-progress record and the "where was I?" state. Temporal keeps every
 * step's result in the workflow's history.
 *
 * Workflow code runs in Temporal's deterministic sandbox and is replayed from
 * that history whenever a worker rebuilds the workflow. So:
 *   - no I/O here: every call to the outside world is an activity, via `act`;
 *   - only types are imported from ../activities;
 *   - new Date() is safe: inside a workflow it is the workflow's own time.
 */
import {
  proxyActivities,
  ActivityFailure,
  ApplicationFailure,
  TimeoutFailure,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import type { CanonicalItem, CanonicalOrder, CheckoutResult, TraceItem } from "../types";

// Three attempts, 200 ms then 400 ms apart, each cut off at 2.5 s: a call that
// keeps timing out fails the step after about 8 s. Without maximumAttempts,
// Temporal would retry a failing activity for ever.
const act = proxyActivities<typeof activities>({
  startToCloseTimeout: "2500 ms",
  retry: {
    maximumAttempts: 3,
    initialInterval: "200 ms",
    backoffCoefficient: 2,
  },
});

/** Used when a failure carries no usable code. Same fallback as PA6. */
const FALLBACK_CODE = "service_error";

interface StepFailure {
  status: "failed" | "timeout";
  code: string;
}

/**
 * The order total as a decimal string with two fraction digits ("63.90"),
 * summed in whole cents as integers, never as floats. Ported from PA6's
 * calculateAmount().
 */
function calculateAmount(items: CanonicalItem[]): string {
  let totalCents = 0n;

  for (const item of items) {
    const match = /^(-?)(\d+)\.(\d{2})$/.exec(item.unitPrice);
    if (!match) {
      throw ApplicationFailure.nonRetryable(`Invalid unit price: ${item.unitPrice}`, "invalid_unit_price");
    }
    const sign = match[1] === "-" ? -1n : 1n;
    const itemCents = sign * (BigInt(match[2]!) * 100n + BigInt(match[3]!));
    totalCents += itemCents * BigInt(item.quantity);
  }

  const sign = totalCents < 0n ? "-" : "";
  const absolute = totalCents < 0n ? -totalCents : totalCents;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

/** Why a step failed for good. The cause of an ActivityFailure says which way. */
function classify(error: unknown): StepFailure {
  if (error instanceof ActivityFailure) {
    if (error.cause instanceof TimeoutFailure) {
      return { status: "timeout", code: "timeout" };
    }
    if (error.cause instanceof ApplicationFailure) {
      return { status: "failed", code: error.cause.type || FALLBACK_CODE };
    }
  }
  return { status: "failed", code: FALLBACK_CODE };
}

/**
 * Runs one step and records exactly one trace entry for it, however many
 * attempts it took. Returns null on success, the failure otherwise.
 */
async function runStep(
  trace: TraceItem[],
  step: string,
  call: () => Promise<void>,
): Promise<StepFailure | null> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  let failure: StepFailure | null = null;
  try {
    await call();
  } catch (error: unknown) {
    failure = classify(error);
  }

  const finished = Date.now();
  trace.push({
    step,
    status: failure ? failure.status : "success",
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: Math.max(0, finished - started),
  });
  return failure;
}

function result(
  orderId: string,
  status: CheckoutResult["status"],
  trace: TraceItem[],
  code?: string,
): CheckoutResult {
  return code === undefined ? { orderId, status, trace } : { orderId, status, code, trace };
}

export async function checkout(order: CanonicalOrder): Promise<CheckoutResult> {
  const { orderId } = order;
  const trace: TraceItem[] = [];

  // 1) payment. Nothing has happened yet, so a failure here undoes nothing.
  const payment = await runStep(trace, "payment", () =>
    act.authorizePayment(orderId, calculateAmount(order.items)),
  );
  if (payment) return result(orderId, "failed", trace, payment.code);

  // 2) inventory. Only payment has completed.
  const inventory = await runStep(trace, "inventory", () => act.reserveInventory(orderId, order.items));
  if (inventory) return compensate(orderId, trace, { inventoryReserved: false }, inventory);

  // 3) shipping. Payment and inventory have completed.
  const shipping = await runStep(trace, "shipping", () => act.createShipment(orderId));
  if (shipping) return compensate(orderId, trace, { inventoryReserved: true }, shipping);

  // 4) notification. Shipping cannot be undone, so it is not compensated.
  const notification = await runStep(trace, "notification", () =>
    act.sendNotification(orderId, order.customer.email),
  );
  if (notification) return compensate(orderId, trace, { inventoryReserved: true }, notification);

  return result(orderId, "completed", trace);
}

/**
 * Undo what completed, newest first: release inventory, then refund payment.
 * Payment always completed by the time this runs. Shipping and notification
 * have no undo. A failed compensation does not stop the next one, as in PA6:
 * the order ends "failed" with code compensation_failed.
 */
async function compensate(
  orderId: string,
  trace: TraceItem[],
  done: { inventoryReserved: boolean },
  cause: StepFailure,
): Promise<CheckoutResult> {
  let compensationFailed = false;

  if (done.inventoryReserved) {
    const release = await runStep(trace, "inventory_release", () => act.releaseInventory(orderId));
    if (release) compensationFailed = true;
  }

  const refund = await runStep(trace, "payment_refund", () => act.refundPayment(orderId));
  if (refund) compensationFailed = true;

  if (compensationFailed) return result(orderId, "failed", trace, "compensation_failed");
  return result(orderId, "compensated", trace, cause.code);
}
