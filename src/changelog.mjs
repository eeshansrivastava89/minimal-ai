import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { wrapText, maxWidth, theme, screenHeader } from "./ui.mjs";
import { compareVersions, currentPackageVersion } from "./updates.mjs";
import { loadConfig, saveConfig } from "./config.mjs";

const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/eeshansrivastava89/minimal-ai";

function parseChangelog(content) {
  const lines = content.split("\n");
  const entries = [];
  let currentVersion = null;
  let currentDate = null;
  let currentLines = [];

  for (const line of lines) {
    const match = line.match(/^##\s+\[?(\d+\.\d+\.\d+)\]?(?:\s+-\s+(.+))?$/);
    if (match) {
      if (currentVersion && currentLines.length > 0) {
        entries.push({
          version: currentVersion,
          date: currentDate ?? "",
          content: currentLines.join("\n").trim(),
        });
      }
      currentVersion = match[1];
      currentDate = match[2] ?? null;
      currentLines = [];
    } else if (currentVersion) {
      currentLines.push(line);
    }
  }

  if (currentVersion && currentLines.length > 0) {
    entries.push({
      version: currentVersion,
      date: currentDate ?? "",
      content: currentLines.join("\n").trim(),
    });
  }

  return entries;
}

export function entriesBetween(entries, fromVersion, toVersion) {
  return entries
    .filter((e) => {
      if (toVersion) {
        return compareVersions(e.version, fromVersion) > 0
          && compareVersions(e.version, toVersion) <= 0;
      }
      return compareVersions(e.version, fromVersion) > 0;
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}

function readLocalChangelog() {
  if (!existsSync(CHANGELOG_PATH)) return [];
  try {
    const content = readFileSync(CHANGELOG_PATH, "utf-8");
    return parseChangelog(content);
  } catch {
    return [];
  }
}

export async function fetchRemoteChangelog(tag, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const url = `${GITHUB_RAW_BASE}/${tag}/CHANGELOG.md`;
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return [];
    const content = await response.text();
    return parseChangelog(content);
  } catch {
    return [];
  }
}

// Format inline markdown spans — **bold** and `code` — into themed strings.
// wrapText measures with visibleLen (ANSI stripped), so it wraps the styled
// text correctly without breaking mid-escape.
function formatInline(text) {
  const segments = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/);
  return segments.map((seg) => {
    if (seg.startsWith("**") && seg.endsWith("**")) return theme.bold(seg.slice(2, -2));
    if (seg.startsWith("`") && seg.endsWith("`")) return theme.subtle(seg.slice(1, -1));
    return seg;
  }).join("");
}

// Wrap one bullet paragraph (already joined across the markdown's hand-wrapped
// lines) at the available width. Top-level bullets render "  - ", nested
// bullets render with 4 more spaces of indent (`indent` = leading spaces in
// the markdown source).
function renderBullet(text, width, indent = 0) {
  const wrapped = wrapText(formatInline(text), Math.max(8, width - indent));
  const pad = " ".repeat(indent);
  return wrapped.map((l, i) => (i === 0 ? `${pad}  - ${l}` : `${pad}    ${l}`));
}

/**
 * Render one changelog entry's markdown body into wrapped, indented lines
 * (pure — no printing). Nested bullets stay nested bullets; they are never
 * absorbed into a parent paragraph as stray "- " fragments.
 */
export function renderEntryBody(entry, width = maxWidth() - 2) {
  const inner = width;
  const bulletWidth = inner - 4;   // "  - " prefix / 4-space continuation
  const paraWidth = inner - 2;     // "  " indent for non-bullet paragraphs

  const bodyLines = [];
  const lines = entry.content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("### ")) {
      if (bodyLines.length > 0) bodyLines.push("");
      bodyLines.push(theme.bold(theme.warning(line.replace(/^###\s+/u, ""))));
      i++;
      continue;
    }
    const bullet = line.match(/^(\s*)-\s+/u);
    if (bullet) {
      // A bullet is the "- " line plus its continuation lines (indented, but
      // NOT another bullet). Join them into one paragraph before wrapping,
      // so the markdown's own hand-wrapping isn't re-wrapped per line.
      const indent = bullet[1].length;
      const parts = [line.replace(/^\s*-\s+/u, "")];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (!next.trim() || next.startsWith("### ") || /^\s*-\s/u.test(next)) break;
        parts.push(next.replace(/^\s+/u, ""));
        i++;
      }
      bodyLines.push(...renderBullet(parts.join(" ").trim(), bulletWidth, indent));
      continue;
    }
    // Non-bullet, non-header paragraph (rare in our changelog).
    bodyLines.push(...wrapText(formatInline(line), paraWidth).map((l) => `  ${l}`));
    i++;
  }
  return bodyLines.join("\n");
}

export function printReleaseNotes(entries) {
  if (!entries || entries.length === 0) return;

  // No box chrome — a bold version heading over the wrapped body, wrapped
  // near the terminal width so the right of a wide terminal isn't empty
  // padding.
  const width = maxWidth() - 2;

  for (const entry of entries) {
    console.log(theme.bold(`v${entry.version}${entry.date ? ` — ${entry.date}` : ""}`));
    console.log(renderEntryBody(entry, width));
    console.log("");
  }
}

export async function showReleaseNotesIfUpdated() {
  const current = currentPackageVersion();
  const config = await loadConfig();
  const lastSeen = config.lastSeenVersion;

  if (!lastSeen) {
    config.lastSeenVersion = current;
    await saveConfig(config);
    return;
  }

  if (compareVersions(current, lastSeen) <= 0) return;

  const entries = readLocalChangelog();
  const notes = entriesBetween(entries, lastSeen, current);
  if (notes.length > 0) {
    console.log(screenHeader({ title: "What's new" }));
    printReleaseNotes(notes);
  }

  config.lastSeenVersion = current;
  await saveConfig(config);
}
