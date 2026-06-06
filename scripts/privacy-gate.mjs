#!/usr/bin/env node

/**
 * Privacy & Artifact Gate for offgrid-ai.
 *
 * Verifies:
 * 1. No forbidden files tracked in git
 * 2. No hardcoded user paths in source files
 * 3. No secrets in tarball contents
 * 4. Tarball content validation (size, count, no sensitive files)
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

let failures = 0;
let warnings = 0;

function fail(msg) {
  console.error(`${RED}FAIL${RESET} ${msg}`);
  failures++;
}

function pass(msg) {
  console.log(`${GREEN}PASS${RESET} ${msg}`);
}

function warn(msg) {
  console.warn(`${YELLOW}WARN${RESET} ${msg}`);
  warnings++;
}

// ── 1. Tracked files check ──────────────────────────────────────────

console.log("\n=== Tracked Files Gate ===\n");

const FORBIDDEN_TRACKED = [
  /^\.env$/,
  /^\.env\.local$/,
  /^\.env\.production$/,
  /\.db$/,
  /\.db-journal$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /\/\.env$/,
  /\/\.env\.local$/,
];

const trackedFiles = execSync("git ls-files", { encoding: "utf-8" }).trim().split("\n");

let trackedForbiddenFound = false;
for (const file of trackedFiles) {
  for (const pattern of FORBIDDEN_TRACKED) {
    if (pattern.test(file)) {
      fail(`Forbidden file tracked in git: ${file}`);
      trackedForbiddenFound = true;
    }
  }
}
if (!trackedForbiddenFound) {
  pass("No forbidden files tracked in git");
}

// ── 2. Source path check ────────────────────────────────────────────

console.log("\n=== Source Path Gate ===\n");

const USER_PATH_PATTERNS = [
  /\/Users\/(?!test\b)\w+/,
  /\/home\/(?!test\b)\w+/,
  /C:\\Users\\\w+/,
];

const sourceFiles = trackedFiles.filter(
  (f) => /\.(mjs|js|ts)$/.test(f) && !f.includes("test") && !f.includes("node_modules"),
);

let userPathHits = [];
for (const file of sourceFiles) {
  try {
    const content = readFileSync(file, "utf-8");
    for (const pattern of USER_PATH_PATTERNS) {
      if (pattern.test(content)) {
        userPathHits.push(file);
        break;
      }
    }
  } catch {
    // File may be new/unstaged — skip
  }
}

if (userPathHits.length > 0) {
  for (const file of userPathHits) {
    fail(`Hardcoded user path in source: ${file}`);
  }
} else {
  pass("No hardcoded user paths in source files");
}

// ── 3. Tarball content check ────────────────────────────────────────

console.log("\n=== Tarball Content Gate ===\n");

const FORBIDDEN_IN_TARBALL = [
  /\.db$/,
  /\.db-journal$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /\.env$/,
  /\.env\.local$/,
  /\.env\.production$/,
  /^package\/PLAN\.md$/,
  /^package\/Dockerfile$/,
  /^package\/\.dockerignore$/,
  /^package\/test-clean\.sh$/,
  /^package\/\.pi\//,
];

const MAX_TARBALL_FILES = 50;
const MAX_TARBALL_SIZE_MB = 5;

try {
  const packList = execSync("npm pack --dry-run --ignore-scripts 2>&1", { encoding: "utf-8" });
  const lines = packList.split("\n").filter(
    (l) =>
      l.startsWith("npm notice") &&
      !l.includes("Tarball") &&
      !l.includes("name:") &&
      !l.includes("version:") &&
      !l.includes("filename:") &&
      !l.includes("package size:") &&
      !l.includes("unpacked size:") &&
      !l.includes("shasum:") &&
      !l.includes("integrity:") &&
      !l.includes("total files:") &&
      !l.includes("==="),
  );

  let tarballForbiddenFound = false;
  for (const line of lines) {
    const match = line.match(/npm notice\s+[\d.]+[kMG]?B\s+(.+)/);
    if (!match) continue;
    const filePath = match[1].trim();
    for (const pattern of FORBIDDEN_IN_TARBALL) {
      if (pattern.test(filePath)) {
        fail(`Forbidden file in npm tarball: ${filePath}`);
        tarballForbiddenFound = true;
      }
    }
  }

  if (!tarballForbiddenFound) {
    pass("No forbidden files in npm tarball");
  }

  // Check total file count and size
  const totalFilesMatch = packList.match(/total files:\s*(\d+)/);
  const sizeMatch = packList.match(/package size:\s*([\d.]+)\s*([kMG]?B)/);
  if (totalFilesMatch) {
    const totalFiles = Number(totalFilesMatch[1]);
    if (totalFiles > MAX_TARBALL_FILES) {
      fail(`Tarball has ${totalFiles} files (max ${MAX_TARBALL_FILES}) — likely includes dev files`);
    } else {
      pass(`Tarball file count OK (${totalFiles} <= ${MAX_TARBALL_FILES})`);
    }
  }
  if (sizeMatch) {
    const size = Number(sizeMatch[1]);
    const unit = sizeMatch[2];
    const sizeMB =
      unit === "GB"
        ? size * 1024
        : unit === "MB"
          ? size
          : unit === "kB"
            ? size / 1024
            : size / (1024 * 1024);
    if (sizeMB > MAX_TARBALL_SIZE_MB) {
      fail(`Tarball is ${size} ${unit} (max ${MAX_TARBALL_SIZE_MB} MB)`);
    } else {
      pass(`Tarball size OK (${size} ${unit} <= ${MAX_TARBALL_SIZE_MB} MB)`);
    }
  }
} catch (e) {
  warn(`Could not run tarball content check: ${e.message}`);
  warnings++;
}

// ── 4. Secret scan ──────────────────────────────────────────────────

console.log("\n=== Secret Scan Gate ===\n");

const SECRET_PATTERNS = [
  { name: "OpenAI API key", pattern: /sk-proj-[a-zA-Z0-9_-]{20,}/ },
  { name: "Anthropic API key", pattern: /sk-ant-api[0-9]+-[a-zA-Z0-9_-]+/ },
];

const walkFiles = (dir) => {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
};

let _tarball = null;
let _tmpDir = null;
try {
  const packJson = JSON.parse(execSync("npm pack --json --ignore-scripts 2>/dev/null", { encoding: "utf-8" }));
  _tarball = packJson[0].filename;
  const tmpBase = join(homedir(), ".tmp");
  if (!existsSync(tmpBase)) mkdirSync(tmpBase, { recursive: true });
  _tmpDir = mkdtempSync(join(tmpBase, "offgrid-scan-"));
  execSync(`tar -C "${_tmpDir}" -xzf "${_tarball}"`, { encoding: "utf-8" });

  const allFiles = walkFiles(_tmpDir);
  let secretsFound = false;

  for (const file of allFiles) {
    let content;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue; // binary file — skip
    }
    for (const { name: secretName, pattern } of SECRET_PATTERNS) {
      if (pattern.test(content)) {
        const rel = file.slice(_tmpDir.length + 1);
        fail(`Secret found in tarball (${secretName}) in: ${rel}`);
        secretsFound = true;
      }
    }
  }

  if (!secretsFound) {
    pass("No secrets found in tarball contents");
  }
} catch (e) {
  warn(`Could not run tarball secret scan: ${e.message}`);
  warnings++;
} finally {
  if (_tarball) rmSync(_tarball, { force: true });
  if (_tmpDir) rmSync(_tmpDir, { recursive: true, force: true });
}

// ── Summary ─────────────────────────────────────────────────────────

console.log("\n=== Summary ===\n");
if (failures > 0) {
  console.error(`${RED}${failures} failure(s)${RESET}, ${warnings} warning(s)`);
  process.exit(1);
} else {
  console.log(`${GREEN}All checks passed${RESET} (${warnings} warning(s))`);
  process.exit(0);
}