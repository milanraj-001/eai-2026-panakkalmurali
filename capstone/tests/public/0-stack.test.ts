/**
 * Stage 0: the stack (README §3.1, §3.2, §4.9). Your services are up and
 * healthy, your docker-compose.yml keeps the fixed parts, and the broker holds
 * the kit's topology.
 *
 * P0.2 reads docker-compose.yml and needs no running stack. P0.1 and P0.3 do:
 * start it with `docker compose up -d --build --wait` in capstone/.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import YAML from "yaml";
import {
  because,
  COMPOSE_ENV_FILE,
  docker,
  get,
  management,
  noProblems,
  PROJECT,
  show,
  STUDENT_SERVICES,
  SUBMISSION_DIR,
  urlOf,
} from "../lib/index.js";

/** The queue each service must consume, where the brief names one. */
const MUST_CONSUME: Record<string, string | undefined> = {
  intake: undefined,
  observer: "trace.store",
  orchestrator: "saga.queue",
  notifier: "notifications.queue",
};

describe("stage 0 · the stack", () => {
  test("P0.1 · every one of your services answers GET /health with 200 and the deep-check structure", async () => {
    const problems: string[] = [];
    for (const service of STUDENT_SERVICES) {
      let r;
      try {
        r = await get(`${urlOf(service)}/health`);
      } catch (err) {
        problems.push(`${service}: ${(err as Error).message}`);
        continue;
      }
      const b = r.body;
      const where = `${service}: GET /health answered ${r.status} ${show(b)}`;
      if (r.status !== 200) {
        problems.push(`${where}; expected 200 {status: "ok", checks: {broker: "up", consumers: {…}}}`);
        continue;
      }
      if (b?.status !== "ok") problems.push(`${where}; expected status "ok"`);
      if (b?.checks?.broker !== "up") problems.push(`${where}; expected checks.broker "up"`);
      const consumers = b?.checks?.consumers;
      if (typeof consumers !== "object" || consumers === null || Array.isArray(consumers)) {
        problems.push(`${where}; expected checks.consumers, an object of queue → consumer count`);
        continue;
      }
      for (const [queue, n] of Object.entries(consumers)) {
        if (!Number.isInteger(n) || (n as number) < 1) problems.push(`${service}: checks.consumers["${queue}"] is ${show(n)}, but a 200 means every queue it consumes has a consumer`);
      }
      const needed = MUST_CONSUME[service];
      if (needed && !(needed in consumers)) problems.push(`${service}: checks.consumers does not list ${needed}, the queue it consumes`);
    }
    noProblems("R-4.9.12, R-3.1.2", problems);
  });

  test("P0.2 · docker-compose.yml includes docker-compose.kit.yml and declares the fixed names, host ports, mem_limits and named volumes", () => {
    const file = path.join(SUBMISSION_DIR, "docker-compose.yml");
    expect(existsSync(file), because("R-3.1.3", `there is no ${file}`)).toBe(true);

    const problems: string[] = [];
    // The include line itself: the resolved configuration no longer shows it.
    let raw: any;
    try {
      raw = YAML.parse(readFileSync(file, "utf8"));
    } catch (err) {
      problems.push(`R-3.1.3: docker-compose.yml is not valid YAML: ${(err as Error).message}`);
    }
    const includes: unknown[] = Array.isArray(raw?.include) ? raw.include : [];
    const includesKit = includes.some((entry) => {
      const paths = typeof entry === "string" ? [entry] : ([] as unknown[]).concat((entry as { path?: unknown })?.path ?? []);
      return paths.some((p) => typeof p === "string" && p.replace(/^\.\//, "") === "docker-compose.kit.yml");
    });
    if (!includesKit) problems.push("R-3.1.3, R-9.1: docker-compose.yml has no `include:` entry for docker-compose.kit.yml");

    // The configuration exactly as Compose resolves it (README §9), with the temporal profile so a worker shows.
    const args = ["compose", "-f", file];
    if (COMPOSE_ENV_FILE) args.push("--env-file", COMPOSE_ENV_FILE);
    args.push("--profile", "temporal", "config", "--format", "json");
    let config: any;
    try {
      config = JSON.parse(docker(...args));
    } catch (err) {
      problems.push(`R-3.1.3: \`docker compose config\` rejects your configuration: ${(err as Error).message}`);
    }

    if (config) {
      if (!PROJECT && config.name !== "capstone") problems.push(`R-3.1.1: the Compose project is "${config.name}", not "capstone". Keep the folder name, and set no \`name:\``);
      const services = config.services ?? {};
      for (const kit of ["rabbitmq", "pricing", "payment", "inventory", "shipping", "notification"]) {
        if (services[kit]?.container_name !== `cap-${kit}`) problems.push(`R-3.1.3: the kit service ${kit} is missing, or not named cap-${kit}. Is the include working?`);
      }
      const expected: Array<[string, number | null, number]> = [
        ["intake", 8800, 256],
        ["observer", 8801, 256],
        ["orchestrator", 8802, 256],
        ["notifier", 8803, 256],
      ];
      if (services.worker) expected.push(["worker", null, 768]);
      for (const [name, port, mb] of expected) {
        const s = services[name];
        if (!s) {
          problems.push(`R-3.1.2: there is no service \`${name}\``);
          continue;
        }
        if (s.container_name !== `cap-${name}`) problems.push(`R-3.1.2: ${name}'s container_name is ${show(s.container_name)}, not "cap-${name}"`);
        if (port !== null) {
          const published = (s.ports ?? []).map((p: any) => Number(p.published));
          if (!published.includes(port)) problems.push(`R-3.1.2: ${name} does not publish host port ${port} (it publishes ${show(published)})`);
        }
        if (Number(s.mem_limit) !== mb * 1024 * 1024) problems.push(`R-3.6.2: ${name}'s mem_limit is ${show(s.mem_limit)} bytes, not ${mb}m`);
        if (name === "worker") {
          if (!(s.profiles ?? []).includes("temporal")) problems.push("R-3.1.6: the worker is not in the profile `temporal`");
          continue;
        }
        const data = (s.volumes ?? []).find((v: any) => v.target === "/data");
        if (!data || data.type !== "volume" || data.source !== `${name}-data`) {
          problems.push(`R-3.1.4: ${name} must mount the named volume ${name}-data at /data (it has ${show(data ?? "nothing at /data")})`);
        }
        const hc = s.healthcheck;
        if (!hc || hc.disable || !Array.isArray(hc.test) || hc.test[0] === "NONE") problems.push(`R-3.1.5: ${name} declares no healthcheck`);
      }
    }
    noProblems("R-3.1.1, R-3.1.2, R-3.1.3, R-3.1.4, R-3.1.5, R-3.6.2, R-9.1", problems);
  });

  test("P0.3 · the broker holds the topology of README §3.2, with its types and arguments", async () => {
    const [ex, qs, bs] = await Promise.all([management("/exchanges/%2F"), management("/queues/%2F"), management("/bindings/%2F")]).catch((err) => {
      throw new Error(because("R-3.2.1", `cannot read the topology from the management API: ${err.message}`));
    });
    for (const r of [ex, qs, bs]) expect(r.status, because("R-3.2.1", `the management API answered ${r.status} ${show(r.body)}`)).toBe(200);
    const exchanges = new Map<string, any>((ex.body as any[]).map((e) => [e.name, e]));
    const queues = new Map<string, any>((qs.body as any[]).map((q) => [q.name, q]));
    const bindings = new Set((bs.body as any[]).filter((b) => b.destination_type === "queue").map((b) => `${b.source} → ${b.destination} (${b.routing_key})`));

    const problems: string[] = [];
    const EXCHANGES: Record<string, string> = {
      "orders.exchange": "fanout",
      "orders.retry.exchange": "direct",
      "orders.return.exchange": "direct",
      "orders.dlq.exchange": "fanout",
      "orders.invalid.exchange": "fanout",
      "orders.outcome": "topic",
      "trace.events": "fanout",
    };
    for (const [name, type] of Object.entries(EXCHANGES)) {
      const e = exchanges.get(name);
      if (!e) problems.push(`exchange ${name} is missing`);
      else if (e.type !== type || e.durable !== true) problems.push(`exchange ${name} is ${e.durable ? "durable" : "not durable"} ${e.type}; expected durable ${type}`);
    }
    const retry = (origin: string) => ({ "x-dead-letter-exchange": "orders.retry.exchange", "x-dead-letter-routing-key": origin });
    const back = (origin: string) => ({ "x-message-ttl": 1000, "x-dead-letter-exchange": "orders.return.exchange", "x-dead-letter-routing-key": origin });
    const QUEUES: Record<string, Record<string, unknown>> = {
      "saga.queue": retry("saga.queue"),
      "saga.retry.queue": back("saga.queue"),
      "notifications.queue": retry("notifications.queue"),
      "notifications.retry.queue": back("notifications.queue"),
      "orders.dlq": {},
      "orders.invalid": {},
      "trace.store": {},
    };
    for (const [name, args] of Object.entries(QUEUES)) {
      const q = queues.get(name);
      if (!q) {
        problems.push(`queue ${name} is missing`);
        continue;
      }
      if (q.durable !== true) problems.push(`queue ${name} is not durable`);
      const actual = q.arguments ?? {};
      const same = Object.keys({ ...actual, ...args }).every((k) => actual[k] === args[k]);
      if (!same) problems.push(`queue ${name} has the arguments ${show(actual)}; expected ${show(args)}`);
    }
    const BINDINGS = [
      "orders.exchange → saga.queue ()",
      "orders.return.exchange → saga.queue (saga.queue)",
      "orders.retry.exchange → saga.retry.queue (saga.queue)",
      "orders.outcome → notifications.queue (order.failed)",
      "orders.outcome → notifications.queue (order.compensated)",
      "orders.return.exchange → notifications.queue (notifications.queue)",
      "orders.retry.exchange → notifications.retry.queue (notifications.queue)",
      "orders.dlq.exchange → orders.dlq ()",
      "orders.invalid.exchange → orders.invalid ()",
      "trace.events → trace.store ()",
    ];
    for (const b of BINDINGS) if (!bindings.has(b)) problems.push(`binding ${b} is missing`);
    noProblems("R-3.2.1", problems, "rabbitmq/definitions.json is loaded when the broker starts; compare it with README §3.2:");
  });
});
