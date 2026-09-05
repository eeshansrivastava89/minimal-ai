import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isPathInside } from "./asset-paths.ts";
import type { DsScorecard, RunMetadata } from "./types.ts";

const execFileAsync = promisify(execFile);

// The deterministic scorer ships with this repo (scripts/score-ds-run.py +
// its oracle); resolve relative to this module, never process.cwd().
const SCORER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "scripts",
  "score-ds-run.py"
);

export interface ScoreDsRunOptions {
  runsRoot: string;
  runDirectory: string;
}

export interface ScoreDsRunResult {
  scored: boolean;
  run: RunMetadata;
  scorecard: DsScorecard;
}

export async function scoreDsRun(
  options: ScoreDsRunOptions,
  deps?: {
    execFile?: typeof execFileAsync;
    readFile?: typeof readFile;
    writeFile?: typeof writeFile;
    stat?: typeof stat;
  }
): Promise<ScoreDsRunResult> {
  const exec = deps?.execFile ?? execFileAsync;
  const readFileFn = deps?.readFile ?? readFile;
  const writeFileFn = deps?.writeFile ?? writeFile;
  const statFn = deps?.stat ?? stat;

  const runsRoot = resolve(options.runsRoot);
  const runDirectory = resolve(options.runDirectory);

  // Validate directory is inside runs root (shared containment check,
  // same as every other run-scoped write).
  if (!isPathInside(runDirectory, runsRoot)) {
    throw new Error("Run directory is outside the configured runs folder.");
  }

  // Read metadata
  const metadataPath = join(runDirectory, "metadata.json");
  let metadata: RunMetadata;
  try {
    metadata = JSON.parse(await readFileFn(metadataPath, "utf8"));
  } catch {
    throw new Error("metadata.json not found or unreadable in run directory.");
  }

  // Must be a data-science run
  if (metadata.kind !== "data-science") {
    throw new Error("Not a data-science run. Scoring is only available for data-science runs.");
  }

  // Check summary.json exists
  const summaryPath = join(runDirectory, "summary.json");
  try {
    await statFn(summaryPath);
  } catch {
    throw new Error("summary.json not found. The model must produce summary.json before scoring.");
  }

  console.log(`[score-ds] Scoring ${runDirectory}`);
  console.log(`[score-ds] Model: ${metadata.model?.id ?? "unknown"}, Benchmark: ${metadata.benchmark?.id ?? "unknown"}`);

  // Run deterministic scorer
  console.log(`[score-ds] Running: python3 ${SCORER_PATH} ${runDirectory}`);
  const { stdout } = await exec("python3", [SCORER_PATH, runDirectory], {
    timeout: 30_000
  });

  let scorecard: DsScorecard;
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.earned !== "number" || typeof parsed.total !== "number") {
      throw new Error("Scorer output missing earned/total fields.");
    }
    scorecard = {
      total: parsed.total,
      earned: parsed.earned,
      pct: parsed.pct ?? Math.round(parsed.earned / parsed.total * 1000) / 10,
      checks: typeof parsed.checks === "object" ? parsed.checks : undefined
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Scorer produced invalid JSON: " + stdout.slice(0, 200));
    }
    throw error;
  }

  console.log(`[score-ds] Complete: ${scorecard.earned}/${scorecard.total} (${scorecard.pct}%)`);

  // Write scorecard.json
  const scorecardPath = join(runDirectory, metadata.assets?.ds?.scorecard ?? "scorecard.json");
  await writeFileFn(scorecardPath, JSON.stringify(scorecard, null, 2) + "\n", "utf8");

  // Update metadata
  const timestamp = new Date().toISOString();
  const next: RunMetadata = {
    ...metadata,
    status: "completed",
    completedAt: timestamp,
    updatedAt: timestamp,
    failedAt: undefined,
    error: undefined,
    assets: {
      ...metadata.assets,
      ds: {
        ...metadata.assets?.ds,
        scorecard: metadata.assets?.ds?.scorecard ?? "scorecard.json"
      }
    },
    dsScorecard: scorecard
  };

  await writeFileFn(metadataPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  return { scored: true, run: next, scorecard };
}
