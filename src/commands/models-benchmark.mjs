import { basename } from "node:path";
import { spawn } from "node:child_process";
import { HF_HUB_DIR } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { readProfile, effectiveModelId } from "../profiles.mjs";
import { stopProfile, unloadModelFromServer } from "../process.mjs";
import { serverReady } from "../server-check.mjs";
import { runProfile } from "./run.mjs";
import { promptSelect, status, theme } from "../ui.mjs";
import { commandExists } from "../exec.mjs";
import { hfRepoFromPath } from "../huggingface.mjs";

export function resolveBenchyModel(profile, isManaged) {
  if (isManaged) {
    const modelId = effectiveModelId(profile);
    if (backendFor(profile.backend).id === "omlx") return null;
    if (modelId.startsWith("hf.co/")) {
      const stripped = modelId.slice("hf.co/".length);
      const colonIdx = stripped.indexOf(":");
      const hfModel = colonIdx !== -1 ? stripped.slice(0, colonIdx) : stripped;
      if (hfModel.includes("/")) return { hfModel, servedName: modelId };
    }
    return null;
  }
  const servedName = profile.modelPath ? basename(profile.modelPath) : profile.modelAlias;
  const repoId = profile.modelPath?.startsWith(HF_HUB_DIR) ? hfRepoFromPath(profile.modelPath) : null;
  if (repoId && repoId.includes("/")) return { hfModel: repoId, servedName };
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

export async function runLlamaBenchy(profile, isManaged, benchProfile = "quick") {
  if (!(await commandExists("uvx"))) {
    console.log(status({ kind: "warning", message: "llama-benchy requires uv (Python tool runner)." }));
    console.log(theme.subtle("Install uv:  curl -LsSf https://astral.sh/uv/install.sh | sh"));
    return false;
  }

  const resolved = resolveBenchyModel(profile, isManaged);
  if (!resolved) return false;

  const bench = BENCH_PROFILES[benchProfile] ?? BENCH_PROFILES.quick;
  const args = [
    "llama-benchy",
    "--base-url", profile.baseUrl,
    "--model", resolved.hfModel,
    "--served-model-name", resolved.servedName,
    ...bench.args,
  ];

  console.log(theme.brand(`\nRunning llama-benchy (${bench.label})...\n`));

  const exitCode = await new Promise((resolve) => {
    const child = spawn("uvx", args, { stdio: "inherit", env: process.env });
    child.on("error", (err) => {
      console.log(status({ kind: "error", message: `Failed to run llama-benchy: ${err.message}` }));
      resolve(1);
    });
    child.on("exit", resolve);

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
    console.log(status({ kind: "warning", message: `llama-benchy exited with code ${exitCode}.` }));
    return false;
  }
  return true;
}

export async function benchmarkItem(item) {
  const profile = await readProfile(item.profile.id);
  const backend = backendFor(profile.backend);
  const isManaged = backend.type === "managed-server";

  if (!resolveBenchyModel(profile, isManaged)) {
    console.log(status({ kind: "warning", message: "Benchmarking is not supported for this model." }));
    console.log(theme.subtle("llama-benchy needs a HuggingFace model name for the tokenizer. Only models from HuggingFace can be benchmarked."));
    return;
  }

  const benchProfile = await promptSelect({
    message: "Benchmark profile",
    choices: [
      { value: "quick", label: "Quick", hint: "~30s · smoke test" },
      { value: "standard", label: "Standard", hint: "~2 min · scaling test" },
      { value: "thorough", label: "Thorough", hint: "~5-10 min · full profile" },
    ],
    defaultValue: "quick",
  });
  if (!benchProfile) return;

  const wasRunning = await serverReady(profile.baseUrl);

  if (!wasRunning) {
    if (isManaged) {
      console.log(status({ kind: "error", message: `${backend.label} is not running at ${profile.baseUrl}.` }));
      console.log(theme.subtle("Start it first, then try benchmarking."));
      return;
    }
    console.log(theme.subtle("Starting server for benchmark..."));
    await runProfile(profile, { with: "server" });
  } else {
    console.log(status({ kind: "success", message: `[ready] Server at ${profile.baseUrl}` }));
  }

  await runLlamaBenchy(profile, isManaged, benchProfile);

  if (!wasRunning && !isManaged) {
    console.log(theme.subtle("\nStopping server..."));
    await stopProfile(profile);
  } else if (isManaged) {
    console.log(theme.subtle("\nUnloading model from server..."));
    await unloadModelFromServer(profile);
  }
}
