import { basename } from "node:path";
import { spawn } from "node:child_process";
import { HF_HUB_DIR } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { readProfile } from "../profiles.mjs";
import { stopProfile, serverReady, unloadModelFromServer } from "../process.mjs";
import { runProfile } from "./run.mjs";
import { createPrompt, pc } from "../ui.mjs";
import { commandExists } from "../exec.mjs";
import { hfRepoFromPath } from "../huggingface.mjs";

/**
 * Resolve the HF model name and served model name for llama-benchy.
 * Returns null if a valid HF model name can't be determined (benchmarking
 * is not supported in that case).
 *
 * llama-benchy --model expects a HF namespace/model name (for tokenizer
 * download). --served-model-name is what the server actually expects in
 * API requests. When both are passed, llama-benchy uses --model for the
 * tokenizer and --served-model-name for API calls.
 *
 * @returns {{ hfModel: string, servedName: string } | null}
 */
export function resolveBenchyModel(profile, isManaged) {
  if (isManaged) {
    const modelId = profile.omlxModel ?? profile.ollamaModel ?? profile.modelAlias ?? profile.id;

    // oMLX: model IDs are bare names (e.g. "Qwen3.6-35B-A3B-OptiQ-4bit"),
    // not HF namespace/model. No reliable way to get a tokenizer.
    if (backendFor(profile.backend).id === "omlx") return null;

    // Ollama HF GGUF: "hf.co/org/repo:quant" → strip prefix + tag
    if (modelId.startsWith("hf.co/")) {
      const stripped = modelId.slice("hf.co/".length);
      const colonIdx = stripped.indexOf(":");
      const hfModel = colonIdx !== -1 ? stripped.slice(0, colonIdx) : stripped;
      if (hfModel.includes("/")) return { hfModel, servedName: modelId };
    }

    // Ollama library models (e.g. "qwen3:8b") — no HF repo, no tokenizer source
    return null;
  }

  // Local llama.cpp: server reports the filename as the model ID.
  const servedName = profile.modelPath ? basename(profile.modelPath) : profile.modelAlias;
  const repoId = profile.modelPath?.startsWith(HF_HUB_DIR) ? hfRepoFromPath(profile.modelPath) : null;
  if (repoId && repoId.includes("/")) return { hfModel: repoId, servedName };
  // Loose GGUF file not from HF cache — no tokenizer source
  return null;
}

const BENCH_PROFILES = {
  quick: {
    label: "Quick",
    args: ["--pp", "2048", "--tg", "128", "--depth", "0", "--runs", "3", "--concurrency", "1"],
  },
  standard: {
    label: "Standard",
    args: ["--pp", "2048", "4096", "8192", "--tg", "128", "--depth", "0", "4096", "--runs", "3", "--concurrency", "1"],
  },
  thorough: {
    label: "Thorough",
    args: ["--pp", "2048", "4096", "8192", "16384", "--tg", "256", "--depth", "0", "4096", "8192", "--runs", "5", "--concurrency", "1", "2"],
  },
};

/**
 * Run llama-benchy against an OpenAI-compatible endpoint.
 * Uses uvx (zero-install) to run the tool without polluting the system.
 * @param {object} profile - the model profile
 * @param {boolean} isManaged - whether the backend is a managed server
 * @param {string} benchProfile - benchmark profile key: quick|standard|thorough
 * @returns {Promise<boolean>} true if benchmark completed successfully
 */
export async function runLlamaBenchy(profile, isManaged, benchProfile = "quick") {
  if (!(await commandExists("uvx"))) {
    console.log(pc.yellow("llama-benchy requires uv (Python tool runner)."));
    console.log(pc.dim("Install uv:  curl -LsSf https://astral.sh/uv/install.sh | sh"));
    return false;
  }

  const resolved = resolveBenchyModel(profile, isManaged);
  if (!resolved) return false; // caller already printed the reason

  const bench = BENCH_PROFILES[benchProfile] ?? BENCH_PROFILES.quick;

  const args = [
    "llama-benchy",
    "--base-url", profile.baseUrl,
    "--model", resolved.hfModel,
    "--served-model-name", resolved.servedName,
    ...bench.args,
  ];

  console.log(pc.cyan(`\nRunning llama-benchy (${bench.label})...\n`));

  const exitCode = await new Promise((resolve) => {
    const child = spawn("uvx", args, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (err) => {
      console.log(pc.red(`Failed to run llama-benchy: ${err.message}`));
      resolve(1);
    });
    child.on("exit", resolve);

    // Forward Ctrl+C to llama-benchy, escalate to SIGKILL after 2s
    const onSigInt = () => {
      child.kill("SIGINT");
      const killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
      }, 2000);
      child.on("exit", () => clearTimeout(killTimer));
    };
    process.once("SIGINT", onSigInt);
    child.on("exit", () => process.removeListener("SIGINT", onSigInt));
  });

  if (exitCode !== 0) {
    console.log(pc.yellow(`\nllama-benchy exited with code ${exitCode}.`));
    return false;
  }
  return true;
}

export async function benchmarkItem(item) {
  const profile = await readProfile(item.profile.id);
  const backend = backendFor(profile.backend);
  const isManaged = backend.type === "managed-server";

  // Check before starting the server
  if (!resolveBenchyModel(profile, isManaged)) {
    console.log(pc.yellow("Benchmarking is not supported for this model."));
    console.log(pc.dim("llama-benchy needs a HuggingFace model name for the tokenizer. Only models from HuggingFace can be benchmarked."));
    return;
  }

  // Pick a benchmark profile
  const prompt = createPrompt();
  const benchProfile = await prompt.choice("Benchmark profile", [
    { value: "quick", label: "Quick", hint: "~30s · smoke test" },
    { value: "standard", label: "Standard", hint: "~2 min · scaling test" },
    { value: "thorough", label: "Thorough", hint: "~5-10 min · full profile" },
  ], "quick");
  if (!benchProfile) return;

  // Track whether we started the server (so we can clean up)
  const wasRunning = await serverReady(profile.baseUrl);

  if (!wasRunning) {
    if (isManaged) {
      console.log(pc.red(`${backend.label} is not running at ${profile.baseUrl}.`));
      console.log(pc.dim("Start it first, then try benchmarking."));
      return;
    }
    // Start local server (without Pi)
    console.log(pc.dim("Starting server for benchmark..."));
    await runProfile(profile, { with: "server" });
  } else {
    console.log(pc.green(`[ready] Server at ${profile.baseUrl}`));
  }

  // Run llama-benchy
  await runLlamaBenchy(profile, isManaged, benchProfile);

  // Clean up — stop server if we started it, unload model from managed server
  if (!wasRunning && !isManaged) {
    console.log(pc.dim("\nStopping server..."));
    await stopProfile(profile);
  } else if (isManaged) {
    console.log(pc.dim("\nUnloading model from server..."));
    await unloadModelFromServer(profile);
  }
}