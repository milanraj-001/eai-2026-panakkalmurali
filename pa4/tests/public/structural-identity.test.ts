/**
 * PA4 public tests — the three fixtures encode THE SAME logical order:
 * same customer, same address, same two line items, same currency, same
 * status, same instant (the mobile fixture's epoch and the other two's
 * ISO-8601 timestamp are the same moment).
 *
 * That is deliberate: it lets us diff the three canonical outputs directly.
 * Whatever is left after removing the fields that legitimately differ by
 * source (orderId, orderType, source, receivedAt) must be identical. If it
 * is not, something is either mis-mapped or mis-normalized (e.g. the
 * mobile epoch decoded into the wrong instant, or a product id normalized
 * to the wrong PROD-XXX and priced differently).
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
  type CanonicalOrder,
} from "../../starter/src/transform";

const options = { pricingBaseUrl: DEFAULT_PRICING_BASE_URL };

// Fields that legitimately differ per source, by design of this course's
// fixtures — everything else must match exactly.
function withoutSourceSpecificFields(order: CanonicalOrder): Omit<CanonicalOrder, "orderId" | "orderType" | "source" | "receivedAt"> {
  const { orderId, orderType, source, receivedAt, ...rest } = order;
  return rest;
}

describe("all three sources describe the same logical order", () => {
  it("produces structurally identical output modulo orderId/orderType/source/receivedAt", async () => {
    const web = await translateWeb(DEFAULT_WEB_ORDER_PATH, options);
    const mobile = await translateMobile(DEFAULT_MOBILE_ORDER_PATH, options);
    const b2b = await translateB2B(DEFAULT_B2B_ORDER_PATH, options);

    expect(web.order, `web: ${JSON.stringify(web.warnings)}`).not.toBeNull();
    expect(mobile.order, `mobile: ${JSON.stringify(mobile.warnings)}`).not.toBeNull();
    expect(b2b.order, `b2b: ${JSON.stringify(b2b.warnings)}`).not.toBeNull();

    const webCore = withoutSourceSpecificFields(web.order!);
    const mobileCore = withoutSourceSpecificFields(mobile.order!);
    const b2bCore = withoutSourceSpecificFields(b2b.order!);

    expect(mobileCore).toEqual(webCore);
    expect(b2bCore).toEqual(webCore);
  });

  it("decodes the mobile epoch and the B2B/web ISO timestamps to the same instant", async () => {
    const web = await translateWeb(DEFAULT_WEB_ORDER_PATH, options);
    const mobile = await translateMobile(DEFAULT_MOBILE_ORDER_PATH, options);
    expect(new Date(mobile.order!.orderDate).getTime()).toBe(new Date(web.order!.orderDate).getTime());
  });

  it("normalizes every source's diacritics identically (B2B is CP1257-encoded, the others are UTF-8)", async () => {
    const web = await translateWeb(DEFAULT_WEB_ORDER_PATH, options);
    const b2b = await translateB2B(DEFAULT_B2B_ORDER_PATH, options);
    expect(b2b.order!.customer.name).toBe(web.order!.customer.name);
    expect(b2b.order!.customer.name).toBe("Anna Bērziņa");
    expect(b2b.order!.customer.address.city).toBe("Rīga");
    expect(JSON.stringify(b2b.order)).not.toContain("�"); // U+FFFD: wrong-encoding replacement char
  });
});
