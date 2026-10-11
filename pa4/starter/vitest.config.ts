import { defineConfig } from "vitest/config";

// The tests live outside this folder, in pa4/tests/. Public tests ship with
// the assignment; the grader drops additional hidden tests into
// pa4/tests/hidden/ at grading time, and this glob picks those up too.
//
// The public tests expect the mock-pricing service from ../docker-compose.yml
// to already be running on http://localhost:4100 (`docker compose up -d --wait`
// before `npm test`).
export default defineConfig({
  test: {
    include: ["../tests/**/*.test.ts"],
    reporters: ["verbose"],
    testTimeout: 15000,
    // Several test files drive the SAME running mock-pricing container
    // through its admin endpoints (override a price, force a 500, reset).
    // Vitest runs test FILES in parallel by default; two files mutating that
    // one shared external service's state at the same time is a race, not a
    // flake to retry away. Running files sequentially makes the suite's
    // outcome depend only on your code, not on worker scheduling.
    fileParallelism: false,
    // ajv is CJS-only and its dist/ajv.js does its own relative requires
    // ("./core", ...) — Vitest's default SSR externalization mis-resolves
    // those on some setups. Pre-bundling it with esbuild (same mechanism
    // Vite's dev server uses for deps) resolves those requires once, ahead
    // of time, instead of at runtime through a require shim.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["ajv", "ajv-formats"],
        },
      },
    },
  },
});
