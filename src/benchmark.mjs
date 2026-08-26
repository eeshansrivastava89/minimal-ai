// ── Visual benchmark prepare flow ───────────────────────────────────────────
// Connects minimal-ai to the local-llm-visual-benchmark gallery repo: pick a
// prompt, create a run slot (runs/<benchmark>/<model-slug>/<run-id>/), then
// launch the model with the configured chat harness in that directory. The
// gallery dev server captures
// screenshots/video afterwards. Run-slot files must stay schema-compatible
// with the gallery (schemaVersion 1).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, saveConfig } from "./config.mjs";
import { backendFor } from "./backends.mjs";
import { effectiveModelId } from "./profiles.mjs";
import { parseModelName } from "./model-name.mjs";
import { promptChoice, promptConfirm, promptText, renderList, status, theme } from "./ui.mjs";
import { runProfile } from "./launch.mjs";
import { configuredHarness } from "./harnesses.mjs";

const execFileAsync = promisify(execFile);

const BENCHMARK_REPO = "https://github.com/eeshansrivastava89/local-llm-visual-benchmark.git";

// ── Run-slot naming (matches the gallery's slugger) ─────────────────────────

export function slugModelId(modelId, maxLength = 80) {
  const hash = createHash("sha256").update(modelId).digest("hex").slice(0, 10);
  const normalized = modelId.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").replace(/-{2,}/gu, "-");
  if (slug.length > 0 && slug.length <= maxLength && slug === normalized) return slug;
  const baseMaxLength = Math.max(1, maxLength - 11);
  const base = slug.slice(0, baseMaxLength).replace(/^-+|-+$/gu, "") || "model";
  return `${base}-${hash}`;
}

export function createRunId(date = new Date()) {
  return date.toISOString().replace(/:/gu, "-").replace(/\./gu, "-");
}

// ── Benchmark prompt loading (frontmatter + body, matches gallery format) ───

export async function loadBenchmarks(benchDir) {
  const entries = await readdir(benchDir);
  const markdownFiles = entries.filter((f) => f.endsWith(".md")).sort();
  const benchmarks = [];
  for (const filename of markdownFiles) {
    const raw = await readFile(join(benchDir, filename), "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const frontmatter = match ? match[1] : "";
    const content = match ? match[2].trim() : raw.trim();
    let id = filename.replace(/\.md$/u, "");
    let title = id;
    let description = "";
    for (const line of frontmatter.split("\n")) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) {
        const [, key, val] = kv;
        if (key === "id") id = val.trim();
        if (key === "title") title = val.trim();
        if (key === "description") description = val.trim();
      }
    }
    const kind = id === "ab-test-analysis" ? "data-science" : "visual";
    benchmarks.push({ id, title, description, prompt: content, kind });
  }
  return benchmarks;
}

// ── Gallery repo linking ────────────────────────────────────────────────────

async function findBenchmarkRepo() {
  const config = await loadConfig();
  if (config.benchmarkRepoPath && existsSync(join(config.benchmarkRepoPath, "benchmarks"))) {
    return config.benchmarkRepoPath;
  }
  return null;
}

async function rememberBenchmarkRepo(path) {
  const config = await loadConfig();
  config.benchmarkRepoPath = path;
  await saveConfig(config);
}

async function linkBenchmarkRepo() {
  const existing = await findBenchmarkRepo();
  if (existing) return existing;

  const candidates = [
    join(homedir(), "dev", "local-llm-visual-benchmark"),
    join(homedir(), "projects", "local-llm-visual-benchmark"),
    join(homedir(), "local-llm-visual-benchmark"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "benchmarks"))) {
      await rememberBenchmarkRepo(candidate);
      return candidate;
    }
  }

  console.log(theme.subtle("\nBenchmarking needs the local-llm-visual-benchmark gallery repo."));
  console.log(theme.subtle("It stores the prompts and the run results you see in the gallery.\n"));

  const choice = await promptChoice({
    message: "Link benchmark gallery",
    choices: [
      { value: "clone", label: "Clone from GitHub", hint: "git clone into ~/dev" },
      { value: "manual", label: "Enter path manually", hint: "If you already have it cloned" },
    ],
    defaultValue: "clone",
  });
  if (!choice) return null;

  if (choice === "clone") {
    const targetDir = join(homedir(), "dev", "local-llm-visual-benchmark");
    console.log(theme.subtle(`\nCloning ${BENCHMARK_REPO}...`));
    try {
      await execFileAsync("git", ["clone", BENCHMARK_REPO, targetDir]);
      await rememberBenchmarkRepo(targetDir);
      console.log(status({ kind: "success", message: `Cloned to ${targetDir}` }));
      return targetDir;
    } catch (err) {
      console.log(status({ kind: "error", message: `Clone failed: ${err.message}` }));
      return null;
    }
  }

  const path = await promptText({ message: "Path to local-llm-visual-benchmark" });
  if (!path) return null;
  const resolved = resolve(path.replace(/^~/, homedir()));
  if (!existsSync(join(resolved, "benchmarks"))) {
    console.log(status({ kind: "error", message: `No benchmarks/ directory found at ${resolved}` }));
    return null;
  }
  await rememberBenchmarkRepo(resolved);
  console.log(status({ kind: "success", message: `Linked to ${resolved}` }));
  return resolved;
}

// ── Run slot preparation ────────────────────────────────────────────────────

function modelSourceFor(profile) {
  if (profile.backend === "llama-cpp" && profile.drafterPath) return "llama-cpp-mtp";
  return profile.backend;
}

export async function prepareBenchmarkRun({ repoPath, benchmark, profile, harness = null, now = new Date() }) {
  const modelId = effectiveModelId(profile);
  const modelSource = modelSourceFor(profile);
  const backendLabel = backendFor(profile.backend).label;
  const runId = createRunId(now);
  const modelSlug = slugModelId(modelId);
  const runDirectory = join(repoPath, "runs", benchmark.id, modelSlug, runId);

  await mkdir(runDirectory, { recursive: true });

  const isDs = benchmark.kind === "data-science";
  const metadata = {
    schemaVersion: 1,
    kind: benchmark.kind,
    runId,
    benchmark: { id: benchmark.id, title: benchmark.title, description: benchmark.description, prompt: benchmark.prompt },
    model: { id: modelId, slug: modelSlug, displayName: parseModelName(modelId, modelSource === "omlx" ? "omlx" : "local-gguf").display },
    status: "prepared",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    preparedAt: now.toISOString(),
    runDirectory,
    assets: isDs
      ? {
          metadata: "metadata.json",
          prompt: "prompt.md",
          ds: {
            notebook: "analysis.ipynb",
            summary: "summary.json",
            chartDistribution: "chart-distribution.png",
            chartTreatmentEffect: "chart-treatment-effect.png",
            chartCompletionRates: "chart-completion-rates.png",
          },
        }
      : { metadata: "metadata.json", prompt: "prompt.md", html: "index.html", preview: "preview.png", video: "preview.webm" },
    runner: {
      mode: "external",
      intendedRunner: harness?.label ?? null,
      tool: harness?.id ?? null,
      modelSource,
      backendLabel,
      baseUrl: profile.baseUrl,
      model: modelId,
      retries: 0,
      tokenMetrics: { reported: false, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
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
  await writeFile(join(runDirectory, "prompt.md"), benchmark.prompt + "\n", "utf8");

  console.log("");
  console.log(status({ kind: "success", message: "Run slot prepared" }));
  console.log(renderList([
    ["Directory", runDirectory],
    ["Benchmark", benchmark.title],
    ["Model", modelId],
    ["Source", backendLabel],
  ]));

  return runDirectory;
}

// ── The flow: pick a prompt → create the slot → launch ──────────────────────

async function selectBenchmark(repoPath) {
  const benchDir = join(repoPath, "benchmarks");
  const benchmarks = await loadBenchmarks(benchDir);
  if (benchmarks.length === 0) {
    console.log(status({ kind: "warning", message: `No benchmark prompts found in ${benchDir}` }));
    return null;
  }
  const benchmarkId = await promptChoice({
    message: "Benchmark prompt",
    choices: benchmarks.map((b) => ({
      value: b.id,
      label: b.kind === "data-science" ? `${b.title} (data science)` : b.title,
      hint: b.description || b.id,
    })),
    defaultValue: benchmarks[0].id,
  });
  return benchmarks.find((b) => b.id === benchmarkId) ?? null;
}

export async function benchmarkForProfile(profile) {
  const repoPath = await linkBenchmarkRepo();
  if (!repoPath) return;

  const benchmark = await selectBenchmark(repoPath);
  if (!benchmark) return;

  const harness = await configuredHarness();
  const runDirectory = await prepareBenchmarkRun({ repoPath, benchmark, profile, harness });

  const launch = await promptConfirm({
    message: `Launch now? ${harness.label} opens in the run directory with the benchmark prompt.`,
    initialValue: true,
  });
  if (!launch) {
    console.log("");
    console.log(theme.subtle("To run it later:"));
    console.log(theme.subtle(`  1. cd ${runDirectory}`));
    console.log(theme.subtle(`  2. minimal-ai run ${profile.id}`));
    console.log(theme.subtle(`  3. Paste the prompt from prompt.md`));
    console.log(theme.subtle(`To review the result: cd ${repoPath} && npm run dev`));
    return runDirectory;
  }

  await runProfile(profile, { cwd: runDirectory, message: benchmark.prompt });

  console.log(theme.subtle("To review the result and capture preview media:"));
  console.log(theme.subtle(`  cd ${repoPath} && npm run dev`));
  return runDirectory;
}
