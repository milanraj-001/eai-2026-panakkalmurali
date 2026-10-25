import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// tests/public/adr.test.ts -> pa5/
const PA5_ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("assignment requirements", () => {
  it("has an ADR with the four required sections", () => {
    const adrPath = path.join(PA5_ROOT, "docs", "adr-004.md");
    const adr = readFileSync(adrPath, "utf8");
    expect(adr).toContain("## Context");
    expect(adr).toContain("## Decision");
    expect(adr).toContain("## Alternatives considered");
    expect(adr).toContain("## Consequences");
  });
});
