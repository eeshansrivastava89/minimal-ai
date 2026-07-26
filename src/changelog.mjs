import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { card, wrapText, theme, screenHeader } from "./ui.mjs";
import { compareVersions, currentPackageVersion } from "./updates.mjs";
import { loadConfig, saveConfig } from "./config.mjs";

const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/eeshansrivastava89/minimal-ai";

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

export function readLocalChangelog() {
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

function renderBulletLine(line, width) {
  const text = line.replace(/^-\s+/, "");
  const segments = text.split(/(\*\*[^*]+\*\*)/);
  const formatted = segments.map((seg) => {
    if (seg.startsWith("**") && seg.endsWith("**")) {
      return theme.bold(seg.slice(2, -2));
    }
    return seg;
  }).join("");
  const wrapped = wrapText(formatted, width - 4);
  return wrapped.map((l, i) => i === 0 ? `  - ${l}` : `    ${l}`);
}

export function printReleaseNotes(entries) {
  if (!entries || entries.length === 0) return;

  for (const entry of entries) {
    const bodyLines = [];
    const lines = entry.content.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      if (line.startsWith("### ")) {
        const label = line.replace(/^###\s+/u, "");
        if (bodyLines.length > 0) bodyLines.push("");
        bodyLines.push(theme.bold(theme.warning(label)));
      } else if (line.startsWith("- ")) {
        bodyLines.push(...renderBulletLine(line, 76));
      } else if (line.trim()) {
        bodyLines.push(...wrapText(line, 76).map((l) => `  ${l}`));
      }
    }
    console.log(card({ title: `v${entry.version}`, body: bodyLines.join("\n") }));
  }
  console.log("");
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
