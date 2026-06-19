// ── Benchmark command flows ───────────────────────────────────────────────────

import { join } from "node:path";
import { ensureDirs } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { hasPi, hasPiModel, syncPiConfig } from "../harness-pi.mjs";
import { serverReady, startServer, waitForReady, stopProfile, modelAvailableOnServer } from "../process.mjs";
import { loadProfiles } from "../profiles.mjs";
import { pc, createPrompt } from "../ui.mjs";
import { linkBenchmarkRepo } from "./repo.mjs";
import { loadBenchmarks } from "./shared.mjs";
import { prepareBenchmarkRun } from "./prepare.mjs";
import { runBenchmarkInPi } from "./pi-runner.mjs";
import { queryServerMetrics } from "./metrics.mjs";
import { unloadModelFromServer } from "./finalize.mjs";
import { finalizeBenchmarkRun, renderBenchmarkSummary } from "./finalize.mjs";

function benchmarkModelSource(profile) {
  if (!profile) return "cloud";
  return profile.providerId === "llama-cpp-mtp" ? "llama-cpp-mtp" : profile.backend === "ollama" ? "ollama" : profile.backend === "omlx" ? "omlx" : "llama-cpp";
}

async function chooseBenchmarkAction(prompt, canRun) {
  const choices = [
    { value: "run", label: "Run Benchmark", hint: "Automated with Pi" },
    { value: "prepare", label: "Prepare Benchmark (manual)", hint: "Copy prompt and run yourself" },
  ];
  return await prompt.choice("Action", canRun ? choices : choices.filter((c) => c.value === "prepare"), canRun ? "run" : "prepare");
}

function managedModelId(profile) {
  return profile.omlxModel ?? profile.ollamaModel ?? profile.modelAlias ?? profile.label;
}

async function ensureManagedModelAvailableForBenchmark(profile, backend) {
  if (backend.type !== "managed-server") return;
  if (await modelAvailableOnServer(profile)) return;
  throw new Error(`${managedModelId(profile)} is not available on ${backend.label} at ${profile.baseUrl}.`);
}

async function ensureServerForBenchmark(profile) {
  const backend = backendFor(profile.backend);
  if (await serverReady(profile.baseUrl)) {
    await ensureManagedModelAvailableForBenchmark(profile, backend);
    console.log(pc.green(`[ready] ${backend.label} at ${profile.baseUrl}`));
    return { started: false };
  }

  if (backend.type === "managed-server") {
    throw new Error(`${backend.label} is not running at ${profile.baseUrl}. Start it and try again.`);
  }

  console.log(pc.dim(`Starting ${backend.label} for ${profile.label}...`));
  const state = await startServer(profile);
  await waitForReady(profile, state?.pid, state?.rawLogPath);
  console.log(pc.green(`[ready] ${profile.baseUrl}/models`));
  return { started: true, state };
}

export async function runPreparedBenchmark(profile, runDirectory, options = {}) {
  const controller = new AbortController();
  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let serverStarted = false;
  let benchmarkStarted = false;
  let metadata = null;

  const onSigint = () => {
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    if (!(await hasPi())) {
      console.log(pc.yellow("\nPi is not installed. Run prepared for manual execution."));
      return metadata;
    }

    const serverState = await ensureServerForBenchmark(profile);
    serverStarted = serverState.started;

    if (!(await hasPiModel(profile))) {
      await syncPiConfig(profile);
    }

    benchmarkStarted = true;
    const runResult = await runBenchmarkInPi(profile, runDirectory, { signal: controller.signal });

    let speedMetrics = null;
    let speedMetricsError = null;
    if (!runResult.error) {
      try {
        speedMetrics = await queryServerMetrics(profile);
      } catch (err) {
        // Non-fatal: speed metrics are a supplementary measurement, not the
        // benchmark itself. Don't poison the run result; surface it as a note.
        speedMetricsError = err.message;
      }
    }

    metadata = await finalizeBenchmarkRun(runDirectory, runResult, speedMetrics, speedMetricsError);
    renderBenchmarkSummary(metadata);
  } catch (err) {
    const failedResult = {
      error: { message: err.message },
      wallClockMs: null,
      agentTurns: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      toolCalls: 0,
      toolResults: 0,
      perTurn: [],
    };
    metadata = await finalizeBenchmarkRun(runDirectory, failedResult, null);
    renderBenchmarkSummary(metadata);
  } finally {
    process.removeListener("SIGINT", onSigint);
    if (serverStarted && !options.keepServer) {
      const backend = backendFor(profile.backend);
      if (backend.type !== "managed-server") {
        const result = await stopProfile(profile);
        console.log(result.stopped ? pc.green(`[stop] ${result.message}`) : pc.dim(`[stop] ${result.message}`));
      }
    }
    if (benchmarkStarted) {
      const unloadResult = await unloadModelFromServer(profile);
      if (!unloadResult.unloaded && unloadResult.error) {
        console.log(pc.yellow(`[unload] ${unloadResult.backend}: ${unloadResult.error}`));
      } else if (!unloadResult.unloaded && unloadResult.reason) {
        console.log(pc.dim(`[unload] ${unloadResult.backend}: ${unloadResult.reason}`));
      }
    }
  }

  return metadata;
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
    const modelSource = benchmarkModelSource(profile);
    const backendLabel = backendFor(profile.backend).label;

    const canRun = (await hasPi()) && modelSource !== "cloud";
    const action = await chooseBenchmarkAction(prompt, canRun);

    const runDirectory = await prepareBenchmarkRun({ repoPath, benchmark: selectedBenchmark, kind, modelId, modelSource, backendLabel, profile, showNextSteps: action === "prepare" });

    if (action === "run") {
      return await runPreparedBenchmark(profile, runDirectory);
    }

    return runDirectory;
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
      modelSource = benchmarkModelSource(profile);
      backendLabel = backendFor(profile.backend).label;
    } else {
      backendLabel = await prompt.text("Backend label", "cloud");
      modelId = await prompt.text("Model name", "");
      if (!modelId) { console.log(pc.yellow("Model name is required.")); return; }
      modelSource = "cloud";
    }

    const canRun = (await hasPi()) && modelSource !== "cloud" && profile != null;
    const action = await chooseBenchmarkAction(prompt, canRun);

    const runDirectory = await prepareBenchmarkRun({ repoPath, benchmark: selectedBenchmark, kind, modelId, modelSource, backendLabel, profile, showNextSteps: action === "prepare" });

    if (action === "run" && profile) {
      return await runPreparedBenchmark(profile, runDirectory);
    }

    return runDirectory;
  } finally {
    prompt.close();
  }
}