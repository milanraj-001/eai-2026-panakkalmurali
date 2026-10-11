/**
 * PA4 — three sources to one canonical order model.
 *
 * Three systems you do not control each send you an order in their own
 * shape:
 *
 *   data/web-order.json      nested JSON, web store
 *   data/mobile-order.json   flat JSON, abbreviated field names, mobile app
 *   data/b2b-order.xml       EDI-style XML, CP1257 ("windows-1257"), B2B partner
 *
 * Your job is the message translator, content enricher and content filter
 * patterns from this week's session, applied together:
 *
 *   1. Translator  — map each source's shape onto ../../canonical/order.schema.json.
 *      That schema is fixed. You conform to it; you do not adjust it.
 *   2. Enricher    — the sources do not carry a trustworthy price. Normalize
 *      each line item's product id to the pricing API's PROD-XXX format, call
 *      the API, and use ITS price, currency and tax rate. A price you typed
 *      into this file yourself is a hardcoded price, and a public test
 *      changes a price in the mock catalog specifically to catch that.
 *   3. Filter      — all three sources carry payment details (a card number,
 *      or an IBAN). The canonical schema has no field for any of it.
 *      Whatever you do with it, it must not reach the object you return.
 *
 * Everything you need to call the pricing API is in the Node standard
 * library (global fetch). The one dependency here, fast-xml-parser, exists
 * because hand-rolling an XML tokenizer is not this week's lesson — reading
 * the object it gives you back correctly is.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------- contract --

export interface Address {
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface CanonicalCustomer {
  name: string;
  email: string;
  address: Address;
}

export interface CanonicalItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  currency: string;
  taxRate: number;
}

export type OrderStatus = "new" | "processing" | "shipped" | "delivered";

export interface CanonicalOrder {
  orderId: string;
  orderType: "standard" | "express" | "b2b";
  source: "web" | "mobile" | "b2b";
  receivedAt: string;
  orderDate: string;
  customer: CanonicalCustomer;
  items: CanonicalItem[];
  currency: string;
  status: OrderStatus;
}

export type TransformWarningCode = "UNKNOWN_PRODUCT" | "PRICING_API_ERROR";

export interface TransformWarning {
  code: TransformWarningCode;
  productId: string;
  message: string;
}

export interface TransformResult {
  order: CanonicalOrder | null;
  warnings: TransformWarning[];
}

export interface TranslateOptions {
  pricingBaseUrl: string;
  apiKey?: string;
  now?: () => Date;
}

export const DEFAULT_PRICING_API_KEY = "pa4-pricing-key-2026";

// ------------------------------------------------------------------- paths --

const PA4_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const DEFAULT_WEB_ORDER_PATH = path.join(PA4_ROOT, "data", "web-order.json");
export const DEFAULT_MOBILE_ORDER_PATH = path.join(PA4_ROOT, "data", "mobile-order.json");
export const DEFAULT_B2B_ORDER_PATH = path.join(PA4_ROOT, "data", "b2b-order.xml");
export const DEFAULT_PRICING_BASE_URL = "http://localhost:4100";

const OUT_DIR = path.join(PA4_ROOT, "out");

// ------------------------------------------------------------- raw shapes --

export interface WebOrderInput {
  orderId: string;
  orderType: string;
  customer: {
    name: string;
    email: string;
    address: Address;
    payment: {
      method: string;
      cardHolder: string;
      cardNumber: string;
      expiryMonth: number;
      expiryYear: number;
    };
  };
  items: Array<{ productId: string; productName: string; quantity: number }>;
  orderDate: string;
  status: string;
  currency: string;
}

export interface MobileOrderInput {
  oid: string;
  ot: string;
  cust_name: string;
  cust_email: string;
  addr: string;
  items: Array<{ pid: string; pname: string; qty: number }>;
  ts: number;
  st: number;
  cur: number;
  pm: string;
  pan: string;
  pexp: string;
}

export interface ParsedB2BOrder {
  PurchaseOrder: {
    "@_orderId": string;
    "@_orderType": string;
    "@_orderDate": string;
    BuyerParty: {
      Name: string;
      ContactEmail: string;
      ShipToAddress: {
        "@_country": string;
        Street: string;
        City: string;
        PostalCode: string;
      };
      [key: string]: unknown;
    };
    LineItems: {
      "@_currency": string;
      LineItem: unknown;
    };
    Status: string;
    [key: string]: unknown;
  };
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

// ------------------------------------------------------------------ helpers --

export function normalizeProductId(source: "web" | "mobile" | "b2b", rawId: string): string {
  if (source === "web") {
    return rawId;
  }
  if (source === "mobile") {
    return `PROD-${rawId}`;
  }
  // b2b: "SKU-PROD-001" -> "PROD-001"
  return rawId.replace(/^SKU-/, "");
}

export function toDecimalAmount(price: number): string {
  return price.toFixed(2);
}

export type EnrichResult =
  | { status: "ok"; unitPrice: string; currency: string; taxRate: number; productName: string }
  | { status: "unknown_product" }
  | { status: "error"; httpStatus: number };

export async function enrichFromPricing(
  productId: string,
  options: TranslateOptions,
): Promise<EnrichResult> {
  const apiKey = options.apiKey ?? DEFAULT_PRICING_API_KEY;

  let response: Response;
  try {
    response = await fetch(`${options.pricingBaseUrl}/pricing/${productId}`, {
      headers: { "X-API-Key": apiKey },
    });
  } catch {
    return { status: "error", httpStatus: 0 };
  }

  if (response.status === 404) {
    return { status: "unknown_product" };
  }

  if (!response.ok) {
    return { status: "error", httpStatus: response.status };
  }

  const body = (await response.json()) as {
    unitPrice: number;
    currency: string;
    taxRate: number;
    productName: string;
  };

  return {
    status: "ok",
    unitPrice: toDecimalAmount(body.unitPrice),
    currency: body.currency,
    taxRate: body.taxRate,
    productName: body.productName,
  };
}

export async function enrichItems(
  lines: Array<{ productId: string; productName: string; quantity: number }>,
  options: TranslateOptions,
): Promise<{ items: CanonicalItem[]; warnings: TransformWarning[] }> {
  const items: CanonicalItem[] = [];
  const warnings: TransformWarning[] = [];

  for (const line of lines) {
    const result = await enrichFromPricing(line.productId, options);

    if (result.status === "ok") {
      items.push({
        productId: line.productId,
        productName: line.productName,
        quantity: line.quantity,
        unitPrice: result.unitPrice,
        currency: result.currency,
        taxRate: result.taxRate,
      });
    } else if (result.status === "unknown_product") {
      warnings.push({
        code: "UNKNOWN_PRODUCT",
        productId: line.productId,
        message: `Product ${line.productId} was not found in the pricing catalog`,
      });
    } else {
      warnings.push({
        code: "PRICING_API_ERROR",
        productId: line.productId,
        message: `Pricing API returned status ${result.httpStatus} for product ${line.productId}`,
      });
    }
  }

  return { items, warnings };
}

export function epochSecondsToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

export function mapCurrencyCode(numericCode: number): string {
  switch (numericCode) {
    case 978:
      return "EUR";
    case 840:
      return "USD";
    case 826:
      return "GBP";
    default:
      // Tolerant reader: an unrecognized ISO 4217 numeric code is passed
      // through as a string rather than thrown, so one unexpected currency
      // does not take down the whole order. See ADR for the reasoning.
      return String(numericCode);
  }
}

export function mapMobileStatus(code: number): OrderStatus {
  switch (code) {
    case 1:
      return "new";
    case 2:
      return "processing";
    case 3:
      return "shipped";
    case 4:
      return "delivered";
    default:
      throw new Error(`Unrecognized mobile status code: ${code}`);
  }
}

export function mapB2BStatus(raw: string): OrderStatus {
  const normalized = raw.trim().toLowerCase();
  const valid: OrderStatus[] = ["new", "processing", "shipped", "delivered"];
  if ((valid as string[]).includes(normalized)) {
    return normalized as OrderStatus;
  }
  throw new Error(`Unrecognized B2B status: ${raw}`);
}

export function parseMobileAddress(addr: string): Address {
  const parts = addr.split(", ");
  return {
    street: parts[0]!,
    city: parts[1]!,
    postalCode: parts[2]!,
    country: parts[3]!,
  };
}

export function decodeB2BXmlBytes(bytes: Buffer): string {
  return new TextDecoder("windows-1257").decode(bytes);
}

// -------------------------------------------------------------- translators --

export async function translateWeb(
  webOrderPath: string,
  options: TranslateOptions,
): Promise<TransformResult> {
  const raw = readFileSync(webOrderPath, "utf8");
  const input = JSON.parse(raw) as WebOrderInput;

  const lines = input.items.map((item) => ({
    productId: normalizeProductId("web", item.productId),
    productName: item.productName,
    quantity: item.quantity,
  }));

  const { items, warnings } = await enrichItems(lines, options);

  if (items.length === 0) {
    return { order: null, warnings };
  }

  const order: CanonicalOrder = {
    orderId: input.orderId,
    orderType: input.orderType as CanonicalOrder["orderType"],
    source: "web",
    receivedAt: (options.now?.() ?? new Date()).toISOString(),
    orderDate: new Date(input.orderDate).toISOString(),
    customer: {
      name: input.customer.name,
      email: input.customer.email,
      address: input.customer.address,
    },
    items,
    currency: input.currency,
    status: input.status as OrderStatus,
  };

  return { order, warnings };
}

export async function translateMobile(
  mobileOrderPath: string,
  options: TranslateOptions,
): Promise<TransformResult> {
  const raw = readFileSync(mobileOrderPath, "utf8");
  const input = JSON.parse(raw) as MobileOrderInput;

  const lines = input.items.map((item) => ({
    productId: normalizeProductId("mobile", item.pid),
    productName: item.pname,
    quantity: item.qty,
  }));

  const { items, warnings } = await enrichItems(lines, options);

  if (items.length === 0) {
    return { order: null, warnings };
  }

  const order: CanonicalOrder = {
    orderId: input.oid,
    orderType: input.ot as CanonicalOrder["orderType"],
    source: "mobile",
    receivedAt: (options.now?.() ?? new Date()).toISOString(),
    orderDate: epochSecondsToIso(input.ts),
    customer: {
      name: input.cust_name,
      email: input.cust_email,
      address: parseMobileAddress(input.addr),
    },
    items,
    currency: mapCurrencyCode(input.cur),
    status: mapMobileStatus(input.st),
  };

  return { order, warnings };
}

export async function translateB2B(
  b2bOrderPath: string,
  options: TranslateOptions,
): Promise<TransformResult> {
  const bytes = readFileSync(b2bOrderPath);
  const text = decodeB2BXmlBytes(bytes);
  const parsed = xmlParser.parse(text) as ParsedB2BOrder;
  const po = parsed.PurchaseOrder;

  const rawLineItems = po.LineItems.LineItem;
  const lineItemArray = Array.isArray(rawLineItems) ? rawLineItems : [rawLineItems];

  const lines = (lineItemArray as Array<Record<string, unknown>>).map((li) => {
    const sku = String(li["@_sku"]);
    const quantity = parseInt(String(li["@_quantity"]), 10);
    const productName = String(li.Description);
    return {
      productId: normalizeProductId("b2b", sku),
      productName,
      quantity,
    };
  });

  const { items, warnings } = await enrichItems(lines, options);

  if (items.length === 0) {
    return { order: null, warnings };
  }

  const order: CanonicalOrder = {
    orderId: po["@_orderId"],
    orderType: po["@_orderType"] as CanonicalOrder["orderType"],
    source: "b2b",
    receivedAt: (options.now?.() ?? new Date()).toISOString(),
    orderDate: new Date(po["@_orderDate"]).toISOString(),
    customer: {
      name: po.BuyerParty.Name,
      email: po.BuyerParty.ContactEmail,
      address: {
        street: po.BuyerParty.ShipToAddress.Street,
        city: po.BuyerParty.ShipToAddress.City,
        postalCode: po.BuyerParty.ShipToAddress.PostalCode,
        country: po.BuyerParty.ShipToAddress["@_country"],
      },
    },
    items,
    currency: po.LineItems["@_currency"],
    status: mapB2BStatus(po.Status),
  };

  return { order, warnings };
}

// -------------------------------------------------------------------- main --

export async function main(): Promise<void> {
  const options: TranslateOptions = { pricingBaseUrl: DEFAULT_PRICING_BASE_URL };

  const results = {
    web: await translateWeb(DEFAULT_WEB_ORDER_PATH, options),
    mobile: await translateMobile(DEFAULT_MOBILE_ORDER_PATH, options),
    b2b: await translateB2B(DEFAULT_B2B_ORDER_PATH, options),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, result] of Object.entries(results)) {
    const outPath = path.join(OUT_DIR, `${name}.json`);
    writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");
    console.log(`wrote ${outPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}