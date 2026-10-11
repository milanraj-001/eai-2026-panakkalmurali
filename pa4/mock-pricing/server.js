/**
 * PA4 — mock pricing API. GIVEN, not a TODO.
 *
 * Students call this over HTTP; they do not read or modify this file to pass
 * the assignment. It exists so that "call the pricing service and use its
 * answer" (content enricher pattern) is something students actually have to
 * do, rather than something they can fake by copying a number they saw once.
 *
 * Endpoints:
 *   GET  /health                        no auth. For docker compose --wait.
 *   GET  /pricing                       full catalog. requires X-API-Key.
 *   GET  /pricing/:productId            single product. requires X-API-Key.
 *   PUT  /admin/pricing/:productId      override a product for THIS test run.
 *                                       requires X-API-Key. Grading/public-test
 *                                       use only — see README. Body may set
 *                                       any of unitPrice/currency/taxRate/
 *                                       productName, and/or "forceStatus" to
 *                                       make subsequent GETs on this id return
 *                                       that HTTP status (e.g. 500) instead of
 *                                       the normal response — this is how the
 *                                       test suite simulates a pricing outage
 *                                       without a second container.
 *   POST /admin/reset                   restore the original catalog and
 *                                       clear every forced status. requires
 *                                       X-API-Key. Call this in afterEach/
 *                                       afterAll so tests do not leak state
 *                                       into one another.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const HERE = fileURLToPath(new URL("./", import.meta.url));
const PORT = process.env.PORT ?? 3000;
const API_KEY = process.env.PRICING_API_KEY ?? "pa4-pricing-key-2026";

const ORIGINAL_CATALOG = JSON.parse(
  readFileSync(path.join(HERE, "products.json"), "utf8"),
);

/** @type {Map<string, any>} */
let catalog = new Map();
/** @type {Map<string, number>} */
let forcedStatus = new Map();

function resetCatalog() {
  catalog = new Map(ORIGINAL_CATALOG.map((p) => [p.productId, { ...p }]));
  forcedStatus = new Map();
}
resetCatalog();

const app = express();
app.use(express.json());

// No auth: used by `docker compose up -d --wait`'s healthcheck.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

function requireApiKey(req, res, next) {
  const key = req.header("X-API-Key");
  if (key !== API_KEY) {
    res.status(401).json({ error: "missing or invalid X-API-Key" });
    return;
  }
  next();
}

app.get("/pricing", requireApiKey, (_req, res) => {
  res.status(200).json([...catalog.values()]);
});

app.get("/pricing/:productId", requireApiKey, (req, res) => {
  const { productId } = req.params;

  const forced = forcedStatus.get(productId);
  if (forced !== undefined) {
    res.status(forced).json({ error: `simulated ${forced} from pricing API` });
    return;
  }

  const product = catalog.get(productId);
  if (!product) {
    res.status(404).json({ error: `unknown productId: ${productId}` });
    return;
  }

  res.status(200).json(product);
});

// ---- admin: test/grading control plane. Not part of the student-facing API. ----

app.put("/admin/pricing/:productId", requireApiKey, (req, res) => {
  const { productId } = req.params;
  const body = req.body ?? {};

  if (typeof body.forceStatus === "number") {
    forcedStatus.set(productId, body.forceStatus);
    res.status(200).json({ productId, forceStatus: body.forceStatus });
    return;
  }

  const existing = catalog.get(productId);
  if (!existing) {
    res.status(404).json({ error: `unknown productId: ${productId}` });
    return;
  }

  const updated = {
    ...existing,
    ...("unitPrice" in body ? { unitPrice: body.unitPrice } : {}),
    ...("currency" in body ? { currency: body.currency } : {}),
    ...("taxRate" in body ? { taxRate: body.taxRate } : {}),
    ...("productName" in body ? { productName: body.productName } : {}),
  };
  catalog.set(productId, updated);
  forcedStatus.delete(productId);
  res.status(200).json(updated);
});

app.post("/admin/reset", requireApiKey, (_req, res) => {
  resetCatalog();
  res.status(200).json({ status: "reset" });
});

app.listen(PORT, () => {
  console.log(`pa4 mock-pricing listening on :${PORT}`);
});
