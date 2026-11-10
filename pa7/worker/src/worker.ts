/**
 * PA7 Temporal worker. GIVEN — you should not need to change this file.
 *
 * It connects to the Temporal server, registers your activities and your
 * workflow, and polls the "checkout" task queue. The api starts a workflow;
 * Temporal puts its tasks on that queue; this process picks them up.
 *
 * Kill this container mid-saga and nothing is lost: the workflow's history is
 * in Temporal, not here. When a worker comes back, it replays the history to
 * rebuild the workflow's state and carries on from the step it was on.
 */
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import { TASK_QUEUE } from "./types";

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect(): Promise<NativeConnection> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(`[worker] Temporal at ${TEMPORAL_ADDRESS} not reachable yet (attempt ${attempt}), retrying`);
      await sleep(1000);
    }
  }
}

async function main(): Promise<void> {
  const connection = await connect();
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    // Temporal bundles this file, and everything it imports, into its
    // deterministic sandbox. That is why the workflow may import types from
    // ../activities but must never call them directly.
    workflowsPath: require.resolve("./workflows/checkout"),
    activities,
  });
  console.log(`[worker] polling task queue "${TASK_QUEUE}" on ${TEMPORAL_ADDRESS}`);
  await worker.run();
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
