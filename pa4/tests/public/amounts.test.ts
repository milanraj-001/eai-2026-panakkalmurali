/**
 * PA4 public tests — amounts are decimal strings, never numbers.
 *
 * The same rule PA1 established for `amount`. A later assignment's fault
 * catalogue plants exactly this bug ("flip a decimal string to a float"),
 * so the canonical schema fixes the type from the start:
 * canonical/order.schema.json declares unitPrice as a string matching
 * ^-?[0-9]+\.[0-9]{2}$, not `{"type": "number"}`.
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
const DECIMAL_STRING = /^-?\d+\.\d{2}$/;

describe("unitPrice is always a decimal string with two fraction digits", () => {
  it("web", async () => {
    const result = await translateWeb(DEFAULT_WEB_ORDER_PATH, options);
    for (const item of result.order!.items) {
      expect(typeof item.unitPrice).toBe("string");
      expect(item.unitPrice).toMatch(DECIMAL_STRING);
    }
  });

  it("mobile", async () => {
    const result = await translateMobile(DEFAULT_MOBILE_ORDER_PATH, options);
    for (const item of result.order!.items) {
      expect(typeof item.unitPrice).toBe("string");
      expect(item.unitPrice).toMatch(DECIMAL_STRING);
    }
  });

  it("b2b", async () => {
    const result = await translateB2B(DEFAULT_B2B_ORDER_PATH, options);
    for (const item of result.order!.items) {
      expect(typeof item.unitPrice).toBe("string");
      expect(item.unitPrice).toMatch(DECIMAL_STRING);
    }
  });
});
