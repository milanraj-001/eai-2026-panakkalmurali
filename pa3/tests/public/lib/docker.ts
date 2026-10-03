/**
 * Controls individual containers of the already-running Compose stack, so
 * a test can simulate "one worker never responds" by actually stopping
 * that worker for the duration of the test, then bringing it back.
 */

import { execFileSync } from "node:child_process";
import { PA3_ROOT } from "./env.js";

function compose(...args: string[]): void {
  execFileSync("docker", ["compose", ...args], {
    cwd: PA3_ROOT,
    stdio: "pipe",
  });
}

// pika's blocking consume loop does not react to SIGTERM, so a plain
// `docker compose stop` eats the full default 10s grace period per
// container before Compose falls back to SIGKILL. Stopping several
// containers in one call lets Compose do that concurrently instead of
// sequentially, and a short --timeout keeps it fast either way.
export function stopService(...serviceNames: string[]): void {
  compose("stop", "--timeout", "2", ...serviceNames);
}

export function startService(...serviceNames: string[]): void {
  compose("start", ...serviceNames);
}

// Every service a test might stop to simulate "worker never responds".
// Starting an already-running container is a harmless no-op, so this is
// safe to call defensively at the top of a test file in case a previous
// run crashed between stopping a worker and restarting it.
const ALL_WORKERS = [
  "router-service",
  "inventory-worker",
  "digital-worker",
  "subscription-worker",
  "aggregator-service",
];

export function ensureAllWorkersRunning(): void {
  compose("start", ...ALL_WORKERS);
}
