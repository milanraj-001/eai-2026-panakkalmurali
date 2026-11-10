/**
 * Shapes shared by the workflow, the activities and (by copy) the api. GIVEN —
 * do not change them: the api maps a CheckoutResult to an HTTP response, and
 * the tests validate that response against grading/schema/.
 *
 * Only types and constants live here. The workflow imports this file, and
 * workflow code runs in Temporal's sandbox, which refuses Node modules.
 */
import type { CanonicalItem, CanonicalOrder } from "./canonical-order";

export type { CanonicalItem, CanonicalOrder };

/** The task queue the api starts workflows on and this worker polls. */
export const TASK_QUEUE = "checkout";

/** One recorded step of the saga, compensations included. Same as PA6. */
export interface TraceItem {
  /** payment, inventory, shipping, notification, inventory_release or payment_refund */
  step: string;
  /** success, failed or timeout */
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export type SagaStatus = "completed" | "failed" | "compensated";

/**
 * What the checkout workflow returns, for every business outcome — success
 * and failure alike. The api turns it into the HTTP response: completed →
 * 200, code "timeout" → 504, anything else → 422. Same table as PA6.
 */
export interface CheckoutResult {
  orderId: string;
  status: SagaStatus;
  /** Present on every outcome except completed. */
  code?: string;
  trace: TraceItem[];
}
