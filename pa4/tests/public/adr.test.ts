/**
 * PA4 public tests — the ADR is required. See docs/adr-003.md's template
 * and README.md's "Your ADR" section for what goes under each heading.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PA4_ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("assignment requirements", () => {
  it("has an ADR with the four required sections", () => {
    const adr = readFileSync(path.join(PA4_ROOT, "docs", "adr-003.md"), "utf8");
    expect(adr).toContain("## Context");
    expect(adr).toContain("## Decision");
    expect(adr).toContain("## Alternatives considered");
    expect(adr).toContain("## Consequences");
  });
});
