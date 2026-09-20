/**
 * PA2 public tests — the ADR is a graded artefact, same as PA1.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PA2_ROOT } from "./support";

describe("assignment requirements", () => {
  it("has an ADR with the four required sections", () => {
    const adrPath = path.join(PA2_ROOT, "docs", "adr-001.md");
    let adr: string;
    try {
      adr = readFileSync(adrPath, "utf8");
    } catch {
      throw new Error(`docs/adr-001.md is missing (looked at ${adrPath})`);
    }
    expect(adr).toContain("## Context");
    expect(adr).toContain("## Decision");
    expect(adr).toContain("## Alternatives considered");
    expect(adr).toContain("## Consequences");
  });
});
