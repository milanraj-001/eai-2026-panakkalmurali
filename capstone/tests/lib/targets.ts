/**
 * Where the tests find your system. Every target comes from the environment,
 * with the README §3.1 values as the defaults, so with your stack running on
 * this machine you set nothing.
 *
 *   CAP_HOST                 host of every published port            localhost
 *   CAP_INTAKE_URL … CAP_NOTIFICATION_URL, CAP_PRICING_URL           one service's base URL
 *   CAP_AMQP_URL             amqp://eai:eai-capstone@<host>:5680
 *   CAP_MANAGEMENT_URL       http://<host>:15680
 *   CAP_CONTAINER_<SERVICE>  the container of one service              cap-<service>
 *   CAP_COMPOSE_PROJECT      address the stack by Compose project instead:
 *                            ports are discovered, and containers are
 *                            stopped and started through `docker compose -p`
 *   CAP_SUBMISSION_DIR       the capstone/ folder the stage 0 and stage 6
 *                            tests read                                 ../ from tests/
 *   CAP_COMPOSE_ENV_FILE     an --env-file for `docker compose config`  none
 *   CAP_SCHEMA_DIR           the JSON Schemas                          <submission>/grading/schema
 *   CAP_CANONICAL_SCHEMA     the canonical order schema                <submission>/../canonical/order.schema.json
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
};

const TESTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SUBMISSION_DIR = path.resolve(env("CAP_SUBMISSION_DIR") ?? path.join(TESTS_DIR, ".."));
export const SCHEMA_DIR = path.resolve(env("CAP_SCHEMA_DIR") ?? path.join(SUBMISSION_DIR, "grading", "schema"));
export const CANONICAL_SCHEMA = path.resolve(env("CAP_CANONICAL_SCHEMA") ?? path.join(SUBMISSION_DIR, "..", "canonical", "order.schema.json"));
export const FIXTURES_DIR = path.join(TESTS_DIR, "fixtures");
export const COMPOSE_ENV_FILE = env("CAP_COMPOSE_ENV_FILE");
export const PROJECT = env("CAP_COMPOSE_PROJECT");

/** Your four services, and the kit's. */
export const STUDENT_SERVICES = ["intake", "observer", "orchestrator", "notifier"] as const;
export type StudentService = (typeof STUDENT_SERVICES)[number];
export type Provider = "payment" | "inventory" | "shipping" | "notification";
export type Service = StudentService | Provider | "pricing" | "rabbitmq";

/** README §3.1: the fixed host ports, and the kit's ports inside its containers. */
export const HOST_PORT: Record<Exclude<Service, "rabbitmq">, number> = {
  intake: 8800,
  observer: 8801,
  orchestrator: 8802,
  notifier: 8803,
  pricing: 4110,
  payment: 4801,
  inventory: 4802,
  shipping: 4803,
  notification: 4804,
};
const KIT_CONTAINER_PORT: Partial<Record<Service, number>> = {
  pricing: 4100,
  payment: 4001,
  inventory: 4002,
  shipping: 4003,
  notification: 4004,
};

// ----------------------------------------------------------------- docker ---

export class DockerError extends Error {}

/** Runs the docker CLI. Throws a DockerError with its stderr. */
export function docker(...args: string[]): string {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string; code?: string };
    if (e.code === "ENOENT") throw new DockerError("the docker CLI is not on your PATH. The tests need it (README §7).");
    const stderr = (e.stderr ?? "").trim();
    throw new DockerError(`docker ${args.join(" ")} failed: ${stderr || e.message}`);
  }
}

/** `docker compose -p <project> …`, in project mode only. */
function compose(...args: string[]): string {
  return docker("compose", "-p", PROJECT!, ...args);
}

interface Publisher {
  TargetPort: number;
  PublishedPort: number;
  Protocol: string;
}

/** Project mode: each service's published host port, from `docker compose -p <project> ps`. */
function discover(): Map<string, Publisher[]> {
  const out = compose("ps", "--all", "--format", "json");
  const rows: Array<{ Service: string; Publishers?: Publisher[] }> = out.startsWith("[")
    ? JSON.parse(out)
    : out
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
  return new Map(rows.map((r) => [r.Service, (r.Publishers ?? []).filter((p) => p.PublishedPort > 0 && p.Protocol === "tcp")]));
}

let discovered: Map<string, Publisher[]> | undefined;

/** The host port of a service: fixed, or discovered in project mode. */
function hostPort(service: string, fixed: number, containerPort?: number): number {
  if (!PROJECT) return fixed;
  discovered ??= discover();
  const publishers = discovered.get(service) ?? [];
  const match = containerPort === undefined ? publishers : publishers.filter((p) => p.TargetPort === containerPort);
  if (match.length === 0) {
    throw new DockerError(
      `project ${PROJECT}: service ${service} publishes no port${containerPort ? ` for ${containerPort}` : ""}. Is the stack up?`,
    );
  }
  return match[0]!.PublishedPort;
}

const HOST = env("CAP_HOST") ?? "localhost";

function url(service: Exclude<Service, "rabbitmq">): string {
  const override = env(`CAP_${service.toUpperCase()}_URL`);
  if (override) return override.replace(/\/+$/, "");
  return `http://${HOST}:${hostPort(service, HOST_PORT[service], KIT_CONTAINER_PORT[service])}`;
}

/** Base URLs, resolved on first use (project mode runs `docker compose ps`). */
export const T = {
  get intake() {
    return url("intake");
  },
  get observer() {
    return url("observer");
  },
  get orchestrator() {
    return url("orchestrator");
  },
  get notifier() {
    return url("notifier");
  },
  get pricing() {
    return url("pricing");
  },
  get payment() {
    return url("payment");
  },
  get inventory() {
    return url("inventory");
  },
  get shipping() {
    return url("shipping");
  },
  get notification() {
    return url("notification");
  },
  get amqp() {
    return env("CAP_AMQP_URL") ?? `amqp://eai:eai-capstone@${HOST}:${hostPort("rabbitmq", 5680, 5672)}`;
  },
  get management() {
    return (env("CAP_MANAGEMENT_URL") ?? `http://${HOST}:${hostPort("rabbitmq", 15680, 15672)}`).replace(/\/+$/, "");
  },
};

export const urlOf = (service: Exclude<Service, "rabbitmq">): string => url(service);

/** The container name a person would use: cap-<service>, or its override. */
export function containerName(service: Service): string {
  return env(`CAP_CONTAINER_${service.toUpperCase()}`) ?? `cap-${service}`;
}

/**
 * Container actions, by name (`docker stop cap-notifier`) or, in project mode,
 * by project (`docker compose -p <project> stop notifier`).
 */
export const containers = {
  stop: (service: Service) => (PROJECT ? compose("stop", service) : docker("stop", containerName(service))),
  // A started container can get a new ephemeral host port: discover again.
  start: (service: Service) => (PROJECT ? ((discovered = undefined), compose("start", service)) : docker("start", containerName(service))),
  restart: (service: Service) =>
    PROJECT ? ((discovered = undefined), compose("restart", service)) : docker("restart", containerName(service)),
  kill: (service: Service) => (PROJECT ? compose("kill", service) : docker("kill", containerName(service))),
  /** The container id, for `docker inspect` and `docker cp`. */
  id: (service: Service) => (PROJECT ? compose("ps", "--all", "-q", service) : containerName(service)),
  exec: (service: Service, ...command: string[]) =>
    PROJECT ? compose("exec", "-T", service, ...command) : docker("exec", containerName(service), ...command),
};
