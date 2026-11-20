/**
 * Reading capstone/docs/ for the stage 6 checks (README §6). These checks
 * need no running stack.
 *
 * A heading counts only with text under it: HTML comments (<!-- … -->), which
 * is where the templates keep their prompts, do not count as text.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { SUBMISSION_DIR } from "./targets.js";

export const DOCS_DIR = path.join(SUBMISSION_DIR, "docs");

/** A file under docs/, or null when it does not exist. */
export function readDoc(relative: string): string | null {
  const file = path.join(DOCS_DIR, relative);
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : null;
}

export const stripComments = (md: string) => md.replace(/<!--[\s\S]*?-->/g, "");

interface Section {
  level: number;
  title: string;
  body: string;
}

/** Every ATX heading (## …) and the text up to the next heading of the same or a higher level. Fenced code is not scanned for headings. */
export function sections(md: string): Section[] {
  const lines = stripComments(md).split(/\r?\n/);
  const heads: Array<{ line: number; level: number; title: string }> = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) heads.push({ line: i, level: h[1]!.length, title: h[2]! });
  });
  return heads.map((h, k) => {
    const end = heads.slice(k + 1).find((n) => n.level <= h.level)?.line ?? lines.length;
    return { level: h.level, title: h.title, body: lines.slice(h.line + 1, end).join("\n") };
  });
}

const norm = (s: string) => s.replace(/[`*_]/g, "").trim().toLowerCase();

/** True when the section has a line of its own text: not blank, not a heading. */
export function hasText(body: string): boolean {
  return body.split(/\r?\n/).some((line) => line.trim() !== "" && !/^#{1,6}\s/.test(line));
}

/** The level-2 section with exactly this title (case, backticks and emphasis ignored). */
export function section(md: string, title: string): Section | undefined {
  return sections(md).find((s) => s.level === 2 && norm(s.title) === norm(title));
}

/** The required `## headings` that are missing or have no text under them. */
export function missingHeadings(md: string, titles: string[]): string[] {
  return titles.filter((t) => {
    const s = section(md, t);
    return !s || !hasText(s.body);
  });
}

/** The contents of every ```mermaid block in a piece of markdown. */
export function mermaidBlocks(md: string): string[] {
  const out: string[] = [];
  const re = /^\s*(`{3,}|~{3,})\s*mermaid\b[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm;
  for (let m = re.exec(md); m; m = re.exec(md)) out.push(m[2]!);
  return out;
}

/** A GFM table: the header cells and the data rows. The first table whose header has every column named. */
export function table(md: string, columns: string[]): { header: string[]; rows: string[][] } | null {
  const lines = stripComments(md).split(/\r?\n/);
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i]!.includes("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1]!)) continue;
    const header = cells(lines[i]!).map(norm);
    if (!columns.every((c) => header.includes(norm(c)))) continue;
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length && lines[j]!.includes("|") && lines[j]!.trim() !== ""; j++) rows.push(cells(lines[j]!));
    return { header, rows };
  }
  return null;
}

/** Targets of the markdown links in a piece of text: [text](target). */
export function linkTargets(text: string): string[] {
  const out: string[] = [];
  const re = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1]!);
  return out;
}

export const isExternal = (target: string) => /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target);

/** Resolves a relative link from a folder. Returns the file, or null when it does not exist. */
export function resolveLink(target: string, fromDir: string): string | null {
  const file = path.resolve(fromDir, decodeURIComponent(target.split("#")[0]!));
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

export interface CodeRef {
  ref: string;
  ok: boolean;
  why?: string;
}

/**
 * The `file:line` references in a pattern table's Where cell: a link to
 * `file#L42` (or `#L42-L50`, or `file:42`), or a bare `path/to/file.ts:42`.
 * Links resolve from docs/; bare paths from capstone/, then from docs/.
 */
export function codeRefs(cell: string): CodeRef[] {
  const refs: CodeRef[] = [];
  const check = (ref: string, file: string | null, line: number | null): CodeRef => {
    if (!file) return { ref, ok: false, why: "no such file" };
    if (line === null) return { ref, ok: false, why: "no line number" };
    const count = readFileSync(file, "utf8").split(/\r?\n/).length;
    if (line < 1 || line > count) return { ref, ok: false, why: `the file has ${count} lines` };
    return { ref, ok: true };
  };
  const linked = linkTargets(cell);
  for (const target of linked) {
    if (isExternal(target)) {
      refs.push({ ref: target, ok: false, why: "not a file in your repository" });
      continue;
    }
    const m = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?:-\d+)?)?$/.exec(target)!;
    const line = m[2] ?? m[3];
    refs.push(check(target, resolveLink(m[1]!, DOCS_DIR), line ? Number(line) : null));
  }
  const bare = cell.replace(/\[[^\]]*\]\([^)]*\)/g, " ");
  const re = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)/g;
  for (let m = re.exec(bare); m; m = re.exec(bare)) {
    const file = resolveLink(m[1]!, SUBMISSION_DIR) ?? resolveLink(m[1]!, DOCS_DIR);
    refs.push(check(`${m[1]}:${m[2]}`, file, Number(m[2])));
  }
  return refs;
}
