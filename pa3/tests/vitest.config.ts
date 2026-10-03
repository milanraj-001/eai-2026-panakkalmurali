import { defineConfig } from "vitest/config";

// Public tests live in ./public and ship with the assignment. The grader
// drops additional hidden tests into ./hidden at grading time (mirroring
// pa1's tests/hidden/ pattern) -- this glob picks those up too, with no
// config change needed on the student's side. A missing ./hidden simply
// contributes no extra files.
export default defineConfig({
  test: {
    include: ["public/**/*.test.ts", "hidden/**/*.test.ts"],
    reporters: ["verbose"],
    // The full suite drives real HTTP/AMQP traffic through Docker
    // containers and deliberately waits out an aggregator timeout more
    // than once -- give it more room than vitest's 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // These tests share one Docker Compose stack (stopping/starting
    // worker containers, draining shared queues) -- running test files
    // concurrently would race on that shared state.
    fileParallelism: false,
  },
});
