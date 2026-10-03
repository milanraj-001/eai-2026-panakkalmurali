/**
 * Shared constants for the PA3 black-box tests.
 *
 * Everything here can be overridden with an environment variable so the
 * same suite runs unchanged whether docker-compose.yml is using its
 * default ports or something a grading box remapped.
 */

import { fileURLToPath } from "node:url";

// tests/public/lib/env.ts -> pa3/
export const PA3_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const ORDER_API_URL =
  process.env.ORDER_API_URL ?? "http://localhost:8083";

export const RABBITMQ_AMQP_URL =
  process.env.RABBITMQ_AMQP_URL ?? "amqp://guest:guest@localhost:5672";

export const RABBITMQ_MGMT_URL =
  process.env.RABBITMQ_MGMT_URL ?? "http://localhost:15672";

export const RABBITMQ_MGMT_USER = process.env.RABBITMQ_MGMT_USER ?? "guest";
export const RABBITMQ_MGMT_PASS = process.env.RABBITMQ_MGMT_PASS ?? "guest";

// Must match AGGREGATOR_IDLE_TIMEOUT_SECONDS in docker-compose.yml. Tests
// that exercise the timeout wait a comfortable margin past this.
export const AGGREGATOR_IDLE_TIMEOUT_SECONDS = Number(
  process.env.AGGREGATOR_IDLE_TIMEOUT_SECONDS ?? "5",
);

export const QUEUES = {
  incoming: "orders.incoming",
  physical: "orders.physical",
  digital: "orders.digital",
  subscription: "orders.subscription",
  results: "orders.results",
  complete: "orders.complete",
} as const;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
