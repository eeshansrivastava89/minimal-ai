// Changelog parsing and release notes display.
// Reads CHANGELOG.md (bundled in the npm package) and extracts entries
// for specific versions. Used by the startup flow to show "what's new"
// after an update, and by the update checker to preview coming changes.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pc, renderCard, wrapText } from "./ui.mjs";
import { compareVersions, currentPackageVersion } from "./updates.mjs";
import { loadConfig, saveConfig } from "./config.mjs";

const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai";

/**
 * Parse a CHANGELOG.md file into version entries.
 * Expects format: `## [x.y.z] - YYYY-MM-DD` headers followed by content.
 * @param {string} content - raw CHANGELOG.md content
 * @returns {Array<{version: string, date: string, content: string}>}
 */
export function parseChangelog(content) {
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

/**
 * Get changelog entries between two versions (exclusive from, inclusive to).
 * @param {Array} entries - from parseChangelog()
 * @param {string} fromVersion - exclude this and older
 * @param {string} toVersion - include up to this (defaults to latest)
 * @returns {Array} filtered entries, newest first
 */
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

/**
 * Read and parse the local CHANGELOG.md bundled with the installed package.
 * @returns {Array} parsed entries, or empty array if file not found
 */
export function readLocalChangelog() {
  if (!existsSync(CHANGELOG_PATH)) return [];
  try {
    const content = readFileSync(CHANGELOG_PATH, "utf-8");
    return parseChangelog(content);
  } catch {
    return [];
  }
}

/**
 * Fetch CHANGELOG.md from GitHub for a specific tag.
 * Used when an update is available — fetches the new version's changelog
 * before the user has installed it.
 * @param {string} tag - git tag (e.g. "v0.19.0")
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - fetch implementation (for testing)
 * @returns {Promise<Array>} parsed entries, or empty array on failure
 */
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

/**
 * Render a single changelog bullet line as formatted terminal text.
 * Strips markdown bold markers (**text**) and converts to picocolors bold.
 * Wraps to the given width with hanging indent.
 * @returns {string[]} array of terminal lines
 */
function renderBulletLine(line, width) {
  // Strip the leading "- " and any leading whitespace
  const text = line.replace(/^-\s+/, "");
  // Convert **bold** markers to pc.bold, leave rest as-is
  const segments = text.split(/(\*\*[^*]+\*\*)/);
  const formatted = segments.map((seg) => {
    if (seg.startsWith("**") && seg.endsWith("**")) {
      return pc.bold(seg.slice(2, -2));
    }
    return seg;
  }).join("");
  // Wrap the formatted text with 2-space indent on all lines
  const wrapped = wrapText(formatted, width - 4);
  return wrapped.map((l, i) => i === 0 ? `  - ${l}` : `    ${l}`);
}

/**
 * Print release notes to the terminal as a styled card.
 * @param {Array} entries - from parseChangelog/entriesBetween
 */
export function printReleaseNotes(entries) {
  if (!entries || entries.length === 0) return;
  const maxCols = process.stdout.columns ?? 88;
  const contentWidth = maxCols - 4; // card border + padding

  for (const entry of entries) {
    const bodyLines = [];
    const lines = entry.content.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      if (line.startsWith("### ")) {
        const label = line.replace(/^###\s+/u, "");
        if (bodyLines.length > 0) bodyLines.push(""); // blank line before section
        bodyLines.push(pc.bold(pc.yellow(label)));
      } else if (line.startsWith("- ")) {
        bodyLines.push(...renderBulletLine(line, contentWidth));
      } else if (line.trim()) {
        bodyLines.push(...wrapText(line, contentWidth).map((l) => `  ${l}`));
      }
    }
    const title = `v${entry.version}`;
    console.log(renderCard(title, bodyLines.join("\n"), { formatBorder: pc.cyan, columns: maxCols }));
  }
  console.log("");
}

/**
 * Show release notes if the installed version is newer than the last seen version.
 * Called on startup after the screen clear, before the main flow. Updates
 * lastSeenVersion in config.
 */
export async function showReleaseNotesIfUpdated() {
  const current = currentPackageVersion();
  const config = await loadConfig();
  const lastSeen = config.lastSeenVersion;

  // Fresh install — just record the version, don't show notes
  if (!lastSeen) {
    config.lastSeenVersion = current;
    await saveConfig(config);
    return;
  }

  // No update since last seen
  if (compareVersions(current, lastSeen) <= 0) return;

  // Show what's new since last seen
  const entries = readLocalChangelog();
  const notes = entriesBetween(entries, lastSeen, current);
  if (notes.length > 0) {
    console.log(pc.bold(pc.cyan("\nWhat's new")));
    printReleaseNotes(notes);
  }

  config.lastSeenVersion = current;
  await saveConfig(config);
}