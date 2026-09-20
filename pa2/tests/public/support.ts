/**
 * PA2 test support — not a test file itself (no ".test.ts" suffix), so
 * vitest's `../tests/**\/*.test.ts` glob does not pick it up.
 *
 * Talks to the real stack started by `docker compose up -d --wait`: the
 * producer's HTTP API, the RabbitMQ management API, received.jsonl on the
 * host-mounted volume, and `docker` itself for restart/stop/start.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PA2_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const RECEIVED_PATH = path.join(PA2_ROOT, "data", "received.jsonl");

export const PRODUCER_URL = "http://localhost:3001";
export const MANAGEMENT_URL = "http://localhost:15673";
export const MANAGEMENT_AUTH = `Basic ${Buffer.from("eai:eai-pa2").toString("base64")}`;
export const QUEUE_NAME = "pa2.orders";

export const RABBITMQ_CONTAINER = "pa2-rabbitmq";
export const PRODUCER_CONTAINER = "pa2-producer";
export const CONSUMER_CONTAINER = "pa2-consumer";

export interface ReceivedLine {
  correlationId: string;
  receivedAt: string;
  payload: unknown;
  [key: string]: unknown;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------- producer --

export interface PublishOptions {
  correlationId?: string;
  mode?: "confirmed" | "fire-and-forget";
}

export interface PublishResult {
  status: number;
  body: Record<string, unknown>;
}

export async function publish(payload: unknown, opts: PublishOptions = {}): Promise<PublishResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.correlationId !== undefined) headers["x-correlation-id"] = opts.correlationId;
  if (opts.mode !== undefined) headers["x-publish-mode"] = opts.mode;

  let res: Response;
  try {
    res = await fetch(`${PRODUCER_URL}/publish`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // A header value outside Latin1 (e.g. Cyrillic) can't even be encoded as
    // an HTTP header — fetch/undici throws client-side before anything goes
    // over the wire. That is a stronger form of "rejected" than a 400 from
    // the server, so treat it as one rather than let the test crash.
    if (err instanceof TypeError && /ByteString/.test(err.message)) {
      return { status: 400, body: { error: "header value is not representable as a ByteString" } };
    }
    throw err;
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/**
 * Polls POST /publish until it returns 202, THEN confirms the probe message
 * actually made the full round trip to received.jsonl before returning.
 *
 * The second half matters because the producer and consumer hold
 * independent connections to RabbitMQ. `docker compose up -d --wait` only
 * waits on the healthchecks that exist (rabbitmq, producer) — the consumer
 * has none, since it has no HTTP surface to check. Right after a cold start
 * the producer's connection can succeed a couple of seconds before the
 * consumer's does (its own retry backoff runs on its own clock), so a test
 * that only checked "producer answered 202" could still race a
 * not-yet-connected consumer and see its very first message swallowed by
 * that window. Waiting for the probe to round-trip closes that window.
 */
export async function waitForProducerReady(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    try {
      const correlationId = `ready-probe-${Date.now()}`;
      const { status } = await publish({ probe: true }, { correlationId });
      lastStatus = status;
      if (status === 202) {
        const remaining = Math.max(deadline - Date.now(), 5_000);
        const found = await waitForCorrelationIds([correlationId], remaining);
        if (found.has(correlationId)) return;
        lastError = "probe published but never reached received.jsonl (consumer not yet connected?)";
        continue;
      }
    } catch (err) {
      lastError = (err as Error).message;
    }
    await sleep(1000);
  }
  throw new Error(
    `producer/consumer pipeline never became ready within ${timeoutMs}ms ` +
      `(last status: ${lastStatus ?? "none"}, last error: ${lastError ?? "none"})`,
  );
}

// -------------------------------------------------------- received.jsonl --

export function readReceivedLines(): ReceivedLine[] {
  if (!existsSync(RECEIVED_PATH)) return [];
  const text = readFileSync(RECEIVED_PATH, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ReceivedLine);
}

/** Waits until every id in `ids` has shown up in received.jsonl, or times out. */
export async function waitForCorrelationIds(
  ids: readonly string[],
  timeoutMs = 60_000,
): Promise<Map<string, ReceivedLine>> {
  const remaining = new Set(ids);
  const found = new Map<string, ReceivedLine>();
  const deadline = Date.now() + timeoutMs;

  while (remaining.size > 0) {
    for (const line of readReceivedLines()) {
      if (remaining.has(line.correlationId)) {
        found.set(line.correlationId, line);
        remaining.delete(line.correlationId);
      }
    }
    if (remaining.size === 0 || Date.now() >= deadline) break;
    await sleep(500);
  }
  return found;
}

// ------------------------------------------------------------ management --

export async function queueDepth(): Promise<number> {
  const res = await fetch(`${MANAGEMENT_URL}/api/queues/%2f/${encodeURIComponent(QUEUE_NAME)}`, {
    headers: { authorization: MANAGEMENT_AUTH },
  });
  if (res.status === 404) return 0; // queue not declared yet
  if (!res.ok) {
    throw new Error(`management API returned ${res.status} for queue depth`);
  }
  const body = (await res.json()) as { messages?: number };
  return body.messages ?? 0;
}

export async function waitForQueueDepth(
  predicate: (depth: number) => boolean,
  timeoutMs = 60_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = await queueDepth();
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(500);
    last = await queueDepth();
  }
  return last;
}

/**
 * The management API's per-queue `messages` count is a periodic snapshot,
 * not real-time — RabbitMQ's classic stats-collection interval refreshes it
 * roughly every 5s. Reading it right after stopping the consumer or
 * restarting the broker can catch a stale, momentarily-inflated (or
 * momentarily-stale-LOW, mid-drain) number. Using that as a "baseline" then
 * makes a correct implementation look like it under-delivers.
 *
 * Poll until two reads agree, spaced further apart than that refresh
 * interval — two reads close together can agree by coincidence (they both
 * land within the same stats snapshot) without the underlying count having
 * actually finished settling. 6s apart guarantees at least one real refresh
 * happened between them.
 */
export async function stableQueueDepth(timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let previous = await queueDepth();
  for (;;) {
    await sleep(6_000);
    const current = await queueDepth();
    if (current === previous) return current;
    previous = current;
    if (Date.now() > deadline) return current;
  }
}

// ----------------------------------------------------------------- docker --

export async function dockerRestart(container: string): Promise<void> {
  await execFileAsync("docker", ["restart", container]);
}

/**
 * `docker restart` sends SIGTERM first and only escalates to SIGKILL after a
 * grace period — long enough that RabbitMQ can perform a clean shutdown and,
 * in doing so, sometimes flushes even non-persistent messages to disk before
 * exiting. That defeats a test whose whole point is that non-persistent
 * messages are lost: it makes the loss a race instead of a guarantee. Kill
 * outright (SIGKILL, no grace period) when the test needs message loss to be
 * unconditional, then bring the container back with dockerStart.
 */
export async function dockerKill(container: string): Promise<void> {
  await execFileAsync("docker", ["kill", container]);
}

export async function dockerStop(container: string): Promise<void> {
  await execFileAsync("docker", ["stop", container]);
}

export async function dockerStart(container: string): Promise<void> {
  await execFileAsync("docker", ["start", container]);
}

export async function waitForContainerHealthy(container: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        container,
      ]);
      if (stdout.trim() === "healthy") return;
    } catch {
      /* container may be mid-restart and briefly uninspectable; keep polling */
    }
    await sleep(1000);
  }
  throw new Error(`${container} did not become healthy within ${timeoutMs}ms`);
}

let idCounter = 0;

/** A correlationId unique to this test run, so files never collide across runs. */
export function testCorrelationId(label: string): string {
  idCounter += 1;
  return `test-${label}-${process.pid}-${Date.now()}-${idCounter}`;
}
