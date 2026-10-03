import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PA3_ROOT } from "./lib/env.js";

describe("assignment requirements", () => {
  it("has an ADR with the four required sections", () => {
    const adrPath = path.join(PA3_ROOT, "docs", "adr-002.md");
    const adr = readFileSync(adrPath, "utf8");
    expect(adr).toContain("## Context");
    expect(adr).toContain("## Decision");
    expect(adr).toContain("## Alternatives considered");
    expect(adr).toContain("## Consequences");
  });
});
