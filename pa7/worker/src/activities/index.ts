/**
 * The six activities. Each makes one HTTP call to one mock service: the same
 * calls the PA6 orchestrator made in callStep(). What is new is the decision
 * each one makes when the call fails: may Temporal try it again?
 *
 *   - 2xx                      success: return.
 *   - 4xx                      the service said no, and it will say no again
 *                              (payment_declined, inventory_unavailable).
 *                              ApplicationFailure.nonRetryable, with the mock's
 *                              own `code` as the failure type.
 *   - 5xx, or no answer        temporary. ApplicationFailure.retryable, so the
 *                              retry policy on proxyActivities may try again.
 *   - answer takes too long    not handled here. Temporal fails the attempt
 *                              itself when startToCloseTimeout runs out, and
 *                              the workflow sees a TimeoutFailure.
 *
 * The signatures are fixed: the workflow calls these by name.
 */
import axios from "axios";
import { ApplicationFailure } from "@temporalio/activity";
import type { CanonicalItem } from "../types";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// docker-compose.yml sets these. Never hardcode a downstream URL.
const PAYMENT_URL = requiredEnv("PAYMENT_URL");
const INVENTORY_URL = requiredEnv("INVENTORY_URL");
const SHIPPING_URL = requiredEnv("SHIPPING_URL");
const NOTIFICATION_URL = requiredEnv("NOTIFICATION_URL");

/**
 * What the workflow sees when a downstream answer carries no `code`, or when
 * no answer arrives at all. PA6's callStep() used the same fallback.
 */
const FALLBACK_CODE = "service_error";

/**
 * A socket safety net only. It is deliberately longer than the workflow's
 * startToCloseTimeout (2500 ms), so it never decides the outcome: Temporal's
 * timeout does, and it is what produces the TimeoutFailure the workflow maps
 * to code "timeout". It just stops an abandoned attempt from holding a socket
 * open for ever.
 */
const SOCKET_SAFETY_NET_MS = 15_000;

function url(base: string, endpoint: string): string {
  return `${base.replace(/\/+$/, "")}${endpoint}`;
}

/** The mock's own `code` from the response body, when it sent one. */
function codeFrom(data: unknown): string {
  if (data && typeof data === "object" && "code" in data) {
    const code = (data as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return FALLBACK_CODE;
}

async function post(
  step: string,
  target: string,
  body: Record<string, unknown>,
  orderId: string,
): Promise<void> {
  let status: number;
  let data: unknown;

  try {
    // validateStatus lets every HTTP answer through, so that a 4xx and a 5xx
    // can be told apart below instead of both arriving as an exception.
    const response = await axios.post(target, body, {
      timeout: SOCKET_SAFETY_NET_MS,
      validateStatus: () => true,
      headers: { "x-order-id": orderId, "x-correlation-id": orderId },
    });
    status = response.status;
    data = response.data;
  } catch (error: unknown) {
    // Connection refused, reset, DNS failure: nothing is known about whether
    // the service did the work. Temporary, so retryable.
    const reason = error instanceof Error ? error.message : String(error);
    throw ApplicationFailure.retryable(`${step}: no answer from ${target} (${reason})`, FALLBACK_CODE);
  }

  if (status >= 200 && status < 300) return;

  const code = codeFrom(data);
  const message = `${step}: ${target} answered ${status} (${code})`;

  if (status >= 400 && status < 500) {
    // A business refusal. It will refuse again, so do not retry it.
    throw ApplicationFailure.nonRetryable(message, code);
  }

  // 5xx, or anything else unexpected: treat as temporary.
  throw ApplicationFailure.retryable(message, code);
}

/** POST {PAYMENT_URL}/payment/authorize with { orderId, amount }. */
export async function authorizePayment(orderId: string, amount: string): Promise<void> {
  await post("authorizePayment", url(PAYMENT_URL, "/payment/authorize"), { orderId, amount }, orderId);
}

/** POST {INVENTORY_URL}/inventory/reserve with { orderId, items }. */
export async function reserveInventory(orderId: string, items: CanonicalItem[]): Promise<void> {
  await post("reserveInventory", url(INVENTORY_URL, "/inventory/reserve"), { orderId, items }, orderId);
}

/** POST {SHIPPING_URL}/shipping/create with { orderId }. */
export async function createShipment(orderId: string): Promise<void> {
  await post("createShipment", url(SHIPPING_URL, "/shipping/create"), { orderId }, orderId);
}

/** POST {NOTIFICATION_URL}/notification/send with { orderId, recipient }. */
export async function sendNotification(orderId: string, recipient: string): Promise<void> {
  await post("sendNotification", url(NOTIFICATION_URL, "/notification/send"), { orderId, recipient }, orderId);
}

/** Compensates authorizePayment: POST {PAYMENT_URL}/payment/refund with { orderId }. */
export async function refundPayment(orderId: string): Promise<void> {
  await post("refundPayment", url(PAYMENT_URL, "/payment/refund"), { orderId }, orderId);
}

/** Compensates reserveInventory: POST {INVENTORY_URL}/inventory/release with { orderId }. */
export async function releaseInventory(orderId: string): Promise<void> {
  await post("releaseInventory", url(INVENTORY_URL, "/inventory/release"), { orderId }, orderId);
}
