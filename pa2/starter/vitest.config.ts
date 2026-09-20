import { defineConfig } from "vitest/config";

// The tests live outside this folder, in pa2/tests/. Public tests ship with
// the assignment; the grader drops additional hidden tests into
// pa2/tests/hidden/ at grading time, and this glob picks those up too.
//
// These tests drive real containers (RabbitMQ, the producer, the consumer)
// through `docker restart`, `docker stop`/`start` and the management API.
// Two settings that matter because of that, not because of the test code
// itself:
//
//   - fileParallelism is off: every test file shares the same broker, queue
//     and received.jsonl. Running files concurrently would let one test's
//     `docker stop pa2-consumer` land in the middle of another test's
//     delivery check.
//   - testTimeout/hookTimeout are generous: a broker restart genuinely takes
//     several seconds to become healthy again, and the demonstrations wait
//     for that for real rather than mocking it away.
export default defineConfig({
  test: {
    include: ["../tests/**/*.test.ts"],
    reporters: ["verbose"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
