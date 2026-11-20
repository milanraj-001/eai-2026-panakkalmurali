// Runs the public tests of stages 0 to N, in order (README §2 and §7):
//
//   npm --prefix tests run test:stage -- 3     stages 0, 1, 2 and 3
//   npm --prefix tests run test:stage          every stage, 0 to 6
//
// Anything after N goes to vitest as it is, for example `-t P1.3` to run one test.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const last = /^\d+$/.test(args[0] ?? "") ? Number(args.shift()) : 6;
if (last > 6) {
  console.error(`There is no stage ${last}. The stages are 0 to 6.`);
  process.exit(2);
}

const files = readdirSync(path.join(here, "public"))
  .filter((f) => /^\d-.*\.test\.ts$/.test(f) && Number(f[0]) <= last)
  .sort()
  .map((f) => `public/${f}`);

console.log(`Stages 0–${last}: ${files.map((f) => path.basename(f, ".test.ts")).join(", ")}\n`);
const vitest = path.join(here, "node_modules", "vitest", "vitest.mjs");
const run = spawnSync(process.execPath, [vitest, "run", ...files, ...args], { cwd: here, stdio: "inherit" });
if (run.error) {
  console.error(`Could not start vitest (${run.error.message}). Run \`npm --prefix tests ci\` first.`);
  process.exit(2);
}
process.exit(run.status ?? 1);
