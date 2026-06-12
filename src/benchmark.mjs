import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureDirs, loadConfig, saveConfig } from "./config.mjs";
import { backendFor } from "./backends.mjs";
import { pc, createPrompt, renderRows, renderSection } from "./ui.mjs";

const execFileAsync = promisify(execFile);

// ── Shared utilities (matches local-llm-visual-benchmark) ──────────────────

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

export function buildToolPrompt(benchmark, kind) {
  if (kind === "data-science") return benchmark.prompt;
  return [
    "Create a complete, self-contained HTML file for the request below.",
    "Write the file as `index.html` in the current working directory.",
    "Do not create any folders, do not infer a filesystem path, and do not print the HTML in chat.",
    "",
    "The HTML must include all CSS and JavaScript inline and must not depend on external network assets.",
    "After building the page, run a visual QA pass with agent-browser or Playwright: open the saved index.html, inspect the rendered result, and fix any obvious layout, animation, console, or viewport issues before you finish.",
    "",
    benchmark.prompt,
  ].join("\n");
}

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

// ── Benchmark repo linking ────────────────────────────────────────────────

const BENCHMARK_REPO = "https://github.com/eeshansrivastava89/local-llm-visual-benchmark.git";

export async function findBenchmarkRepo() {
  const config = await loadConfig();
  if (config.benchmarkRepoPath && existsSync(join(config.benchmarkRepoPath, "benchmarks"))) {
    return config.benchmarkRepoPath;
  }
  return null;
}

export async function linkBenchmarkRepo(prompt) {
  const existing = await findBenchmarkRepo();
  if (existing) return existing;

  const candidates = [
    join(homedir(), "dev", "local-llm-visual-benchmark"),
    join(homedir(), "projects", "local-llm-visual-benchmark"),
    join(homedir(), "local-llm-visual-benchmark"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "benchmarks"))) {
      const config = await loadConfig();
      config.benchmarkRepoPath = candidate;
      await saveConfig(config);
      return candidate;
    }
  }

  console.log(pc.dim("\nThe benchmark gallery needs to be linked to offgrid-ai."));
  console.log(pc.dim("This is the local-llm-visual-benchmark repo that stores prompts and run results.\n"));

  const choice = await prompt.choice("Link benchmark gallery", [
    { value: "clone", label: "Clone from GitHub", hint: "git clone into ~/dev" },
    { value: "manual", label: "Enter path manually", hint: "If you already have it cloned" },
  ], "clone");

  if (choice === "clone") {
    const targetDir = join(homedir(), "dev", "local-llm-visual-benchmark");
    console.log(pc.dim(`\nCloning ${BENCHMARK_REPO}...`));
    try {
      await execFileAsync("git", ["clone", BENCHMARK_REPO, targetDir], { stdio: "pipe" });
      const config = await loadConfig();
      config.benchmarkRepoPath = targetDir;
      await saveConfig(config);
      console.log(pc.green(`✓ Cloned to ${targetDir}`));
      return targetDir;
    } catch (err) {
      console.log(pc.red(`Clone failed: ${err.message}`));
      return null;
    }
  }

  const path = await prompt.text("Path to local-llm-visual-benchmark", "");
  if (!path) return null;
  const resolved = resolve(path.replace(/^~/, homedir()));
  if (!existsSync(join(resolved, "benchmarks"))) {
    console.log(pc.red(`No benchmarks/ directory found at ${resolved}`));
    return null;
  }
  const config = await loadConfig();
  config.benchmarkRepoPath = resolved;
  await saveConfig(config);
  console.log(pc.green(`✓ Linked to ${resolved}`));
  return resolved;
}

// ── Create a benchmark run directory ──────────────────────────────────────

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

async function prepareBenchmarkRun({ repoPath, benchmark, kind, modelId, modelSource, backendLabel, profile }) {
  const toolPrompt = buildToolPrompt(benchmark, kind);
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
  const metadata = {
    schemaVersion: 1,
    kind,
    runId,
    benchmark: { id: benchmark.id, title: benchmark.title, description: benchmark.description, prompt: benchmark.prompt },
    model: { id: modelId, slug: modelSlug },
    status: "prepared",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    preparedAt: now.toISOString(),
    runDirectory,
    assets: isDs
      ? { metadata: "metadata.json", prompt: "prompt.md", rawResponse: "response.raw.txt", ds: { notebook: "analysis.ipynb", summary: "summary.json", chartDistribution: "chart-distribution.png", chartTreatmentEffect: "chart-treatment-effect.png", chartCompletionRates: "chart-completion-rates.png" } }
      : { metadata: "metadata.json", prompt: "prompt.md", html: "index.html", preview: "preview.png", video: "preview.webm", rawResponse: "response.raw.txt" },
    runner: {
      mode: modelSource === "cloud" ? "manual" : "external",
      intendedRunner: profile ? runnerLabel : undefined,
      ...(profile?.harnesses?.pi || runnerLabel === "Pi" ? { tool: "pi" } : {}),
      ...(modelSource ? { modelSource } : {}),
      ...(backendLabel ? { backendLabel } : {}),
      ...(profile?.baseUrl ? { baseUrl: profile.baseUrl } : {}),
      model: modelId,
      retries: 0,
      tokenMetrics: { reported: false },
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

  printBenchmarkNextSteps({ repoPath, runDirectory, profile, modelId, runnerLabel });

  return runDirectory;
}

// ── Benchmark from a selected profile (from model picker) ────────────────

export async function benchmarkForProfile(profile) {
  await ensureDirs();
  const prompt = createPrompt();
  try {
    const repoPath = await linkBenchmarkRepo(prompt);
    if (!repoPath) return;

    const kind = await prompt.choice("Benchmark category", [
      { value: "visual", label: "Visual Benchmark", hint: "HTML/CSS/JS animation benchmarks" },
      { value: "data-science", label: "Data Science", hint: "Analysis and charting benchmarks" },
    ], "visual");

    const benchDir = join(repoPath, "benchmarks");
    const benchmarks = (await loadBenchmarks(benchDir)).filter((b) => b.kind === kind);
    if (benchmarks.length === 0) {
      console.log(pc.yellow(`No ${kind} benchmarks found in ${benchDir}`));
      return;
    }
    const benchmarkId = await prompt.choice("Prompt", benchmarks.map((b) => ({
      value: b.id, label: b.title, hint: b.description || b.id,
    })), benchmarks[0].id);
    const selectedBenchmark = benchmarks.find((b) => b.id === benchmarkId);
    if (!selectedBenchmark) return;

    const modelId = profile.modelAlias;
    const modelSource = profile.providerId === "llama-cpp-mtp" ? "llama-cpp-mtp" : profile.backend === "ollama" ? "ollama" : profile.backend === "omlx" ? "omlx" : "llama-cpp";
    const backendLabel = backendFor(profile.backend).label;

    return await prepareBenchmarkRun({ repoPath, benchmark: selectedBenchmark, kind, modelId, modelSource, backendLabel, profile });
  } finally {
    prompt.close();
  }
}

// ── Standalone benchmark flow (offgrid-ai benchmark) ──────────────────────

export async function benchmarkFlow() {
  await ensureDirs();

  const prompt = createPrompt();
  try {
    const repoPath = await linkBenchmarkRepo(prompt);
    if (!repoPath) return;

    const kind = await prompt.choice("Benchmark category", [
      { value: "visual", label: "Visual Benchmark", hint: "HTML/CSS/JS animation benchmarks" },
      { value: "data-science", label: "Data Science", hint: "Analysis and charting benchmarks" },
    ], "visual");

    const benchDir = join(repoPath, "benchmarks");
    const benchmarks = (await loadBenchmarks(benchDir)).filter((b) => b.kind === kind);
    if (benchmarks.length === 0) {
      console.log(pc.yellow(`No ${kind} benchmarks found in ${benchDir}`));
      return;
    }
    const benchmarkId = await prompt.choice("Prompt", benchmarks.map((b) => ({
      value: b.id, label: b.title, hint: b.description || b.id,
    })), benchmarks[0].id);
    const selectedBenchmark = benchmarks.find((b) => b.id === benchmarkId);
    if (!selectedBenchmark) return;

    const { loadProfiles } = await import("./profiles.mjs");

    const profiles = await loadProfiles();
    const source = await prompt.choice("Model source", [
      { value: "profile", label: "Use existing profile", hint: "Pick a saved offgrid-ai profile" },
      { value: "cloud", label: "Custom / cloud", hint: "Free-form model label for cloud runs" },
    ], "profile");

    let modelId, modelSource, backendLabel, profile;

    if (source === "profile") {
      if (profiles.length === 0) {
        console.log(pc.yellow("No profiles yet. Run: offgrid-ai models"));
        return;
      }
      const profileId = await prompt.choice("Profile", profiles.map((p) => ({
        value: p.id, label: p.label, hint: `${backendFor(p.backend).label} · ${p.modelAlias}`,
      })), profiles[0].id);
      profile = profiles.find((p) => p.id === profileId);
      if (!profile) return;
      modelId = profile.modelAlias;
      modelSource = profile.providerId === "llama-cpp-mtp" ? "llama-cpp-mtp" : profile.backend === "ollama" ? "ollama" : profile.backend === "omlx" ? "omlx" : "llama-cpp";
      backendLabel = backendFor(profile.backend).label;
    } else {
      backendLabel = await prompt.text("Backend label", "cloud");
      modelId = await prompt.text("Model name", "");
      if (!modelId) { console.log(pc.yellow("Model name is required.")); return; }
      modelSource = "cloud";
    }

    return await prepareBenchmarkRun({ repoPath, benchmark: selectedBenchmark, kind, modelId, modelSource, backendLabel, profile });
  } finally {
    prompt.close();
  }
}