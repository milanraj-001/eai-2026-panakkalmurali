/**
 * PA4 public tests — schema validity.
 *
 * These are the same tests I run when I grade, plus hidden ones you do not
 * see. Run them as often as you like: `docker compose up -d --wait && npm
 * test` (from pa4/starter).
 *
 * Every one of your three translators must produce output that validates
 * against ../../canonical/order.schema.json. That schema is fixed — see
 * ../../canonical/README.md.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_B2B_ORDER_PATH,
  DEFAULT_MOBILE_ORDER_PATH,
  DEFAULT_PRICING_BASE_URL,
  DEFAULT_WEB_ORDER_PATH,
  translateB2B,
  translateMobile,
  translateWeb,
  type TransformResult,
} from "../../starter/src/transform";

const PA4_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA_PATH = path.join(PA4_ROOT, "..", "canonical", "order.schema.json");

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const validate = ajv.compile(schema);

const options = { pricingBaseUrl: DEFAULT_PRICING_BASE_URL };

function expectValid(result: TransformResult, label: string): void {
  expect(result.order, `${label}: expected an order, got null. warnings: ${JSON.stringify(result.warnings)}`).not.toBeNull();
  const ok = validate(result.order);
  expect(ok, `${label} failed schema validation: ${ajv.errorsText(validate.errors)}`).toBe(true);
}

describe("canonical schema itself", () => {
  it("is present and is valid JSON Schema", () => {
    expect(() => ajv.compile(schema)).not.toThrow();
  });
});

describe("each source validates against the canonical schema", () => {
  it("web", async () => {
    expectValid(await translateWeb(DEFAULT_WEB_ORDER_PATH, options), "web");
  });

  it("mobile", async () => {
    expectValid(await translateMobile(DEFAULT_MOBILE_ORDER_PATH, options), "mobile");
  });

  it("b2b", async () => {
    expectValid(await translateB2B(DEFAULT_B2B_ORDER_PATH, options), "b2b");
  });
});
