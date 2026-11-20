/**
 * Capstone kit — the engine behind the payment, inventory, shipping and
 * notification mocks. Instructor-owned, replaced at grading (PA8 spec §5.2).
 *
 * Lineage: the PA6 mocks. Their routes, response bodies, log fields and
 * /admin/config fields (paymentFailMode, shippingDelayMs, …) still work, so
 * the PA6 suites pass against these mocks unchanged.
 *
 * Each operation (authorize, refund, reserve, release, create, send) has its
 * own settings in POST /admin/config:
 *
 *   failMode         never | always | times | random: whether a call fails
 *   failTimes        with "times": how many calls fail before calls succeed again
 *   failStatus       the HTTP status of an injected failure, 400–599. Default 422
 *   failCode         the `code` in its body. Default: the PA6 code for a 4xx,
 *                    "service_unavailable" for a 5xx
 *   delayMs          wait this long before answering, whether the call fails or not
 *   failForOrderIds, failForProductIds (reserve), failForKinds (send)
 *                    filters: only matching calls can fail. A "times" count
 *                    counts matching calls only
 *   effectThenFail   an injected failure performs the effect first, then waits
 *                    delayMs and fails. The provider did the work, but the
 *                    caller saw an error or a timeout: the unknown state
 *
 * A delayed call performs its effect when the delay ends, even if the caller
 * has given up by then. That is what a slow provider does.
 *
 * Idempotency-Key (payment and inventory only). A key that already produced an
 * effect gets the stored response back at once, with no new effect, before any
 * failure injection or delay. A failure with no effect stores nothing, so a
 * retry after it is processed afresh. A call whose key is still being
 * processed waits for that call to finish.
 *
 * Admin API
 *   GET  /admin/logs[?orderId=&correlationId=]     every call, recorded when it is answered
 *   GET  /admin/effects[?orderId=&correlationId=]  the side effects actually performed
 *   GET  /admin/config                             the settings in force
 *   POST /admin/config                             a partial update. Validated; all or nothing
 *   POST /admin/reset                              clears logs, effects, keys and "times" counts,
 *                                                  and restores the boot settings
 *
 * MOCK_CONFIG (env, optional): a POST /admin/config body applied at boot. The
 * result is the boot settings that /admin/reset restores. Invalid → exit 1.
 *
 * A call still in flight when /admin/reset arrives finishes against the state
 * it started with, so it never shows up in the logs or effects after the reset.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { type Body, isObject, nonEmptyString } from "./util.js";

export type FailMode = "never" | "always" | "times" | "random";
const FAIL_MODES: readonly string[] = ["never", "always", "times", "random"];

export interface OperationConfig {
  failMode: FailMode;
  failTimes: number;
  failStatus: number;
  failCode: string | null;
  delayMs: number;
  effectThenFail: boolean;
  failForOrderIds: string[];
  failForProductIds: string[];
  failForKinds: string[];
}

const CONFIG_FIELDS = [
  "failMode", "failTimes", "failStatus", "failCode", "delayMs", "effectThenFail",
  "failForOrderIds", "failForProductIds", "failForKinds",
];

export type ServiceConfig = Record<string, OperationConfig>;

export interface OperationDef {
  /** The log `action` and the /admin/config key. */
  name: string;
  path: string;
  /** The PA6 `step` in response bodies. */
  step: string;
  /** The PA6 failure code: the default `code` of an injected 4xx. */
  declineCode: string;
  /** The effect type in /admin/effects. */
  effect: string;
  /** The success body's id, as in PA6: ["authorizationId", "pay"] → "pay-<orderId>". */
  resultId: [field: string, prefix: string];
  honoursIdempotencyKey: boolean;
  /** An error message, or null when the body is acceptable. */
  validate(body: Body): string | null;
  /** Operation-specific fields copied into log and effect entries. */
  details(body: Body): Body;
  /** Defined when failForProductIds applies to this operation. */
  productIds?(body: Body): string[];
  /** Defined when failForKinds applies to this operation. */
  kind?(body: Body): string;
}

export interface ServiceDef {
  name: string;
  defaultPort: number;
  operations: OperationDef[];
  /** PA6 /admin/config fields, still accepted. */
  aliases: Record<string, { operation: string; field: "failMode" | "delayMs" }>;
}

type Outcome = "success" | "failed" | "validation_error" | "replayed";

interface CallMeta {
  orderId: string | null;
  correlationId: string | null;
  causationId: string | null;
  idempotencyKey: string | null;
}

interface LogEntry extends CallMeta {
  seq: number;
  /** = respondedAt. The PA6 field. */
  at: string;
  receivedAt: string;
  respondedAt: string;
  action: string;
  outcome: Outcome;
  status: number;
  /** Whether this call performed a new side effect. */
  effect: boolean;
  delayMs: number;
  [detail: string]: unknown;
}

interface EffectEntry extends CallMeta {
  seq: number;
  at: string;
  type: string;
  action: string;
  [detail: string]: unknown;
}

interface State {
  config: ServiceConfig;
  /** How many calls each "times" operation has failed so far. */
  failures: Record<string, number>;
  logs: LogEntry[];
  effects: EffectEntry[];
  logSeq: number;
  effectSeq: number;
  /** operation + Idempotency-Key → the response that produced the effect. */
  stored: Map<string, { status: number; body: unknown }>;
  inflight: Map<string, Promise<void>>;
}

// ---- config ----

function defaultOperationConfig(): OperationConfig {
  return {
    failMode: "never",
    failTimes: 0,
    failStatus: 422,
    failCode: null,
    delayMs: 0,
    effectThenFail: false,
    failForOrderIds: [],
    failForProductIds: [],
    failForKinds: [],
  };
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(nonEmptyString) ? [...value] : null;
}

/** Sets one field on `target`. Returns an error message, or null. */
function setField(op: OperationDef, target: OperationConfig, field: string, value: unknown): string | null {
  switch (field) {
    case "failMode":
      if (typeof value !== "string" || !FAIL_MODES.includes(value)) return `must be one of ${FAIL_MODES.join(", ")}`;
      target.failMode = value as FailMode;
      return null;
    case "failTimes":
      if (!Number.isInteger(value) || (value as number) < 0) return "must be an integer >= 0";
      target.failTimes = value as number;
      return null;
    case "failStatus":
      if (!Number.isInteger(value) || (value as number) < 400 || (value as number) > 599) {
        return "must be an integer from 400 to 599";
      }
      target.failStatus = value as number;
      return null;
    case "failCode":
      if (value !== null && !nonEmptyString(value)) return "must be a non-empty string, or null for the default";
      target.failCode = value;
      return null;
    case "delayMs":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "must be a number >= 0";
      target.delayMs = Math.floor(value);
      return null;
    case "effectThenFail":
      if (typeof value !== "boolean") return "must be true or false";
      target.effectThenFail = value;
      return null;
    case "failForOrderIds":
    case "failForProductIds":
    case "failForKinds": {
      if (field === "failForProductIds" && !op.productIds) return `not supported: ${op.name} requests carry no items`;
      if (field === "failForKinds" && !op.kind) return `not supported: ${op.name} requests carry no kind`;
      const list = stringList(value);
      if (list === null) return "must be an array of non-empty strings";
      target[field] = list;
      return null;
    }
    default:
      return `unknown field. Fields: ${CONFIG_FIELDS.join(", ")}`;
  }
}

function warningsFor(service: ServiceDef, config: ServiceConfig): string[] {
  const warnings: string[] = [];
  for (const op of service.operations) {
    const c = config[op.name]!;
    const filtered = c.failForOrderIds.length + c.failForProductIds.length + c.failForKinds.length > 0;
    if (c.failMode === "never" && filtered) warnings.push(`${op.name}: the failFor* filters do nothing while failMode is "never"`);
    if (c.failMode === "never" && c.effectThenFail) warnings.push(`${op.name}: effectThenFail does nothing while failMode is "never"`);
    if (c.failMode === "times" && c.failTimes === 0) warnings.push(`${op.name}: failMode "times" with failTimes 0 never fails`);
  }
  return warnings;
}

export type ConfigResult =
  | { ok: true; config: ServiceConfig; restartCounts: string[]; warnings: string[] }
  | { ok: false; errors: string[] };

/** Applies a POST /admin/config body to `current`, without changing it. */
export function applyConfigUpdate(service: ServiceDef, current: ServiceConfig, input: unknown): ConfigResult {
  if (!isObject(input)) return { ok: false, errors: ["the config must be a JSON object"] };

  const next: ServiceConfig = {};
  for (const [name, settings] of Object.entries(current)) {
    next[name] = {
      ...settings,
      failForOrderIds: [...settings.failForOrderIds],
      failForProductIds: [...settings.failForProductIds],
      failForKinds: [...settings.failForKinds],
    };
  }
  const errors: string[] = [];
  const restart = new Set<string>();

  for (const [key, value] of Object.entries(input)) {
    const op = service.operations.find((o) => o.name === key);
    if (op) {
      if (!isObject(value)) {
        errors.push(`${key}: must be an object of settings`);
        continue;
      }
      for (const [field, fieldValue] of Object.entries(value)) {
        const error = setField(op, next[key]!, field, fieldValue);
        if (error) errors.push(`${key}.${field}: ${error}`);
        if (field === "failMode" || field === "failTimes") restart.add(key);
      }
      continue;
    }
    const alias = service.aliases[key];
    if (alias) {
      const target = service.operations.find((o) => o.name === alias.operation)!;
      const error = setField(target, next[alias.operation]!, alias.field, value);
      if (error) errors.push(`${key}: ${error}`);
      if (alias.field === "failMode") restart.add(alias.operation);
      continue;
    }
    errors.push(
      `${key}: unknown key. Operations: ${service.operations.map((o) => o.name).join(", ")}. ` +
        `PA6 fields: ${Object.keys(service.aliases).join(", ")}`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: next, restartCounts: [...restart], warnings: warningsFor(service, next) };
}

/** Defaults plus MOCK_CONFIG. Throws when MOCK_CONFIG is invalid. */
export function bootConfig(service: ServiceDef, mockConfig: string | undefined): ServiceConfig {
  const defaults: ServiceConfig = {};
  for (const op of service.operations) defaults[op.name] = defaultOperationConfig();
  if (mockConfig === undefined || mockConfig.trim() === "") return defaults;

  let parsed: unknown;
  try {
    parsed = JSON.parse(mockConfig);
  } catch (err) {
    throw new Error(`MOCK_CONFIG is not valid JSON: ${(err as Error).message}`);
  }
  const result = applyConfigUpdate(service, defaults, parsed);
  if (!result.ok) throw new Error(`MOCK_CONFIG rejected:\n  ${result.errors.join("\n  ")}`);
  for (const warning of result.warnings) console.warn(`[${service.name}] MOCK_CONFIG: ${warning}`);
  return result.config;
}

// ---- the mock ----

function newState(boot: ServiceConfig): State {
  return {
    config: boot,
    failures: {},
    logs: [],
    effects: [],
    logSeq: 0,
    effectSeq: 0,
    stored: new Map(),
    inflight: new Map(),
  };
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function callMeta(req: Request, body: Body): CallMeta {
  return {
    orderId: nonEmptyString(body.orderId) ? body.orderId : req.header("x-order-id") ?? null,
    correlationId: req.header("x-correlation-id") ?? null,
    causationId: req.header("x-causation-id") ?? null,
    idempotencyKey: req.header("idempotency-key") ?? null,
  };
}

function decideFailure(op: OperationDef, c: OperationConfig, body: Body, orderId: string | null, s: State): boolean {
  if (c.failMode === "never") return false;
  if (c.failForOrderIds.length > 0 && (orderId === null || !c.failForOrderIds.includes(orderId))) return false;
  if (c.failForProductIds.length > 0 && !(op.productIds?.(body) ?? []).some((id) => c.failForProductIds.includes(id))) {
    return false;
  }
  if (c.failForKinds.length > 0 && !c.failForKinds.includes(op.kind?.(body) ?? "")) return false;
  if (c.failMode === "always") return true;
  if (c.failMode === "random") return Math.random() < 0.5;
  const failed = s.failures[op.name] ?? 0;
  if (failed >= c.failTimes) return false;
  s.failures[op.name] = failed + 1;
  return true;
}

function matches(entry: CallMeta, query: Request["query"]): boolean {
  const { orderId, correlationId } = query;
  return (
    (typeof orderId !== "string" || entry.orderId === orderId) &&
    (typeof correlationId !== "string" || entry.correlationId === correlationId)
  );
}

export function createApp(service: ServiceDef, boot: ServiceConfig): express.Express {
  let state = newState(boot);

  function recordCall(
    s: State, op: OperationDef, call: CallMeta, details: Body, receivedAt: string,
    status: number, outcome: Outcome, effect: boolean, delayMs: number,
  ): void {
    const respondedAt = new Date().toISOString();
    s.logSeq += 1;
    s.logs.push({
      seq: s.logSeq, at: respondedAt, receivedAt, respondedAt, action: op.name,
      ...call, outcome, status, effect, delayMs, ...details,
    });
  }

  async function handle(op: OperationDef, req: Request, res: Response): Promise<void> {
    const s = state;
    const receivedAt = new Date().toISOString();
    const body: Body = isObject(req.body) ? req.body : {};
    const call = callMeta(req, body);
    const details = op.details(body);

    const answer = (status: number, payload: unknown, outcome: Outcome, effect: boolean, delayMs: number): void => {
      recordCall(s, op, call, details, receivedAt, status, outcome, effect, delayMs);
      res.status(status).json(payload);
    };

    const invalid = op.validate(body);
    if (invalid !== null) {
      answer(400, { code: "validation_error", message: invalid }, "validation_error", false, 0);
      return;
    }

    const key = op.honoursIdempotencyKey && call.idempotencyKey ? `${op.name}\n${call.idempotencyKey}` : null;
    let release = (): void => {};
    let claim: Promise<void> | null = null;
    if (key) {
      for (;;) {
        const stored = s.stored.get(key);
        if (stored) {
          answer(stored.status, stored.body, "replayed", false, 0);
          return;
        }
        const pending = s.inflight.get(key);
        if (!pending) break;
        await pending;
      }
      claim = new Promise<void>((resolve) => {
        release = resolve;
      });
      s.inflight.set(key, claim);
    }

    const [idField, idPrefix] = op.resultId;
    const success = { ok: true, step: op.step, [idField]: `${idPrefix}-${call.orderId}`, orderId: call.orderId };
    const commit = (): void => {
      s.effectSeq += 1;
      s.effects.push({ seq: s.effectSeq, at: new Date().toISOString(), type: op.effect, action: op.name, ...call, ...details });
      if (key) s.stored.set(key, { status: 200, body: success });
    };

    try {
      const c = s.config[op.name]!;
      const fails = decideFailure(op, c, body, call.orderId, s);
      const failure = {
        ok: false,
        step: op.step,
        code: c.failCode ?? (c.failStatus < 500 ? op.declineCode : "service_unavailable"),
        orderId: call.orderId,
      };

      if (fails && c.effectThenFail) {
        commit();
        await sleep(c.delayMs);
        answer(c.failStatus, failure, "failed", true, c.delayMs);
        return;
      }
      await sleep(c.delayMs);
      if (fails) {
        answer(c.failStatus, failure, "failed", false, c.delayMs);
        return;
      }
      commit();
      answer(200, success, "success", true, c.delayMs);
    } finally {
      if (key && s.inflight.get(key) === claim) s.inflight.delete(key);
      release();
    }
  }

  const app = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", service: service.name });
  });

  for (const op of service.operations) {
    app.post(op.path, (req: Request, res: Response, next: NextFunction) => {
      handle(op, req, res).catch(next);
    });
  }

  app.get("/admin/logs", (req: Request, res: Response) => {
    res.status(200).json({ service: service.name, logs: state.logs.filter((e) => matches(e, req.query)) });
  });

  app.get("/admin/effects", (req: Request, res: Response) => {
    res.status(200).json({ service: service.name, effects: state.effects.filter((e) => matches(e, req.query)) });
  });

  app.get("/admin/config", (_req: Request, res: Response) => {
    res.status(200).json({ service: service.name, config: state.config });
  });

  app.post("/admin/config", (req: Request, res: Response) => {
    const result = applyConfigUpdate(service, state.config, req.body ?? {});
    if (!result.ok) {
      res.status(400).json({ code: "invalid_config", errors: result.errors });
      return;
    }
    state.config = result.config;
    for (const name of result.restartCounts) state.failures[name] = 0;
    res.status(200).json({ status: "ok", config: state.config, warnings: result.warnings });
  });

  app.post("/admin/reset", (_req: Request, res: Response) => {
    state = newState(boot);
    res.status(200).json({ status: "ok" });
  });

  // A body that is not JSON: a 400 like any other invalid body, and logged.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    if (status === 400) {
      const op = service.operations.find((o) => o.path === req.path);
      if (op) recordCall(state, op, callMeta(req, {}), {}, new Date().toISOString(), 400, "validation_error", false, 0);
      res.status(400).json({ code: "validation_error", message: "the body is not valid JSON" });
      return;
    }
    console.error(`[${service.name}]`, err);
    res.status(500).json({ code: "mock_error", message: String(err) });
  });

  return app;
}

export function startMock(service: ServiceDef, port: number, mockConfig: string | undefined): void {
  const app = createApp(service, bootConfig(service, mockConfig));
  app.listen(port, () => {
    console.log(`[${service.name}] mock listening on ${port}`);
  });
  // PID 1 in a container: without these, `docker stop` waits 10 s for SIGKILL.
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}
