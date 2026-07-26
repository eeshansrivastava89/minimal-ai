#!/usr/bin/env node
// Codebase health report — a read-only snapshot run at the start of each
// session. Wraps three established tools:
//   - scc    (static binary)            -> size + file-level complexity
//   - madge  (npx, ESM import graph)    -> circular dependencies
//   - jscpd  (npx, token-based)         -> copy-paste duplication
//
// Output is a compact terminal summary; generated artifacts land under reports/
// (gitignored) and a one-line dated snapshot is appended to reports/health.log
// so trends are visible across sessions. No thresholds, no failing rules.
//
// One-time setup: scc must be on PATH (download the darwin-arm64 binary from
// https://github.com/boyter/scc/releases into ~/.local/bin, or `brew install
// scc` if Homebrew is healthy). madge/jscpd are fetched via npx on first use.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = join(REPO_ROOT, "reports");
const HEALTH_LOG = join(REPORTS_DIR, "health.log");
const SCC_INCLUDE = "mjs,py"; // executable source (excludes docs/config)

// ANSI strip built at runtime (no control char in source — keeps eslint quiet).
const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const stripAnsi = (s) => s.replace(ANSI_RE, "");

// ── helpers ────────────────────────────────────────────────────────────────

const OPTS = { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 };

// Run a command, returning stdout on success or null on failure.
async function run(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, OPTS);
    return stdout;
  } catch {
    return null;
  }
}

// Run a command that may exit non-zero as a *result* (e.g. madge finds cycles).
// Returns combined stdout + stderr regardless of exit code.
async function capture(cmd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, OPTS);
    return `${stdout}\n${stderr}`;
  } catch (err) {
    return `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
  }
}

const fmtNum = (n) => Number(n).toLocaleString("en-US");

// ── scc: size + complexity ──────────────────────────────────────────────────

async function sccReport() {
  const out = await run("scc", ["--by-file", "-f", "json", "-i", SCC_INCLUDE]);
  if (out === null) return { error: "scc not found on PATH — install it (see header of this script)." };
  const langs = JSON.parse(out);
  const sum = (k) => langs.reduce((a, l) => a + l[k], 0);
  const files = langs.flatMap((l) => l.Files ?? []).map((f) => ({ loc: f.Location, code: f.Code, complexity: f.Complexity }));
  return {
    totalFiles: sum("Count"),
    totalCode: sum("Code"),
    totalComplexity: sum("Complexity"),
    totalLines: sum("Lines"),
    totalComments: sum("Comment"),
    totalBlanks: sum("Blank"),
    topComplex: [...files].sort((a, b) => b.complexity - a.complexity).slice(0, 8),
    langsBreakdown: langs.map((l) => `${l.Name} ${l.Count}`).join(", "),
  };
}

// ── madge: circular deps ────────────────────────────────────────────────────

async function madgeReport() {
  const text = stripAnsi(await capture("npx", ["--yes", "madge@latest", "--circular", "--extensions", "mjs", "src/"]));
  if (/No circular dependencies found/i.test(text)) return { count: 0, cycles: [] };
  const count = Number(text.match(/Found (\d+) circular/i)?.[1] ?? 0);
  const cycles = text.split("\n").map((l) => l.trim()).filter((l) => /^\d+\)\s/.test(l));
  return { count, cycles };
}

// ── jscpd: duplication ──────────────────────────────────────────────────────

async function jscpdReport() {
  const text = stripAnsi(await capture("npx", [
    "--yes", "jscpd@latest", "src/",
    "--reporters", "json,console", "--output", join(REPORTS_DIR, "jscpd"), "--silent",
  ]));
  if (!/Found \d+ exact clones/i.test(text)) {
    return { error: text.trim().split("\n").slice(-3).join(" ") || "jscpd produced no summary." };
  }
  const clones = Number(text.match(/Found (\d+) exact clones/i)?.[1] ?? 0);
  const dupLines = Number(text.match(/(\d+)\s*\([\d.]+%\)\s*duplicated/i)?.[1] ?? 0);
  const dupPct = Number(text.match(/\(([\d.]+)%\)\s*duplicated/i)?.[1] ?? null);
  const files = Number(text.match(/in (\d+) .*files/i)?.[1] ?? 0);
  return { clones, dupLines, dupPct, files };
}

// ── trend log ────────────────────────────────────────────────────────────────

async function appendTrend(code, complexity, circular, dupPct) {
  await mkdir(REPORTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const line = `${date} | code ${code} | complexity ${complexity} | circular ${circular} | dup ${dupPct ?? "n/a"}%`;
  await appendFile(HEALTH_LOG, line + "\n");
  const history = (await readFile(HEALTH_LOG, "utf8")).trim().split("\n");
  return history.slice(-6);
}

// ── render ──────────────────────────────────────────────────────────────────

const row = (label, value) => console.log(`  ${pc.dim(label.padEnd(12))} ${value}`);

async function main() {
  await mkdir(REPORTS_DIR, { recursive: true });
  console.log(pc.bold(`Codebase health — minimal-ai (${new Date().toISOString().slice(0, 10)})`));

  const scc = await sccReport();
  console.log(`\n${pc.bold("Size")}`);
  if (scc.error) {
    console.log(pc.red(`  ${scc.error}`));
  } else {
    row("Files", `${fmtNum(scc.totalFiles)}  (${scc.langsBreakdown})`);
    row("Code LLOC", fmtNum(scc.totalCode));
    row("Comments", fmtNum(scc.totalComments));
    row("Blanks", fmtNum(scc.totalBlanks));
    row("Total LOC", fmtNum(scc.totalLines));
    row("Complexity", fmtNum(scc.totalComplexity));
    console.log(`\n${pc.bold("Top complex files")}`);
    for (const f of scc.topComplex) console.log(`  ${pc.yellow(String(f.complexity).padStart(3))}  ${f.loc}`);
  }

  const madge = await madgeReport();
  console.log(`\n${pc.bold("Structure (madge)")}`);
  row("Circular", madge.count === 0 ? pc.green("0") : pc.red(`${madge.count}`));
  for (const c of madge.cycles) console.log(`    ${pc.dim(c)}`);

  const jscpd = await jscpdReport();
  console.log(`\n${pc.bold("Duplication (jscpd)")}`);
  if (jscpd.error) {
    console.log(pc.red(`  ${jscpd.error}`));
  } else {
    const dupStr = jscpd.dupPct == null ? "n/a" : `${jscpd.dupPct}%`;
    row("Clones", `${jscpd.clones}`);
    row("Dup lines", `${fmtNum(jscpd.dupLines)} (${dupStr})`);
    row("Report", pc.dim("reports/jscpd/jscpd-report.json"));
  }

  const trend = await appendTrend(
    scc.totalCode ?? "n/a",
    scc.totalComplexity ?? "n/a",
    madge.count ?? "n/a",
    jscpd.dupPct,
  );
  console.log(`\n${pc.bold("Trend (reports/health.log)")}`);
  for (const entry of trend) console.log(`  ${pc.dim(entry)}`);
  console.log();
}

main().catch((err) => {
  console.error(pc.red(`health-report failed: ${err.message}`));
  process.exit(1);
});