/**
 * Stage 6: the documents (README §6), checked for what a machine can check:
 * files, headings with text under them, links, table rows, diagrams. Your
 * reasoning is judged by hand (GRADING.md §5). No running stack is needed.
 *
 * A heading counts only with text of your own under it. The templates keep
 * their prompts in HTML comments (<!-- … -->), which do not count.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, test } from "vitest";
import {
  codeRefs,
  DOCS_DIR,
  hasText,
  isExternal,
  linkTargets,
  mermaidBlocks,
  missingHeadings,
  noProblems,
  readDoc,
  resolveLink,
  section,
  sections,
  stripComments,
  table,
} from "../lib/index.js";

const ADR_HEADINGS = ["Context", "Decision", "Alternatives considered", "Consequences"];
const AI_USAGE = ["Tools used", "What for", "What I changed or rejected", "What I verified, and how", "Dependencies beyond the allow-list"];
const AGENT_READINESS = ["Tools", "Injection paths", "Controls", "Not exposed"];
const ALERT_KEYS = [
  "dlq_not_empty",
  "invalid_not_empty",
  "saga_consumer_missing",
  "notifier_consumer_missing",
  "saga_consumer_lag",
  "notifier_consumer_lag",
  "stuck_sagas",
];
/** The exchanges and queues of README §3.2. */
const TOPOLOGY = [
  "orders.exchange",
  "orders.retry.exchange",
  "orders.return.exchange",
  "orders.dlq.exchange",
  "orders.invalid.exchange",
  "orders.outcome",
  "trace.events",
  "saga.queue",
  "saga.retry.queue",
  "notifications.queue",
  "notifications.retry.queue",
  "orders.dlq",
  "orders.invalid",
  "trace.store",
];

const report = (ids: string, problems: string[]) => noProblems(ids, problems, `in ${DOCS_DIR}:`);

describe("stage 6 · the documents", () => {
  test("P6.1 · the document files exist; ADR-007 to ADR-010 have their four headings; the ADR index links resolve; ai-usage.md and agent-readiness.md have their headings", () => {
    const problems: string[] = [];
    const FILES: Array<[string, string]> = [
      ["architecture.md", "R-6.1"],
      ["orchestration.bpmn", "R-6.2"],
      ["patterns.md", "R-6.3"],
      ["failure-analysis.md", "R-6.4"],
      ["runbook.md", "R-6.5"],
      ["agent-readiness.md", "R-6.6"],
      ["ai-usage.md", "R-6.7"],
      ["adr/README.md", "R-6.8"],
      ["adr/adr-007.md", "R-6.9"],
      ["adr/adr-008.md", "R-6.9"],
      ["adr/adr-009.md", "R-6.9"],
      ["adr/adr-010.md", "R-6.9"],
    ];
    for (const [file, id] of FILES) if (readDoc(file) === null) problems.push(`${id}: docs/${file} is missing`);

    for (const n of ["007", "008", "009", "010"]) {
      const md = readDoc(`adr/adr-${n}.md`);
      if (md === null) continue;
      const missing = missingHeadings(md, ADR_HEADINGS);
      if (missing.length) problems.push(`R-6.9: docs/adr/adr-${n}.md has no text under ${missing.map((h) => `\`## ${h}\``).join(", ")}`);
    }

    const index = readDoc("adr/README.md");
    if (index !== null) {
      const adrDir = path.join(DOCS_DIR, "adr");
      if (!table(index, ["link"]) && !stripComments(index).split("\n").some((l) => /^\s*\|.*\|/.test(l))) problems.push("R-6.8: docs/adr/README.md has no index table");
      const local = linkTargets(stripComments(index)).filter((t) => !isExternal(t) && !t.startsWith("#"));
      for (const target of local) if (!resolveLink(target, adrDir)) problems.push(`R-6.8: docs/adr/README.md links to ${target}, which does not exist`);
      for (let n = 0; n <= 10; n++) {
        const name = `adr-${String(n).padStart(3, "0")}.md`;
        if (!local.some((t) => path.basename(t.split("#")[0]!) === name)) problems.push(`R-6.8: docs/adr/README.md has no link to ${name}`);
      }
    }

    for (const [file, headings, id] of [
      ["ai-usage.md", AI_USAGE, "R-6.7"],
      ["agent-readiness.md", AGENT_READINESS, "R-6.6"],
    ] as const) {
      const md = readDoc(file);
      if (md === null) continue;
      const missing = missingHeadings(md, [...headings]);
      if (missing.length) problems.push(`${id}: docs/${file} has no text under ${missing.map((h) => `\`## ${h}\``).join(", ")}`);
    }
    report("R-6.1, R-6.2, R-6.3, R-6.4, R-6.5, R-6.6, R-6.7, R-6.8, R-6.9", problems);
  });

  test("P6.2 · the BPMN checks, the mermaid checks, the patterns.md rows and links, and a runbook section for each of the seven alert keys", () => {
    const problems: string[] = [];

    // R-6.2: real BPMN 2.0, with an exported picture.
    const bpmn = readDoc("orchestration.bpmn");
    if (bpmn === null) problems.push("R-6.2: docs/orchestration.bpmn is missing");
    else {
      const wellFormed = XMLValidator.validate(bpmn);
      if (wellFormed !== true) problems.push(`R-6.2: docs/orchestration.bpmn is not well-formed XML: ${wellFormed.err.msg} (line ${wellFormed.err.line})`);
      else {
        const doc = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, attributeNamePrefix: "@_" }).parse(bpmn);
        const found = new Map<string, any[]>();
        const walk = (name: string, node: unknown) => {
          for (const n of Array.isArray(node) ? node : [node]) {
            found.set(name, [...(found.get(name) ?? []), n]);
            if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) if (!k.startsWith("@_")) walk(k, v);
          }
        };
        for (const [k, v] of Object.entries(doc)) walk(k, v);
        const has = (name: string) => (found.get(name) ?? []).length > 0;
        if (!has("definitions") || !/xmlns(:\w+)?\s*=\s*"http:\/\/www\.omg\.org\/spec\/BPMN\/20100524\/MODEL"/.test(bpmn)) {
          problems.push("R-6.2: docs/orchestration.bpmn is not BPMN 2.0: expected a <definitions> root in the namespace http://www.omg.org/spec/BPMN/20100524/MODEL");
        }
        const errorBoundary = (found.get("boundaryEvent") ?? []).some((b) => b && typeof b === "object" && "errorEventDefinition" in b);
        if (!errorBoundary) problems.push("R-6.2: docs/orchestration.bpmn has no boundary event with an errorEventDefinition");
        const compensation =
          has("compensateEventDefinition") || [...found.values()].flat().some((n) => n && typeof n === "object" && String(n["@_isForCompensation"]) === "true");
        if (!compensation) problems.push("R-6.2: docs/orchestration.bpmn has no compensation: a compensateEventDefinition, or a task with isForCompensation=\"true\"");
        if (!has("exclusiveGateway")) problems.push("R-6.2: docs/orchestration.bpmn has no exclusiveGateway (the b2b branch)");
      }
    }
    if (!existsSync(path.join(DOCS_DIR, "orchestration.svg")) && !existsSync(path.join(DOCS_DIR, "orchestration.png"))) {
      problems.push("R-6.2: there is no exported picture, docs/orchestration.svg or docs/orchestration.png");
    }

    // R-6.1: two mermaid diagrams; the integration one names the topology.
    const arch = readDoc("architecture.md");
    if (arch === null) problems.push("R-6.1: docs/architecture.md is missing");
    else {
      for (const title of ["System context", "Integration architecture"]) {
        const s = section(arch, title);
        if (!s) problems.push(`R-6.1: docs/architecture.md has no \`## ${title}\``);
        else if (mermaidBlocks(s.body).length === 0) problems.push(`R-6.1: \`## ${title}\` in docs/architecture.md has no \`\`\`mermaid block`);
      }
      const integration = section(arch, "Integration architecture");
      const diagram = integration ? mermaidBlocks(integration.body).join("\n") : "";
      const named = TOPOLOGY.filter((name) => new RegExp(`(?<![\\w.-])${name.replace(/\./g, "\\.")}(?![\\w.-])`).test(diagram));
      if (integration && named.length < 6) {
        problems.push(`R-6.1: the integration architecture diagram names ${named.length} of the exchanges and queues in README §3.2 (${named.join(", ") || "none"}); at least 6`);
      }
    }

    // R-6.3: the pattern table.
    const patterns = readDoc("patterns.md");
    if (patterns === null) problems.push("R-6.3: docs/patterns.md is missing");
    else {
      const t = table(patterns, ["Pattern", "Problem", "Where", "Why"]);
      if (!t) problems.push("R-6.3: docs/patterns.md has no table with the columns Pattern | Problem | Where | Why");
      else {
        const col = (name: string) => t.header.indexOf(name.toLowerCase());
        const rows = t.rows.filter((r) => r.some((c) => c !== ""));
        if (rows.length < 8) problems.push(`R-6.3: the pattern table has ${rows.length} rows; at least 8`);
        if (!rows.some((r) => /normali[sz]er/i.test(r[col("Pattern")] ?? ""))) problems.push("R-6.3: the pattern table has no Normalizer row");
        for (const r of rows) {
          const name = (r[col("Pattern")] ?? "").replace(/[*_`]/g, "") || "(unnamed)";
          const refs = codeRefs(r[col("Where")] ?? "");
          if (refs.length === 0) problems.push(`R-6.3: the row "${name}" has no file:line link under Where`);
          for (const ref of refs.filter((x) => !x.ok)) problems.push(`R-6.3: the row "${name}" links to ${ref.ref}: ${ref.why}`);
        }
      }
    }

    // R-6.5: one section per alert key.
    const runbook = readDoc("runbook.md");
    if (runbook === null) problems.push("R-6.5: docs/runbook.md is missing");
    else {
      const all = sections(runbook);
      for (const key of ALERT_KEYS) {
        const s = all.find((x) => x.level >= 2 && x.title.replace(/[`*\\]/g, "").includes(key));
        if (!s) problems.push(`R-6.5: docs/runbook.md has no section (a heading) for ${key}`);
        else if (!hasText(s.body)) problems.push(`R-6.5: the ${key} section of docs/runbook.md has no text`);
      }
    }
    report("R-6.1, R-6.2, R-6.3, R-6.5", problems);
  });
});
