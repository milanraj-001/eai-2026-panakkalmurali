/**
 * The canonical order type, mirrored from ../../../canonical/order.schema.json
 * (owned by the course, not by this assignment — see PA4). The checkout
 * workflow receives exactly this shape: the api has already validated the
 * request against the JSON Schema itself (api/src/server.ts). This file is a
 * plain TypeScript mirror of it for editor/tsc support, not a second source
 * of truth. If the two ever disagree, the schema wins.
 *
 * There is no amount and no recipient in it. The workflow derives both:
 * the amount from items[].unitPrice × quantity, the recipient from
 * customer.email. See README.md §4.
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
