/**
 * PA4 public tests — the content filter.
 *
 * All three sources carry payment details (see data/*.json and
 * data/b2b-order.xml). The canonical schema has no field for any of it
 * (canonical/order.schema.json sets additionalProperties: false throughout,
 * which already rules out a stray "payment" key structurally — schema.test.ts
 * covers that). This file additionally checks that none of the actual
 * SENSITIVE VALUES leak through in some other field (e.g. concatenated into
 * a name or a note), which schema validation alone would not catch.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_B2B_ORDER_PATH,
  DEFAULT_MOBILE_ORDER_PATH,
  DEFAULT_PRICING_BASE_URL,
  DEFAULT_WEB_ORDER_PATH,
  translateB2B,
  translateMobile,
  translateWeb,
} from "../../starter/src/transform";

const options = { pricingBaseUrl: DEFAULT_PRICING_BASE_URL };

// The raw, fake-but-card/IBAN-shaped values planted in data/*. None of these
// literal strings, nor the generic words describing them, may appear
// anywhere in canonical output.
const FORBIDDEN_VALUES = [
  "4111111111111111", // web + mobile: card number ("pan")
  "1227", // web + mobile: card expiry
  "GB29NWBK60161331926819", // b2b: IBAN
  "NWBKGB2L", // b2b: BIC
];
const FORBIDDEN_KEY_FRAGMENTS = ["payment", "card", "iban", "bic", "pan", "cvv"];

function assertNoPaymentData(order: unknown, label: string): void {
  const json = JSON.stringify(order);
  for (const value of FORBIDDEN_VALUES) {
    expect(json, `${label}: found raw payment value "${value}" in canonical output`).not.toContain(value);
  }
  const lower = json.toLowerCase();
  for (const fragment of FORBIDDEN_KEY_FRAGMENTS) {
    expect(lower, `${label}: found forbidden fragment "${fragment}" in canonical output`).not.toContain(fragment);
  }
}

describe("payment details never reach the canonical output", () => {
  it("web", async () => {
    const result = await translateWeb(DEFAULT_WEB_ORDER_PATH, options);
    assertNoPaymentData(result.order, "web");
  });

  it("mobile", async () => {
    const result = await translateMobile(DEFAULT_MOBILE_ORDER_PATH, options);
    assertNoPaymentData(result.order, "mobile");
  });

  it("b2b", async () => {
    const result = await translateB2B(DEFAULT_B2B_ORDER_PATH, options);
    assertNoPaymentData(result.order, "b2b");
  });
});
