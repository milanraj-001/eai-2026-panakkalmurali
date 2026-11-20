/**
 * HTTP for the tests, and the wording of every failure message: the
 * requirement, its README section, and what the test observed (README §7).
 */
import { type Service, containerName, HOST_PORT, urlOf } from "./targets.js";

/** Compact JSON for a failure message, cut at 300 characters. */
export function show(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** R-4.1.11 → §4.1; R-6.3 → §6. */
function sectionOf(id: string): string {
  const parts = id.replace(/^R-/, "").split(".");
  return parts.length >= 3 ? `${parts[0]}.${parts[1]}` : parts[0]!;
}

/**
 * The prefix of a failure message: `R-4.1.11 (README §4.1): <observed>`.
 * `ids` is one requirement ID or several, comma-separated.
 */
export function because(ids: string, observed: string): string {
  const list = ids.split(",").map((s) => s.trim());
  const sections = [...new Set(list.map(sectionOf))].map((s) => `§${s}`).join(", ");
  return `${list.join(", ")} (README ${sections}): ${observed}`;
}

/** Fails once, listing every problem found, when there are any. For checks that collect several findings. */
export function noProblems(ids: string, problems: string[], context = ""): void {
  if (problems.length === 0) return;
  const error = new Error(because(ids, `${context}\n  - ${problems.join("\n  - ")}\n`));
  error.name = "Failed";
  throw error;
}

export interface Reply {
  status: number;
  body: any;
  headers: Headers;
  ms: number;
}

/** Which service a URL belongs to, for the hint when it does not answer. */
function serviceAt(url: string): Service | undefined {
  for (const service of Object.keys(HOST_PORT) as Array<Exclude<Service, "rabbitmq">>) {
    try {
      if (url.startsWith(urlOf(service))) return service;
    } catch {
      // project mode, and discovery failed: no hint
    }
  }
  if (/:15680\b/.test(url)) return "rabbitmq";
  return undefined;
}

export class NoAnswer extends Error {}

/**
 * One request. A connection reset before any response is retried once
 * (Docker Desktop's port forwarding does that under load). No answer at all
 * throws a NoAnswer that says which container to look at.
 */
export async function http(
  url: string,
  opts: { method?: string; body?: string | Buffer | object; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Reply> {
  const raw = typeof opts.body === "string" || Buffer.isBuffer(opts.body);
  const headers = { ...(opts.body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...opts.headers };
  const body =
    opts.body === undefined
      ? undefined
      : typeof opts.body === "string"
        ? opts.body
        : Buffer.isBuffer(opts.body)
          ? new Uint8Array(opts.body)
          : JSON.stringify(opts.body);
  const method = opts.method ?? "GET";
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        // not JSON: keep the text
      }
      return { status: res.status, body: parsed, headers: res.headers, ms: Date.now() - started };
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      const code = e.cause?.code ?? e.name ?? "error";
      if (attempt === 1 && (code === "ECONNRESET" || code === "UND_ERR_SOCKET")) continue;
      const service = serviceAt(url);
      const hint = service
        ? ` Is ${containerName(service)} running and healthy? \`docker compose ps\` shows your containers; \`docker compose logs ${service}\` shows why one stopped.`
        : "";
      const what = code === "TimeoutError" ? `no answer within ${opts.timeoutMs ?? 15_000} ms` : `no answer (${code})`;
      const said = `${method} ${url}: ${what}.${hint}`;
      // A service that does not answer on its fixed host port breaks R-3.1.2 first, whatever the test.
      throw new NoAnswer(service && code !== "TimeoutError" ? because("R-3.1.2", said) : said);
    }
  }
}

export const get = (url: string, headers?: Record<string, string>) => http(url, { headers });
export const post = (url: string, body: unknown = {}, headers?: Record<string, string>) =>
  http(url, { method: "POST", body: body as object, headers });

// ---------------------------------------------------------------- polling ---

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls `probe` until `ok` holds. On timeout, throws with `what` and the last
 * value seen, so the failure says what the system was doing instead.
 */
export async function until<V>(what: string, probe: () => Promise<V>, ok: (v: V) => boolean, timeoutMs = 10_000, everyMs = 100): Promise<V> {
  const deadline = Date.now() + timeoutMs;
  let last: V | undefined;
  let lastError: Error | undefined;
  for (;;) {
    try {
      last = await probe();
      lastError = undefined;
      if (ok(last)) return last;
    } catch (err) {
      lastError = err as Error;
    }
    if (Date.now() > deadline) {
      const seen = lastError ? `the last attempt failed: ${lastError.message}` : `last seen: ${show(last)}`;
      throw new Error(`${what}: still not true after ${timeoutMs} ms; ${seen}`);
    }
    await sleep(everyMs);
  }
}
