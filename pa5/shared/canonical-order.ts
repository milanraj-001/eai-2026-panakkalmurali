/**
 * The canonical order type, mirrored from ../../canonical/order.schema.json
 * (owned by the course, not by this assignment — see WP-12 / PA4). PA5 does
 * not transform anything: it only ever consumes an order already in this
 * shape and republishes it unchanged, so this file is a plain TypeScript
 * mirror of the schema for editor/tsc support, not a second source of truth.
 * If the two ever disagree, the schema wins.
 *
 * additionalProperties is false on every object in the schema — do not add
 * a field here (e.g. a top-level `correlationId`) that is not in the JSON
 * Schema. correlationId travels in the AMQP `headers.correlationId`
 * property instead; see docs/adr-004.md for why.
 */

export interface CanonicalAddress {
  street: string;
  city: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2, e.g. "LV", "GB". */
  country: string;
}

export interface CanonicalCustomer {
  name: string;
  email: string;
  address: CanonicalAddress;
}

export interface CanonicalItem {
  /** Normalized to the pricing API's own format: ^PROD-[0-9]+$ */
  productId: string;
  productName: string;
  quantity: number;
  /** A decimal STRING with exactly two fraction digits, e.g. "24.99". Never a number. */
  unitPrice: string;
  currency: string;
  /** Fraction, e.g. 0.21 for 21%. */
  taxRate: number;
}

export type CanonicalOrderType = "standard" | "express" | "b2b";
export type CanonicalSource = "web" | "mobile" | "b2b";
export type CanonicalStatus = "new" | "processing" | "shipped" | "delivered";

export interface CanonicalOrder {
  orderId: string;
  orderType: CanonicalOrderType;
  source: CanonicalSource;
  receivedAt: string;
  orderDate: string;
  customer: CanonicalCustomer;
  items: CanonicalItem[];
  currency: string;
  status: CanonicalStatus;
}
