import { defineConfig } from "vitest/config";

// Public tests live in ./public and ship with the assignment. The include
// pattern also picks up ./hidden, where the grading box drops its own tests.
export default defineConfig({
  test: {
    include: ["public/**/*.test.ts", "hidden/**/*.test.ts"],
    reporters: ["verbose"],
    // The slowest tests wait out three timed-out attempts, or a worker that
    // is killed and started again.
    testTimeout: 90_000,
    hookTimeout: 60_000,
    // One shared Docker Compose stack: the tests reconfigure the same mocks
    // and kill the same worker, so they must never run concurrently.
    fileParallelism: false,
  },
});
