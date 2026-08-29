// Changelog convention linter (Pi-style entries).
//
// Enforces the structural rules of CHANGELOG.md for every entry >= 3.0.0
// (older entries are grandfathered history). Runs as part of `npm test`,
// so CI blocks a release whose changelog entry breaks the convention.
//
// Rules (see AGENTS.md "Changelog"):
//   - Sections from {Breaking Changes, Added, Changed, Fixed, Removed},
//     each at most once, in that order.
//   - One bullet = one fact = one source line (no hand-wrapped continuations).
//   - No bold-headline bullet leads ("**The CLI has no more boxes.** ...").
//   - No nested bullets — flatten.
//   - Bullet visible length <= 280 chars (one sentence + optional issue link).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const MIN_ENFORCED_VERSION = [3, 0, 0];
const MAX_BULLET_CHARS = 280;

const SECTION_ORDER = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"];
const HEADER_RE = /^##\s+\[?(\d+\.\d+\.\d+)\]?(?:\s+-\s+(.+))?$/;
const SECTION_RE = /^###\s+(.+?)\s*$/;
const BULLET_RE = /^(\s*)-\s+/u;

function versionAtLeast(version, min) {
  const [a, b, c] = version.split(".").map(Number);
  return a > min[0] || (a === min[0] && b > min[1]) || (a === min[0] && b === min[1] && c >= min[2]);
}

function parseEntries(content) {
  const entries = [];
  let current = null;
  for (const line of content.split("\n")) {
    const match = line.match(HEADER_RE);
    if (match) {
      if (current) entries.push(current);
      current = { version: match[1], date: match[2] ?? null, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) entries.push(current);
  return entries;
}

// Visible length: strip markdown emphasis/code and any issue/PR link suffix.
function visibleLength(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .length;
}

function lintEntry(entry) {
  const errors = [];
  const label = `v${entry.version}`;
  const lines = entry.lines;
  const seenSections = [];
  let currentSection = null;
  let bulletIndex = 0;
  let i = 0;

  const bulletErr = (msg) =>
    errors.push(`${label} › ${currentSection ?? "entry"} › bullet ${bulletIndex}: ${msg}`);

  while (i < lines.length) {
    const line = lines[i];

    const section = line.match(SECTION_RE);
    if (section) {
      const name = section[1];
      if (!SECTION_ORDER.includes(name)) {
        errors.push(`${label}: unknown section "### ${name}" (allowed: ${SECTION_ORDER.join(", ")})`);
      } else if (seenSections.includes(name)) {
        errors.push(`${label}: duplicate section "### ${name}" (each section appears at most once)`);
      } else if (seenSections.some((s) => SECTION_ORDER.indexOf(s) > SECTION_ORDER.indexOf(name))) {
        errors.push(`${label}: section "### ${name}" out of order (order: ${SECTION_ORDER.join(", ")})`);
      }
      if (!seenSections.includes(name)) seenSections.push(name);
      currentSection = name;
      bulletIndex = 0;
      i++;
      continue;
    }

    const bullet = line.match(BULLET_RE);
    if (bullet) {
      bulletIndex++;
      const indent = bullet[1].length;
      const text = line.slice(line.indexOf("-") + 1).trim();

      if (indent > 0) bulletErr(`nested bullet (indent ${indent}) — flatten to a top-level bullet`);
      if (text.startsWith("**")) bulletErr(`bold-headline lead — bullets state the fact, no "**" lead`);
      const len = visibleLength(text);
      if (len > MAX_BULLET_CHARS) bulletErr(`${len} visible chars (max ${MAX_BULLET_CHARS}) — one fact per bullet`);

      // Continuation lines: an indented non-bullet, non-header line right
      // after a bullet means the bullet was hand-wrapped in the source.
      let j = i + 1;
      let joined = 0;
      while (j < lines.length) {
        const next = lines[j];
        if (!next.trim() || next.match(SECTION_RE) || next.match(BULLET_RE) || next.match(HEADER_RE)) break;
        joined += next.trim().length;
        j++;
      }
      if (joined > 0) {
        bulletErr(`hand-wrapped continuation (${joined} chars on following lines) — a bullet is one source line`);
      }
      i = j;
      continue;
    }

    i++;
  }

  return errors;
}

export function lintChangelog(content) {
  const errors = [];
  for (const entry of parseEntries(content)) {
    if (versionAtLeast(entry.version, MIN_ENFORCED_VERSION)) {
      errors.push(...lintEntry(entry));
    }
  }
  return errors;
}

function main() {
  const content = readFileSync(CHANGELOG_PATH, "utf-8");
  const errors = lintChangelog(content);
  if (errors.length === 0) {
    console.log("check-changelog: CHANGELOG.md entries (>= 3.0.0) pass the convention.");
    return 0;
  }
  console.error(`check-changelog: ${errors.length} convention violation(s) in CHANGELOG.md:\n`);
  for (const err of errors) console.error(`  ✗ ${err}`);
  console.error("\nConvention (AGENTS.md › Changelog): one bullet = one fact = one source line,");
  console.error("verb-first, no bold leads, no nesting, sections Added → Changed → Fixed → Removed.");
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}