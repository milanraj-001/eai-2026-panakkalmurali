/**
 * The test library. The public tests import everything from here.
 *
 *   targets   where your system is (README §7: the CAP_* variables)
 *   http      requests, polling, and the wording of failure messages
 *   mocks     /admin/config, /admin/logs, /admin/effects on the kit's mocks
 *   broker    raw publish, spy queues, exact queue counts, drain
 *   orders    fixtures with fresh orderIds, POST /orders, GET /orders, GET /trace
 *   schemas   the JSON Schemas in grading/schema/
 *   docs      reading docs/ for the stage 6 checks
 */
import { afterAll, beforeEach } from "vitest";
import { closeBroker, drain } from "./broker.js";
import { resetMocks } from "./mocks.js";

export * from "./broker.js";
export * from "./docs.js";
export * from "./http.js";
export * from "./mocks.js";
export * from "./orders.js";
export * from "./schemas.js";
export * from "./targets.js";

/**
 * For a test file that runs orders through the stack. Before each test: wait
 * until the saga and notifier queues are drained, then reset every mock. The
 * tests run one at a time, because they share one stack and one set of mocks.
 */
export function useStack(): void {
  beforeEach(async () => {
    await drain();
    await resetMocks();
  });
  afterAll(async () => {
    await closeBroker();
  });
}
