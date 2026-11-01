/**
 * PA6 mock notification service — ported from the practice-03-orchestration JS lab.
 * Same routes and fail-mode semantics. One change for 2026: each log entry
 * records the recipient it was asked to notify.
 */
import express, { type Request, type Response } from "express";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 4004);

type FailMode = "never" | "always" | "random";

interface LogEntry {
  seq: number;
  at: string;
  action: string;
  orderId: string | null;
  correlationId: string | null;
  outcome: string;
  recipient: string | null;
}

interface Config {
  notificationFailMode: FailMode;
}

let logs: LogEntry[] = [];
let sequence = 0;
const config: Config = {
  notificationFailMode: (process.env.NOTIFICATION_FAIL_MODE as FailMode | undefined) || "never",
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
    recipient: typeof body?.recipient === "string" ? body.recipient : null,
  });
}

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.post("/notification/send", (req: Request, res: Response) => {
  const { orderId, recipient } = req.body || {};
  if (!orderId || !recipient) {
    record("send", req, req.body, "validation_error");
    res.status(400).json({ code: "validation_error", message: "orderId and recipient are required" });
    return;
  }

  if (shouldFail(config.notificationFailMode)) {
    record("send", req, req.body, "failed");
    res.status(422).json({
      ok: false,
      step: "notification",
      code: "notification_failed",
      orderId,
    });
    return;
  }

  record("send", req, req.body, "success");
  res.status(200).json({
    ok: true,
    step: "notification",
    notificationId: `ntf-${orderId}`,
    orderId,
  });
});

app.get("/admin/logs", (_req: Request, res: Response) => {
  res.status(200).json({ service: "notification", logs });
});

app.post("/admin/config", (req: Request, res: Response) => {
  const incoming = req.body || {};
  if (typeof incoming.notificationFailMode === "string") {
    config.notificationFailMode = incoming.notificationFailMode;
  }
  res.status(200).json({ status: "ok", config });
});

app.post("/admin/reset", (_req: Request, res: Response) => {
  logs = [];
  sequence = 0;
  res.status(200).json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`[notification] mock listening on ${PORT}`);
});
