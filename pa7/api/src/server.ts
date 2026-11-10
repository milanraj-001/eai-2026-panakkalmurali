/**
 * PA7 api. GIVEN, complete — read it, do not change it.
 *
 * It keeps PA6's HTTP contract in front of Temporal, so the same client and
 * the same tests work against both:
 *
 *   - POST /checkout validates the Idempotency-Key header and the canonical
 *     order, exactly as in PA6.
 *   - It starts the "checkout" workflow with workflowId = Idempotency-Key.
 *     Temporal refuses a second workflow with the same id, and that refusal
 *     is the whole idempotency mechanism:
 *       different payload (memo.payloadHash differs) → 409 idempotency_payload_mismatch
 *       same payload, first still running             → 409 idempotency_conflict
 *       same payload, first finished                  → the stored result again
 *   - It waits for the workflow's result and maps it to HTTP: completed →
 *     200, code "timeout" → 504, anything else → 422.
 *   - It mirrors every request into /data/idempotency-store.json and
 *     /data/saga-store.json, the same files and schemas as PA6. Temporal is
 *     the source of truth; the files are a read model, kept so the contrast
 *     with PA6 stays visible.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Client, Connection, WorkflowExecutionAlreadyStartedError, type WorkflowHandle } from "@temporalio/client";
import type { CanonicalOrder } from "./canonical-order";

const PORT = Number(process.env.PORT ?? 3000);
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const TASK_QUEUE = "checkout";
const WORKFLOW_TYPE = "checkout";
// Longest the api waits for a workflow before answering. The slowest correct
// saga (three timed-out attempts, then compensation) takes about 10 seconds.
const RESULT_WAIT_MS = Number(process.env.RESULT_WAIT_MS ?? 45000);

// ------------------------------------------------------------ validation --

const CANONICAL_SCHEMA_PATH = "/canonical/order.schema.json";
if (!fs.existsSync(CANONICAL_SCHEMA_PATH)) {
  throw new Error(
    `${CANONICAL_SCHEMA_PATH} not found. docker-compose.yml mounts ../canonical ` +
      "from your repository root: copy canonical/ from eai-2026 next to pa7/ " +
      '(root README, "Starting an assignment"), then run docker compose up again.',
  );
}
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validateCanonicalOrder = ajv.compile(JSON.parse(fs.readFileSync(CANONICAL_SCHEMA_PATH, "utf8")));

// ------------------------------------------------------- the audit mirror --

interface TraceItem {
  step: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

interface CheckoutResult {
  orderId: string;
  status: "completed" | "failed" | "compensated";
  code?: string;
  trace: TraceItem[];
}

const DATA_DIR = "/data";
const IDEMPOTENCY_STORE_PATH = path.join(DATA_DIR, "idempotency-store.json");
const SAGA_STORE_PATH = path.join(DATA_DIR, "saga-store.json");

function readStore<T>(filePath: string, empty: T): T {
  if (!fs.existsSync(filePath)) return empty;
  return JSON.parse(fs.readFileSync(filePath, "utf8") || "null") ?? empty;
}

function writeStore(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function mirrorInProgress(key: string, requestHash: string, orderId: string): void {
  const store = readStore<{ records: Record<string, unknown> }>(IDEMPOTENCY_STORE_PATH, { records: {} });
  store.records[key] = {
    requestHash,
    state: "in_progress",
    httpStatus: 202,
    response: { orderId, status: "in_progress" },
    updatedAt: new Date().toISOString(),
  };
  writeStore(IDEMPOTENCY_STORE_PATH, store);
}

function mirrorFinished(key: string, requestHash: string, httpStatus: number, result: CheckoutResult): void {
  const now = new Date().toISOString();
  const idempotency = readStore<{ records: Record<string, unknown> }>(IDEMPOTENCY_STORE_PATH, { records: {} });
  idempotency.records[key] = { requestHash, state: result.status, httpStatus, response: result, updatedAt: now };
  writeStore(IDEMPOTENCY_STORE_PATH, idempotency);

  const sagas = readStore<{ sagas: Record<string, unknown> }>(SAGA_STORE_PATH, { sagas: {} });
  sagas.sagas[result.orderId] = { idempotencyKey: key, state: result.status, steps: result.trace, updatedAt: now };
  writeStore(SAGA_STORE_PATH, sagas);
}

// --------------------------------------------------------------- Temporal --

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectToTemporal(): Promise<Client> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
      return new Client({ connection, namespace: "default" });
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`[api] Temporal at ${TEMPORAL_ADDRESS} not reachable yet (attempt ${attempt}), retrying`);
      await sleep(1000);
    }
  }
}

function httpStatusOf(result: CheckoutResult): number {
  if (result.status === "completed") return 200;
  if (result.code === "timeout") return 504;
  return 422;
}

type Waited = { done: true; result: CheckoutResult } | { done: false };

async function waitForResult(handle: WorkflowHandle): Promise<Waited> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Waited>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), RESULT_WAIT_MS);
  });
  try {
    return await Promise.race([
      handle.result().then((result: CheckoutResult): Waited => ({ done: true, result })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ routes --

async function main(): Promise<void> {
  const client = await connectToTemporal();
  const app = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/debug/trace/:orderId", (req: Request, res: Response) => {
    const sagas = readStore<{ sagas: Record<string, unknown> }>(SAGA_STORE_PATH, { sagas: {} });
    const saga = sagas.sagas[req.params.orderId ?? ""];
    if (!saga) {
      res.status(404).json({ code: "not_found", message: "No saga found for this orderId" });
      return;
    }
    res.status(200).json(saga);
  });

  app.post("/checkout", async (req: Request, res: Response) => {
    const key = req.header("Idempotency-Key");
    if (!key) {
      res.status(400).json({ code: "validation_error", message: "Idempotency-Key header is required" });
      return;
    }
    if (!validateCanonicalOrder(req.body)) {
      res.status(400).json({
        code: "validation_error",
        message: `Request body is not a canonical order: ${ajv.errorsText(validateCanonicalOrder.errors, { dataVar: "body" })}`,
      });
      return;
    }

    const order = req.body as CanonicalOrder;
    const requestHash = `sha256:${crypto.createHash("sha256").update(JSON.stringify(order)).digest("hex")}`;
    const handle = client.workflow.getHandle(key);

    try {
      await client.workflow.start(WORKFLOW_TYPE, {
        taskQueue: TASK_QUEUE,
        workflowId: key,
        args: [order],
        memo: { payloadHash: requestHash },
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      });
      mirrorInProgress(key, requestHash, order.orderId);
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
      const existing = await handle.describe();
      if (existing.memo?.payloadHash !== requestHash) {
        res.status(409).json({
          code: "idempotency_payload_mismatch",
          message: "This Idempotency-Key is already used for a different payload",
        });
        return;
      }
      if (existing.status.name === "RUNNING") {
        res.status(409).json({
          code: "idempotency_conflict",
          message: "A request with this Idempotency-Key is still in progress",
        });
        return;
      }
      // Same key, same payload, finished: fall through and return its result.
    }

    let waited: Waited;
    try {
      waited = await waitForResult(handle);
    } catch (err) {
      res.status(500).json({
        code: "workflow_failed",
        message: `The workflow failed instead of returning a result: ${(err as Error).message}`,
      });
      return;
    }
    if (!waited.done) {
      res.status(500).json({
        code: "workflow_not_finished",
        message:
          `The workflow is still running after ${RESULT_WAIT_MS / 1000} s. Look at it in the Temporal UI: ` +
          `http://localhost:8233/namespaces/default/workflows/${encodeURIComponent(key)}`,
      });
      return;
    }

    const httpStatus = httpStatusOf(waited.result);
    mirrorFinished(key, requestHash, httpStatus, waited.result);
    res.status(httpStatus).json(waited.result);
  });

  app.listen(PORT, () => {
    console.log(`[api] listening on port ${PORT}, Temporal at ${TEMPORAL_ADDRESS}`);
  });
}

main().catch((err) => {
  console.error("[api] fatal", err);
  process.exit(1);
});
