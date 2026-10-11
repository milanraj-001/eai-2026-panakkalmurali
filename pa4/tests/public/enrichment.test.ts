/**
 * PA4 public tests — enrichment must actually call the pricing API.
 *
 * We change PROD-001's price in the mock catalog at runtime (via
 * mock-pricing's admin endpoint — see ../_pricing-admin.ts) and check that
 * the translator's output changes with it. An implementation that hardcoded
 * "24.99" (or any other fixed number) instead of calling
 * GET /pricing/:productId will pass every other test in this suite and fail
 * only this one.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PRICING_BASE_URL,
  DEFAULT_WEB_ORDER_PATH,
  translateWeb,
} from "../../starter/src/transform";
import { overridePrice, resetPricingCatalog } from "./_pricing-admin";

const options = { pricingBaseUrl: DEFAULT_PRICING_BASE_URL };

afterEach(async () => {
  await resetPricingCatalog();
});

describe("prices come from the pricing API, not from the code", () => {
  it("reflects a price change made to the mock catalog at runtime", async () => {
    const before = await translateWeb(DEFAULT_WEB_ORDER_PATH, options);
    const beforeItem = before.order!.items.find((i) => i.productId === "PROD-001");
    expect(beforeItem, "PROD-001 missing from web order output").toBeDefined();

    const NEW_PRICE = 777.35;
    await overridePrice("PROD-001", NEW_PRICE);

    const after = await translateWeb(DEFAULT_WEB_ORDER_PATH, options);
    const afterItem = after.order!.items.find((i) => i.productId === "PROD-001");

    expect(afterItem!.unitPrice).toBe("777.35");
    expect(afterItem!.unitPrice).not.toBe(beforeItem!.unitPrice);
  });

  it("does not use the B2B fixture's decorative <UnitListPrice> (24,99 / 49,99) as the real price", async () => {
    // The mock catalog's real PROD-001/PROD-002 prices are deliberately
    // different from the legacy list prices embedded in b2b-order.xml, so a
    // translator that reads UnitListPrice instead of calling the API fails
    // this even before the price-change test above runs it into the ground.
    const { translateB2B, DEFAULT_B2B_ORDER_PATH } = await import("../../starter/src/transform");
    const result = await translateB2B(DEFAULT_B2B_ORDER_PATH, options);
    const prices = result.order!.items.map((i) => i.unitPrice);
    expect(prices).not.toContain("24.99");
    expect(prices).not.toContain("49.99");
  });

  it("formats a price with no natural second decimal correctly (4.5 -> \"4.50\")", async () => {
    await overridePrice("PROD-001", 4.5);
    const result = await translateWeb(DEFAULT_WEB_ORDER_PATH, options);
    const item = result.order!.items.find((i) => i.productId === "PROD-001");
    expect(item!.unitPrice).toBe("4.50");
  });
});
