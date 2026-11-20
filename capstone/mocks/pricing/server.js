/**
 * Capstone kit — the pricing mock. Instructor-owned, replaced at grading
 * (PA8 spec §5.2).
 *
 * Lineage: PA4's mock-pricing. The catalogue, the API key and every PA4
 * endpoint are unchanged. New, for the intake tests: three switches in
 * POST /admin/config, and a request log.
 *
 *   delayMs     wait this long before answering any /pricing request
 *   outage      every /pricing request answers 500
 *   status401   every /pricing request answers 401, whatever key it sends
 *
 * An outage wins over status401, and both win over a per-product forceStatus.
 *
 * Endpoints. Everything except /health needs X-API-Key, as in PA4.
 *   GET  /health
 *   GET  /pricing                     the catalogue
 *   GET  /pricing/:productId          one product; unknown → 404
 *   PUT  /admin/pricing/:productId    as in PA4: override unitPrice/currency/
 *                                     taxRate/productName, or set forceStatus
 *   GET  /admin/config                the switches in force
 *   POST /admin/config                a partial update. Validated; all or nothing
 *   GET  /admin/logs                  every /pricing request, recorded when it
 *                                     is answered, with the status it got
 *   POST /admin/reset                 catalogue, forced statuses, logs and
 *                                     switches back to boot
 *
 * MOCK_CONFIG (env, optional): a POST /admin/config body applied at boot. The
 * result is the boot config that /admin/reset restores. Invalid → exit 1.
 *
 * A request still in flight when /admin/reset arrives is logged against the
 * state it started with, so it never shows up in the logs after the reset.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const HERE = fileURLToPath(new URL("./", import.meta.url));
const PORT = Number(process.env.PORT ?? 4100);
const API_KEY = process.env.PRICING_API_KEY ?? "pa4-pricing-key-2026";

const ORIGINAL_CATALOG = JSON.parse(
  readFileSync(path.join(HERE, "products.json"), "utf8"),
);

const DEFAULT_CONFIG = { delayMs: 0, outage: false, status401: false };

/** Applies a POST /admin/config body to `current`, without changing it. */
function applyConfig(current, input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { errors: ["the config must be a JSON object"] };
  }
  const next = { ...current };
  const errors = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === "delayMs") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) errors.push("delayMs: must be a number >= 0");
      else next.delayMs = Math.floor(value);
    } else if (key === "outage" || key === "status401") {
      if (typeof value !== "boolean") errors.push(`${key}: must be true or false`);
      else next[key] = value;
    } else {
      errors.push(`${key}: unknown key. Keys: delayMs, outage, status401`);
    }
  }
  return errors.length > 0 ? { errors } : { config: next };
}

function bootConfig() {
  const raw = process.env.MOCK_CONFIG;
  if (raw === undefined || raw.trim() === "") return { ...DEFAULT_CONFIG };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`MOCK_CONFIG is not valid JSON: ${err.message}`);
  }
  const result = applyConfig(DEFAULT_CONFIG, parsed);
  if (result.errors) throw new Error(`MOCK_CONFIG rejected:\n  ${result.errors.join("\n  ")}`);
  return result.config;
}

let BOOT_CONFIG;
try {
  BOOT_CONFIG = bootConfig();
} catch (err) {
  console.error(`[pricing] ${err.message}`);
  process.exit(1);
}

function newState() {
  return {
    catalog: new Map(ORIGINAL_CATALOG.map((p) => [p.productId, { ...p }])),
    /** @type {Map<string, number>} */
    forcedStatus: new Map(),
    config: { ...BOOT_CONFIG },
    logs: [],
    seq: 0,
  };
}
let state = newState();

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

const app = express();
app.use(express.json());

// No auth: used by `docker compose up -d --wait`'s healthcheck.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "pricing" });
});

function requireApiKey(req, res, next) {
  const key = req.header("X-API-Key");
  if (key !== API_KEY) {
    res.status(401).json({ error: "missing or invalid X-API-Key" });
    return;
  }
  next();
}

// Log every /pricing request when it is answered, then apply the switches.
app.use("/pricing", (req, res, next) => {
  const s = state;
  const receivedAt = new Date().toISOString();
  // Here req.path is relative to /pricing; by "finish" Express has restored it.
  const productId = req.path === "/" ? null : decodeURIComponent(req.path.slice(1));
  res.on("finish", () => {
    const respondedAt = new Date().toISOString();
    s.seq += 1;
    s.logs.push({
      seq: s.seq,
      at: respondedAt,
      receivedAt,
      respondedAt,
      productId,
      status: res.statusCode,
      apiKeyValid: req.header("X-API-Key") === API_KEY,
      correlationId: req.header("x-correlation-id") ?? null,
      causationId: req.header("x-causation-id") ?? null,
    });
  });
  next();
});

app.use("/pricing", (req, res, next) => {
  const { delayMs, outage, status401 } = state.config;
  sleep(delayMs).then(() => {
    if (outage) {
      res.status(500).json({ error: "simulated outage of the pricing API" });
    } else if (status401) {
      res.status(401).json({ error: "missing or invalid X-API-Key" });
    } else {
      next();
    }
  });
});

app.get("/pricing", requireApiKey, (_req, res) => {
  res.status(200).json([...state.catalog.values()]);
});

app.get("/pricing/:productId", requireApiKey, (req, res) => {
  const { productId } = req.params;

  const forced = state.forcedStatus.get(productId);
  if (forced !== undefined) {
    res.status(forced).json({ error: `simulated ${forced} from pricing API` });
    return;
  }

  const product = state.catalog.get(productId);
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
    state.forcedStatus.set(productId, body.forceStatus);
    res.status(200).json({ productId, forceStatus: body.forceStatus });
    return;
  }

  const existing = state.catalog.get(productId);
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
  state.catalog.set(productId, updated);
  state.forcedStatus.delete(productId);
  res.status(200).json(updated);
});

app.get("/admin/config", requireApiKey, (_req, res) => {
  res.status(200).json({ service: "pricing", config: state.config });
});

app.post("/admin/config", requireApiKey, (req, res) => {
  const result = applyConfig(state.config, req.body ?? {});
  if (result.errors) {
    res.status(400).json({ code: "invalid_config", errors: result.errors });
    return;
  }
  state.config = result.config;
  res.status(200).json({ status: "ok", config: state.config });
});

app.get("/admin/logs", requireApiKey, (_req, res) => {
  res.status(200).json({ service: "pricing", logs: state.logs });
});

app.post("/admin/reset", requireApiKey, (_req, res) => {
  state = newState();
  res.status(200).json({ status: "reset" });
});

app.listen(PORT, () => {
  console.log(`capstone mock-pricing listening on :${PORT}`);
});

// PID 1 in a container: without these, `docker stop` waits 10 s for SIGKILL.
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
