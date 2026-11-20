import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";

/** Stage files run in order: 0-… first, 6-… last. */
class ByStage extends BaseSequencer {
  async sort(files: Parameters<BaseSequencer["sort"]>[0]) {
    const id = (f: unknown) => (Array.isArray(f) ? String(f[1]) : String((f as { moduleId: string }).moduleId));
    return [...files].sort((a, b) => id(a).localeCompare(id(b)));
  }
}

export default defineConfig({
  test: {
    include: ["public/**/*.test.ts"],
    reporters: ["verbose"],
    // The slowest tests wait out three delivery attempts, or a stopped notifier.
    testTimeout: 90_000,
    hookTimeout: 60_000,
    // One stack and one set of mocks: the tests never run at the same time.
    fileParallelism: false,
    sequence: { sequencer: ByStage },
  },
});
