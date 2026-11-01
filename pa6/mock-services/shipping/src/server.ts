/**
 * PA6 mock shipping service — ported from the practice-03-orchestration JS lab.
 * Behavior is unchanged: same routes, same fail-mode/delay semantics, same log shape.
 */
import express, { type Request, type Response } from "express";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4003);

type FailMode = "never" | "always" | "random";

interface LogEntry {
  seq: number;
  at: string;
  action: string;
  orderId: string | null;
  correlationId: string | null;
  outcome: string;
  delayMs: number;
}

interface Config {
  shippingFailMode: FailMode;
  shippingDelayMs: number;
}

let logs: LogEntry[] = [];
let sequence = 0;
const config: Config = {
  shippingFailMode: (process.env.SHIPPING_FAIL_MODE as FailMode | undefined) || "never",
  shippingDelayMs: Number(process.env.SHIPPING_DELAY_MS || 0),
};

function shouldFail(mode: FailMode): boolean {
  if (mode === "always") return true;
  if (mode === "random") return Math.random() < 0.5;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function record(action: string, req: Request, body: any, outcome: string): void {
  sequence += 1;
  logs.push({
    seq: sequence,
    at: new Date().toISOString(),
    action,
    orderId: body?.orderId || req.header("x-order-id") || null,
    correlationId: req.header("x-correlation-id") || null,
    outcome,
    delayMs: config.shippingDelayMs,
  });
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.post("/shipping/create", async (req: Request, res: Response) => {
  const { orderId } = req.body || {};
  if (!orderId) {
    record("create", req, req.body, "validation_error");
    res.status(400).json({ code: "validation_error", message: "orderId is required" });
    return;
  }

  if (config.shippingDelayMs > 0) {
    await sleep(config.shippingDelayMs);
  }

  if (shouldFail(config.shippingFailMode)) {
    record("create", req, req.body, "failed");
    res.status(422).json({
      ok: false,
      step: "shipping",
      code: "shipping_unavailable",
      orderId,
    });
    return;
  }

  record("create", req, req.body, "success");
  res.status(200).json({
    ok: true,
    step: "shipping",
    shipmentId: `shp-${orderId}`,
    orderId,
  });
});

app.get("/admin/logs", (_req: Request, res: Response) => {
  res.status(200).json({ service: "shipping", logs });
});

app.post("/admin/config", (req: Request, res: Response) => {
  const incoming = req.body || {};
  if (typeof incoming.shippingFailMode === "string") {
    config.shippingFailMode = incoming.shippingFailMode;
  }
  if (typeof incoming.shippingDelayMs === "number" && Number.isFinite(incoming.shippingDelayMs)) {
    config.shippingDelayMs = Math.max(0, Math.floor(incoming.shippingDelayMs));
  }
  res.status(200).json({ status: "ok", config });
});

app.post("/admin/reset", (_req: Request, res: Response) => {
  logs = [];
  sequence = 0;
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`[shipping] mock listening on ${PORT}`);
});
