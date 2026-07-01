// ── Create a benchmark run directory ────────────────────────────────────────

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pc, renderRows, renderSection } from "../ui.mjs";
import { slugModelId, createRunId, buildToolPrompt } from "./shared.mjs";
import { parseModelName } from "../model-name.mjs";

function harnessDisplayName(id) {
  if (id === "pi") return "Pi";
  return String(id).replace(/[-_]+/gu, " ").replace(/\b\w/gu, (char) => char.toUpperCase());
}

function intendedRunnerForProfile(profile) {
  if (!profile) return "your tool";
  const harnessEntries = Object.entries(profile.harnesses ?? {}).filter(([, config]) => config?.enabled !== false);
  const [id] = harnessEntries.find(([key]) => key === "pi") ?? harnessEntries[0] ?? ["pi"];
  return harnessDisplayName(id);
}

function printBenchmarkNextSteps({ repoPath, runDirectory, profile, modelId, runnerLabel }) {
  const runCommand = profile ? `offgrid-ai run ${profile.id}` : null;
  const runnerCommand = runCommand ?? `Open ${runnerLabel} for ${modelId}`;

  console.log("");
  console.log(pc.bold("Next steps"));
  console.log(`  1. Open the gallery. If it is not running: ${pc.cyan(`cd ${repoPath} && npm run dev`)}`);
  console.log(`  2. ${pc.cyan(`cd ${runDirectory}`)}`);
  console.log(`  3. ${pc.cyan(runnerCommand)}, then copy this run's prompt from the gallery and paste it into ${runnerLabel}`);
}

export async function prepareBenchmarkRun({ repoPath, benchmark, kind, modelId, modelSource, backendLabel, profile, showNextSteps = true }) {
  const toolPrompt = buildToolPrompt(benchmark);
  const now = new Date();
  const runId = createRunId(now);
  const modelSlug = slugModelId(modelId);
  const runnerLabel = intendedRunnerForProfile(profile);
  const runsDir = join(repoPath, "runs");
  const benchmarkDirectory = join(runsDir, benchmark.id);
  const modelDirectory = join(benchmarkDirectory, modelSlug);
  const runDirectory = join(modelDirectory, runId);

  await mkdir(runDirectory, { recursive: true });

  const isDs = kind === "data-science";
  const baseAssets = {
    metadata: "metadata.json",
    prompt: "prompt.md",
  };
  const metadata = {
    schemaVersion: 1,
    kind,
    runId,
    benchmark: { id: benchmark.id, title: benchmark.title, description: benchmark.description, prompt: benchmark.prompt },
    model: { id: modelId, slug: modelSlug, displayName: parseModelName(modelId, modelSource === "omlx" ? "omlx" : "local-gguf").display },
    status: "prepared",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    preparedAt: now.toISOString(),
    runDirectory,
    assets: isDs
      ? { ...baseAssets, ds: { notebook: "analysis.ipynb", summary: "summary.json", chartDistribution: "chart-distribution.png", chartTreatmentEffect: "chart-treatment-effect.png", chartCompletionRates: "chart-completion-rates.png" } }
      : { ...baseAssets, html: "index.html", preview: "preview.png", video: "preview.webm" },
    runner: {
      mode: modelSource === "cloud" ? "manual" : "external",
      intendedRunner: profile ? runnerLabel : undefined,
      ...(profile?.harnesses?.pi || runnerLabel === "Pi" ? { tool: "pi" } : {}),
      ...(modelSource ? { modelSource } : {}),
      ...(backendLabel ? { backendLabel } : {}),
      ...(profile?.baseUrl ? { baseUrl: profile.baseUrl } : {}),
      model: modelId,
      retries: 0,
      tokenMetrics: {
        reported: false,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      speedMetrics: {
        prefillTokensPerSecond: null,
        generationTokensPerSecond: null,
        ttftMs: null,
        modelLoadMs: null,
        speculativeDecodeAcceptance: null,
        kvCacheTokens: null,
      },
      metricSource: null,
    },
    results: {
      wallClockMs: null,
      agentTurns: 0,
      toolCalls: 0,
      toolResults: 0,
      success: false,
      outputFiles: [],
      perTurn: [],
    },
  };

  await writeFile(join(runDirectory, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", "utf8");
  await writeFile(join(runDirectory, "prompt.md"), toolPrompt + "\n", "utf8");

  console.log("");
  console.log(pc.green("✓ Run slot prepared"));
  console.log(renderSection("Run", renderRows([
    ["Directory", pc.cyan(runDirectory)],
    ["Benchmark", benchmark.title],
    ["Kind", kind],
    ["Model", pc.bold(modelId)],
    ["Source", backendLabel || modelSource],
  ])));

  if (showNextSteps) {
    printBenchmarkNextSteps({ repoPath, runDirectory, profile, modelId, runnerLabel });
  }

  return runDirectory;
}