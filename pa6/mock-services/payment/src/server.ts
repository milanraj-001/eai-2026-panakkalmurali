/**
 * PA6 mock payment service — ported from the practice-03-orchestration JS lab.
 * Same routes and fail-mode semantics. One change for 2026: `amount` is a
 * decimal string with two fraction digits ("49.50"), never a JSON number, as
 * everywhere else in this course, and each log entry records the amount it
 * received.
 */
import express, { type Request, type Response } from "express";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4001);

type FailMode = "never" | "always" | "random";

interface LogEntry {
  seq: number;
  at: string;
  action: string;
  orderId: string | null;
  correlationId: string | null;
  outcome: string;
  amount: string | null;
}

interface Config {
  paymentFailMode: FailMode;
  paymentRefundFailMode: FailMode;
}

let logs: LogEntry[] = [];
let sequence = 0;
const config: Config = {
  paymentFailMode: (process.env.PAYMENT_FAIL_MODE as FailMode | undefined) || "never",
  paymentRefundFailMode: (process.env.PAYMENT_REFUND_FAIL_MODE as FailMode | undefined) || "never",
};

function shouldFail(mode: FailMode): boolean {
  if (mode === "always") return true;
  if (mode === "random") return Math.random() < 0.5;
  return false;
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
    amount: typeof body?.amount === "string" ? body.amount : null,
  });
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.post("/payment/authorize", (req: Request, res: Response) => {
  const { orderId, amount } = req.body || {};
  if (!orderId || typeof amount !== "string" || !/^[0-9]+\.[0-9]{2}$/.test(amount)) {
    record("authorize", req, req.body, "validation_error");
    res.status(400).json({
      code: "validation_error",
      message: 'orderId and amount are required; amount is a decimal string with two fraction digits, e.g. "49.50"',
    });
    return;
  }

  if (shouldFail(config.paymentFailMode)) {
    record("authorize", req, req.body, "failed");
    res.status(422).json({
      ok: false,
      step: "payment",
      code: "payment_declined",
      orderId,
    });
    return;
  }

  record("authorize", req, req.body, "success");
  res.status(200).json({
    ok: true,
    step: "payment",
    authorizationId: `pay-${orderId}`,
    orderId,
  });
});

app.post("/payment/refund", (req: Request, res: Response) => {
  const { orderId } = req.body || {};
  if (!orderId) {
    record("refund", req, req.body, "validation_error");
    res.status(400).json({ code: "validation_error", message: "orderId is required" });
    return;
  }

  if (shouldFail(config.paymentRefundFailMode)) {
    record("refund", req, req.body, "failed");
    res.status(422).json({
      ok: false,
      step: "payment_refund",
      code: "refund_failed",
      orderId,
    });
    return;
  }

  record("refund", req, req.body, "success");
  res.status(200).json({
    ok: true,
    step: "payment_refund",
    refundId: `refund-${orderId}`,
    orderId,
  });
});

app.get("/admin/logs", (_req: Request, res: Response) => {
  res.status(200).json({ service: "payment", logs });
});

app.post("/admin/config", (req: Request, res: Response) => {
  const incoming = req.body || {};
  if (typeof incoming.paymentFailMode === "string") {
    config.paymentFailMode = incoming.paymentFailMode;
  }
  if (typeof incoming.paymentRefundFailMode === "string") {
    config.paymentRefundFailMode = incoming.paymentRefundFailMode;
  }
  res.status(200).json({ status: "ok", config });
});

app.post("/admin/reset", (_req: Request, res: Response) => {
  logs = [];
  sequence = 0;
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`[payment] mock listening on ${PORT}`);
});
