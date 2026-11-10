import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// tests/public/adr.test.ts -> pa7/
const PA7_ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("assignment requirements", () => {
  it("13) has an ADR with the four sections, and names at least three things the engine took over", () => {
    const adr = readFileSync(path.join(PA7_ROOT, "docs", "adr-006.md"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    expect(adr).toContain("## Context");
    expect(adr).toContain("## Decision");
    expect(adr).toContain("## Alternatives considered");
    expect(adr).toContain("## Consequences");

    const heading = "## What the engine took over";
    expect(adr).toContain(heading);
    const section = adr.slice(adr.indexOf(heading) + heading.length).split(/^## /m)[0] ?? "";
    const items = section.split("\n").filter((line) => /^\s*([-*]|\d+\.)\s+\S/.test(line));
    expect(items.length, `list at least three items under "${heading}"`).toBeGreaterThanOrEqual(3);
  });
});
