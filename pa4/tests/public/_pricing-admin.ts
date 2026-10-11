/**
 * Shared helper for the public (and hidden) tests: talks to mock-pricing's
 * admin control plane so a test can change a product's price, or force an
 * error status, on the ALREADY-RUNNING container from `docker compose up`.
 *
 * Not a *.test.ts file itself, so vitest's glob does not pick it up as a
 * suite — it is imported by the files that are.
 */

import { DEFAULT_PRICING_API_KEY, DEFAULT_PRICING_BASE_URL } from "../../starter/src/transform";

export const PRICING_BASE_URL = process.env.PA4_PRICING_BASE_URL ?? DEFAULT_PRICING_BASE_URL;
export const PRICING_API_KEY = process.env.PA4_PRICING_API_KEY ?? DEFAULT_PRICING_API_KEY;

async function adminRequest(pathAndMethod: { method: string; path: string; body?: unknown }) {
  const res = await fetch(`${PRICING_BASE_URL}${pathAndMethod.path}`, {
    method: pathAndMethod.method,
    headers: {
      "X-API-Key": PRICING_API_KEY,
      "Content-Type": "application/json",
    },
    body: pathAndMethod.body === undefined ? undefined : JSON.stringify(pathAndMethod.body),
  });
  if (!res.ok) {
    throw new Error(
      `mock-pricing admin call failed: ${pathAndMethod.method} ${pathAndMethod.path} -> ${res.status}. ` +
        `Is docker compose up (pa4-mock-pricing on :4100)?`,
    );
  }
  return res.json();
}

export function overridePrice(productId: string, unitPrice: number): Promise<unknown> {
  return adminRequest({ method: "PUT", path: `/admin/pricing/${productId}`, body: { unitPrice } });
}

export function forceStatus(productId: string, httpStatus: number): Promise<unknown> {
  return adminRequest({
    method: "PUT",
    path: `/admin/pricing/${productId}`,
    body: { forceStatus: httpStatus },
  });
}

export function resetPricingCatalog(): Promise<unknown> {
  return adminRequest({ method: "POST", path: "/admin/reset" });
}
