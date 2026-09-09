import { defineConfig } from "vitest/config";

// The tests live outside this folder, in pa1/tests/. Public tests ship with
// the assignment; the grader drops additional hidden tests into
// pa1/tests/hidden/ at grading time, and this glob picks those up too.
export default defineConfig({
  test: {
    include: ["../tests/**/*.test.ts"],
    reporters: ["verbose"],
  },
});
