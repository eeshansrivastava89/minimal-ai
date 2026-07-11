import { ensureDirs, getModelScanDirs, addModelScanDir, removeModelScanDir, DEFAULT_MODEL_DIRS, findLlamaServer, HF_HUB_DIR, omlxEnabled, ollamaEnabled } from "../config.mjs";
import { existsSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { backendFor, BACKENDS } from "../backends.mjs";
import { createProfileFromModel, readProfile, saveProfile, deleteProfile, profileJsonPath } from "../profiles.mjs";
import { isProfileRunning, isProfileServerUp, modelAvailableOnServer, stopProfile, serverReady, unloadModelFromServer } from "../process.mjs";
import { syncPiConfig, removeFromPiConfig, hasPi } from "../harness-pi.mjs";
import { hasOmlx, offerOmlxRestart, installOmlx } from "../omlx-runtime.mjs";
import { hasOllama, installOllama, deleteOllamaModel } from "../ollama-runtime.mjs";
import { configureLocalProfile, configureManagedProfile } from "../profile-setup.mjs";
import { findOmlxModelDir } from "../mlx-discovery.mjs";
import { pc, startInteractive, createPrompt, modelSelect, renderCard, renderRows } from "../ui.mjs";
import { buildCatalogItems, createManagedProfile, itemKey, loadModelCatalog, normalizeCatalog } from "../model-catalog.mjs";
import { modelSelectOption, modelNameWidth, inferBackendId, formatSourceLabel, discoverySourceForItem, printGgufModelDetails, printManagedModelDetails, printProfileDetails } from "../model-presenters.mjs";
import { runProfile } from "./run.mjs";
import { downloadFlow } from "../download.mjs";
import { execFileAsync, commandExists } from "../exec.mjs";
import { spawn } from "node:child_process";

export async function modelsCommand(argv) {
  await ensureDirs();
  const catalog = await loadModelCatalog();

  if (argv[0]) {
    await printProfileDetails(await readProfile(argv[0]));
    return;
  }

  if (process.stdin.isTTY) startInteractive("offgrid-ai");
  return await modelCommandCenter(catalog);
}

export async function modelCommandCenter(initialCatalog) {
  if (!process.stdin.isTTY) {
    const allItems = buildCatalogItems(normalizeCatalog(initialCatalog));
    for (const item of allItems) console.log(item.label);
    return;
  }

  let catalog = initialCatalog.newModels ? initialCatalog : await loadModelCatalog();

  while (true) {
    const result = await showModelPicker(catalog);
    if (result === "rescan") {
      catalog = await loadModelCatalog();
      continue;
    }
    return;
  }
}

async function showModelPicker(catalog) {
  const normalized = normalizeCatalog(catalog);
  const allItems = buildCatalogItems(normalized);
  if (allItems.length === 0) {
    console.log(pc.dim("No models found yet — download one to get started.\n"));
  }

  const runningProfilesNow = [];
  const modelMissingIds = new Set();
  for (const profile of normalized.profiles) {
    if (await isProfileRunning(profile)) {
      runningProfilesNow.push(profile);
      continue;
    }
    if (backendFor(profile.backend).type === "managed-server" && await isProfileServerUp(profile)) {
      if (!(await modelAvailableOnServer(profile))) modelMissingIds.add(profile.id);
    }
  }
  // Flag all missing profiles (file missing for llama.cpp, model missing
  // for oMLX managed-server) so actionsForItem/performAction can handle both
  // cases uniformly.
  for (const item of allItems) {
    if (item.type === "profile") {
      item.missing = item.fileMissing || modelMissingIds.has(item.profile.id);
    }
  }

  const nameWidth = modelNameWidth(allItems);

  const statusFor = (item) => {
    if (item.type === "profile") {
      if (item.fileMissing) return "missing";
      if (runningProfilesNow.some((profile) => profile.id === item.profile.id)) return "running";
      if (modelMissingIds.has(item.profile.id)) return "missing";
      return "ready";
    }
    return "setup";
  };

  // Group ready/running/missing profiles by backend, setup items separate
  const byBackend = new Map();
  const setupItems = [];
  for (const item of allItems) {
    const s = statusFor(item);
    if (s === "setup") {
      setupItems.push(item);
    } else {
      const backendId = inferBackendId(item);
      const sourceId = discoverySourceForItem(item) ?? "unknown";
      const key = `${backendId}:${sourceId}`;
      if (!byBackend.has(key)) byBackend.set(key, { backendId, sourceId, items: [] });
      byBackend.get(key).items.push(item);
    }
  }

  const groups = [];
  for (const { backendId, sourceId, items } of byBackend.values()) {
    const backendLabel = backendFor(backendId)?.label ?? backendId;
    const sourceLabel = formatSourceLabel(sourceId);
    const sep = `  ${pc.dim(backendLabel + " · " + sourceLabel + " (" + items.length + ")")}`;
    const groupItems = items.map((item) => {
      const opt = modelSelectOption(item, { runningProfilesNow, modelMissingIds, nameWidth, compact: true });
      return { value: opt.value, label: opt.label, description: opt.description };
    });
    groups.push({ separator: `  ${sep}`, items: groupItems });
  }

  if (setupItems.length > 0) {
    const groupItems = setupItems.map((item) => {
      const opt = modelSelectOption(item, { runningProfilesNow, modelMissingIds, nameWidth, compact: true });
      return { value: opt.value, label: opt.label, description: opt.description };
    });
    groups.push({ separator: `    ${pc.yellow("Needs setup (" + setupItems.length + ")")}`, items: groupItems });
  }

  // Build action items — conditionally include managed backend installs
  const isAppleSilicon = process.platform === "darwin" && process.arch === "arm64";
  const omlxInstalled = (isAppleSilicon && (await omlxEnabled())) ? await hasOmlx() : true;
  const ollamaOn = await ollamaEnabled();
  const ollamaInstalled = ollamaOn ? await hasOllama() : true;
  const actionItems = [
    { value: "__download__", label: `${pc.dim("○")}  ${pc.green("↓ Download a model")}` },
  ];
  if (isAppleSilicon && !omlxInstalled) {
    actionItems.push({ value: "__install_omlx__", label: `${pc.dim("○")}  ${pc.yellow("↓ Install oMLX")} ${pc.dim("(Apple Silicon — faster for MLX)")}` });
  }
  if (ollamaOn && !ollamaInstalled) {
    actionItems.push({ value: "__install_ollama__", label: `${pc.dim("○")}  ${pc.yellow("↓ Install Ollama")} ${pc.dim("(managed model runner)")}` });
  }
  actionItems.push({ value: "__settings__", label: `${pc.dim("○")}  ${pc.cyan("⚙ Status & settings")}` });
  groups.push({ separator: " ", items: actionItems });

  const prompt = createPrompt();
  try {
    const selected = await modelSelect("Select a model", groups, { pageSize: 20 });
    if (!selected) return;

    if (selected === "__settings__") {
      await settingsFlow(prompt);
      console.log("");
      return;
    }

    if (selected === "__download__") {
      await downloadFlow(prompt);
      console.log("");
      return;
    }

    if (selected === "__install_omlx__") {
      // installOmlx() owns the full lifecycle: brew install → start server.
      // → start server (not the GUI) → return. Exit afterward, consistent
      // with download/settings/run/reconfigure — never return to picker.
      await installOmlx();
      console.log("");
      return;
    }

    if (selected === "__install_ollama__") {
      await installOllama();
      console.log("");
      return;
    }

    const item = allItems.find((candidate) => itemKey(candidate) === selected);
    if (!item) return;

    const actions = actionsForItem(item);
    const action = await prompt.choice(item.label, actions, actions[0].value);
    if (!action) return;
    await performAction(prompt, action, item);
    console.log("");
  } finally {
    prompt.close();
  }
}

function formatActions(rawActions) {
  const sep = pc.dim("  │  ");
  const maxName = Math.max(...rawActions.map((a) => stripVTControlCharacters(a.name).length));
  const width = Math.max(17, maxName + 2);
  return rawActions.map((a) => {
    const name = a.dimmed ? pc.dim(pc.strikethrough(a.name.padEnd(width).slice(0, width))) : pc.bold(a.name.padEnd(width).slice(0, width));
    const desc = a.dimmed ? pc.red(a.dimmedDesc ?? "not available") : pc.dim(a.desc);
    return { value: a.value, label: name + sep + desc };
  });
}

function actionsForItem(item) {
  const missing = item.type === "profile" && item.missing;
  if (item.type === "profile") {
    const available = [
      { value: "inspect", name: "Details", desc: "Paths, ports, flags" },
    ];
    if (!missing) {
      const profile = item.profile;
      const isManaged = backendFor(profile.backend).type === "managed-server";
      const benchySupported = Boolean(resolveBenchyModel(profile, isManaged));
      available.unshift(
        { value: "run", name: "Start chatting", desc: "Launch and open Pi" },
        { value: "server", name: "Start server", desc: "API only, no Pi" },
        { value: "benchmark", name: "Benchmark", desc: benchySupported ? "Quick · Standard · Thorough" : "Needs HF model for tokenizer", dimmed: !benchySupported, dimmedDesc: "Needs HF model for tokenizer" },
        { value: "reconfigure", name: "Reconfigure", desc: "Change context, MTP, settings" },
      );
    }
    available.push({ value: "remove_config", name: "Remove configuration", desc: "Delete this setup, keep model files" });
    available.push({ value: "delete_model", name: "Delete model", desc: "Permanently remove from disk" });
    if (missing) {
      available.unshift(
        { value: "run", name: "Start chatting", desc: "Launch and open Pi", dimmed: true },
        { value: "reconfigure", name: "Reconfigure", desc: "Change context, MTP, settings", dimmed: true },
      );
    }
    return formatActions(available);
  }
  if (item.type === "new") {
    return formatActions([
      { value: "setup", name: "Set up", desc: "Configure and save" },
      { value: "inspect", name: "Details", desc: "Model info" },
      { value: "delete_model", name: "Delete model", desc: "Permanently remove from disk" },
    ]);
  }
  return formatActions([
    { value: "setup", name: "Set up", desc: `Connect via ${BACKENDS[item.backendId].label}` },
    { value: "inspect", name: "Details", desc: "Model info" },
    { value: "delete_model", name: "Delete model", desc: "Permanently remove from disk" },
  ]);
}

async function performAction(prompt, action, item) {
  const missing = item.type === "profile" && item.missing;
  if (missing && ["run", "reconfigure"].includes(action)) {
    const backend = item.type === "profile" ? backendFor(item.profile.backend) : null;
    const reason = backend?.type === "managed-server" ? "model is no longer available on the server" : "model file is no longer on disk";
    console.log(pc.red(`This model's ${reason}. Remove the setup or restore the model.`));
    return;
  }
  if (action === "benchmark" && item.type === "profile") {
    const profile = item.profile;
    const isManaged = backendFor(profile.backend).type === "managed-server";
    if (!resolveBenchyModel(profile, isManaged)) {
      console.log(pc.yellow("Benchmarking is not supported for this model."));
      console.log(pc.dim("llama-benchy needs a HuggingFace model name for the tokenizer. Only models from HuggingFace can be benchmarked."));
      return;
    }
  }
  if (action === "inspect") {
    if (item.type === "profile") return await printProfileDetails(await readProfile(item.profile.id));
    if (item.type === "managed") return printManagedModelDetails(item.model, BACKENDS[item.backendId]);
    return printGgufModelDetails(item.model, item.drafter);
  }
  if (action === "run") return await runItem(item);
  if (action === "server") return await startServerItem(item);
  if (action === "benchmark") return await benchmarkItem(item);
  if (action === "reconfigure" || action === "setup") return await setupItem(prompt, item);
  if (action === "remove_config" && item.type === "profile") return await removeProfileInteractive(item.profile.id);
  if (action === "delete_model") return await deleteModelFromSource(prompt, item);
}

async function runItem(item) {
  return await runProfile(await readProfile(item.profile.id));
}

async function startServerItem(item) {
  return await runProfile(await readProfile(item.profile.id), { with: "server" });
}

async function benchmarkItem(item) {
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
  let benchProfile;
  try {
    benchProfile = await prompt.choice("Benchmark profile", [
      { value: "quick", label: "Quick", hint: "~30s · smoke test" },
      { value: "standard", label: "Standard", hint: "~2 min · scaling test" },
      { value: "thorough", label: "Thorough", hint: "~5-10 min · full profile" },
    ], "quick");
  } finally {
    prompt.close();
  }
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
function resolveBenchyModel(profile, isManaged) {
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
async function runLlamaBenchy(profile, isManaged, benchProfile = "quick") {
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

function printProfileSaved(id) {
  console.log(pc.dim(`  Profile: ${profileJsonPath(id)}`));
}

async function setupItem(prompt, item) {
  if (item.type === "profile") {
    const configured = await configureLocalProfile(prompt, await readProfile(item.profile.id));
    if (!configured) return;
    await saveProfile(configured);
    await syncPiConfig(configured);
    printProfileSaved(configured.id);
    return;
  }
  if (item.type === "managed") {
    const profile = createManagedProfile(item.model, item.backendId);
    const configured = await configureManagedProfile(prompt, profile);
    if (!configured) return;
    await saveProfile(configured);
    await syncPiConfig(configured);
    printProfileSaved(configured.id);
    return;
  }
  const profile = await createProfileFromModel(item.model, null, item.drafter?.path);
  const configured = await configureLocalProfile(prompt, profile);
  if (!configured) return;
  await saveProfile(configured);
  await syncPiConfig(configured);
  printProfileSaved(configured.id);
}

async function removeProfileInteractive(id) {
  const profile = await readProfile(id);
  if (!process.stdin.isTTY) {
    console.log(pc.red(`Use --force to remove ${id} non-interactively.`));
    return;
  }
  const prompt = createPrompt();
  try {
    const confirmed = await prompt.yesNo(`Remove ${profile.label} (${profile.id})?`, false);
    if (!confirmed) {
      console.log(pc.dim("Cancelled."));
      return;
    }
  } finally {
    prompt.close();
  }
  if (await isProfileRunning(profile)) {
    console.log(pc.yellow("Stopping running server..."));
    await stopProfile(profile);
  }
  await removeFromPiConfig(profile);
  await deleteProfile(id);
  console.log(pc.green(`Removed ${profile.label} (${profile.id})`));
}

// ── Delete model from source ───────────────────────────────────────────────

/** Extract HuggingFace repo ID from a cache path. */
function hfRepoFromPath(path) {
  const hubPart = path.slice(HF_HUB_DIR.length);
  const match = hubPart.match(/models--(.+?)(?=\/|$)/);
  if (!match) return null;
  return match[1].replace(/--/g, "/");
}

/** Determine where a model's files live on disk. */
async function modelLocationForItem(item) {
  if (item.type === "profile") {
    const backend = backendFor(item.profile.backend);
    if (backend.type === "managed-server") {
      const modelId = item.profile.omlxModel || item.profile.ollamaModel || item.profile.modelAlias || item.profile.id;
      if (backend.id === "ollama") {
        return { kind: "ollama", modelId };
      }
      // oMLX model IDs may not include the org prefix, so search recursively
      const dir = await findOmlxModelDir(modelId);
      return { kind: "mlx", dir: dir ?? join(homedir(), ".omlx", "models", ...modelId.replace(/--/g, "/").split("/").filter(Boolean)), modelId };
    }
    const modelPath = item.profile.modelPath;
    if (!modelPath) return { kind: "unknown" };
    if (modelPath.startsWith(HF_HUB_DIR)) {
      return { kind: "hf-cache", path: modelPath, repoId: hfRepoFromPath(modelPath) };
    }
    return { kind: "file", path: modelPath };
  }
  if (item.type === "new") {
    const modelPath = item.model?.path;
    if (!modelPath) return { kind: "unknown" };
    if (modelPath.startsWith(HF_HUB_DIR)) {
      return { kind: "hf-cache", path: modelPath, repoId: hfRepoFromPath(modelPath) };
    }
    return { kind: "file", path: modelPath };
  }
  if (item.type === "managed") {
    const modelId = item.model?.id;
    if (!modelId) return { kind: "unknown" };
    if (item.backendId === "ollama") {
      return { kind: "ollama", modelId };
    }
    // oMLX model IDs may not include the org prefix, so search recursively
    const dir = await findOmlxModelDir(modelId);
    return { kind: "mlx", dir: dir ?? join(homedir(), ".omlx", "models", ...modelId.replace(/--/g, "/").split("/").filter(Boolean)), modelId };
  }
  return { kind: "unknown" };
}

async function deleteModelFromSource(prompt, item) {
  const loc = await modelLocationForItem(item);

  if (loc.kind === "unknown") {
    console.log(pc.yellow("Could not determine where this model's files are located."));
    return;
  }

  // Show what will be deleted
  let locationLabel;
  if (loc.kind === "hf-cache") {
    locationLabel = loc.path ?? loc.repoId;
  } else if (loc.kind === "mlx") {
    locationLabel = loc.dir;
  } else if (loc.kind === "ollama") {
    locationLabel = loc.modelId;
  } else if (loc.kind === "file") {
    locationLabel = loc.path;
  }

  console.log(pc.yellow("\nThis will permanently delete " + (item.type === "profile" ? "the configuration and the model from:" : "the model from:")));
  console.log(pc.dim(`  ${locationLabel}`));

  const confirmed = await prompt.yesNo("Delete this model?", false);
  if (!confirmed) {
    console.log(pc.dim("Cancelled."));
    return;
  }

  // Stop running server if needed
  if (item.type === "profile" && await isProfileRunning(item.profile)) {
    console.log(pc.dim("Stopping running server..."));
    await stopProfile(item.profile);
  }

  // Delete files
  if (loc.kind === "ollama") {
    try {
      const ok = await deleteOllamaModel(loc.modelId);
      if (ok) {
        console.log(pc.green(`✓ Deleted ${loc.modelId} from Ollama`));
      } else {
        console.log(pc.red(`✗ Ollama did not confirm deletion of ${loc.modelId}`));
        console.log(pc.dim(`Delete manually: ollama rm ${loc.modelId}`));
      }
    } catch (err) {
      console.log(pc.red(`✗ Failed: ${err.message}`));
      console.log(pc.dim(`Delete manually: ollama rm ${loc.modelId}`));
    }
  } else if (loc.kind === "hf-cache" && loc.repoId) {
    const cacheDir = join(HF_HUB_DIR, `models--${loc.repoId.replace(/\//g, "--")}`);
    try {
      const { stdout } = await execFileAsync("hf", ["cache", "rm", `model/${loc.repoId}`, "--yes"], { timeout: 30000 });
      if (stdout.trim()) console.log(pc.dim(stdout.trim()));
      // Verify the directory is actually gone
      if (existsSync(cacheDir)) {
        console.log(pc.red(`✗ Model still exists at ${cacheDir}`));
        console.log(pc.dim(`Delete manually: hf cache rm model/${loc.repoId}`));
      } else {
        console.log(pc.green(`✓ Deleted ${loc.repoId} from HuggingFace cache`));
      }
    } catch (err) {
      const detail = err.stderr?.trim() || err.message;
      console.log(pc.red(`✗ Failed: ${detail}`));
      console.log(pc.dim(`Delete manually: hf cache rm model/${loc.repoId}`));
    }
  } else if (loc.kind === "mlx") {
    const omlxModelsRoot = join(homedir(), ".omlx", "models");
    // Safety guard: never delete outside ~/.omlx/models/
    if (!loc.dir.startsWith(omlxModelsRoot + "/") && loc.dir !== omlxModelsRoot) {
      console.log(pc.red(`✗ Refusing to delete: path is outside ~/.omlx/models/`));
      console.log(pc.dim(`  Target: ${loc.dir}`));
      console.log(pc.dim(`Delete manually if needed: rm -rf ${loc.dir}`));
      return;
    }
    if (!existsSync(loc.dir)) {
      console.log(pc.yellow(`Directory not found: ${loc.dir}`));
      console.log(pc.dim("Model files may have already been removed, or oMLX loaded them from a different location."));
    } else {
      try {
        await rm(loc.dir, { recursive: true, force: true });
      } catch (err) {
        console.log(pc.red(`✗ Failed: ${err.message}`));
        console.log(pc.dim(`Delete manually: rm -rf ${loc.dir}`));
        return;
      }
      // Verify deletion
      if (existsSync(loc.dir)) {
        console.log(pc.red(`✗ Directory still exists: ${loc.dir}`));
        console.log(pc.dim(`Delete manually: rm -rf ${loc.dir}`));
      } else {
        console.log(pc.green(`✓ Deleted ${loc.dir}`));
        await offerOmlxRestart(prompt, "to update its model list");
      }
    }
  } else if (loc.kind === "file") {
    if (!existsSync(loc.path)) {
      console.log(pc.yellow(`File not found: ${loc.path}`));
      console.log(pc.dim("Model file may have already been removed."));
    } else {
      try {
        await unlink(loc.path);
      } catch (err) {
        console.log(pc.red(`✗ Failed: ${err.message}`));
        console.log(pc.dim(`Delete manually: rm ${loc.path}`));
        return;
      }
      // Verify deletion
      if (existsSync(loc.path)) {
        console.log(pc.red(`✗ File still exists: ${loc.path}`));
        console.log(pc.dim(`Delete manually: rm ${loc.path}`));
      } else {
        console.log(pc.green(`✓ Deleted ${loc.path}`));
      }
    }
  }

  // Remove profile configuration if one exists
  if (item.type === "profile") {
    await removeFromPiConfig(item.profile);
    await deleteProfile(item.profile.id);
    console.log(pc.dim(`Removed configuration: ${item.profile.id}`));
  }
}

// ── Settings & discovery path management ───────────────────────────────────

async function settingsFlow(prompt) {
  while (true) {
    const llamaBinary = await findLlamaServer();
    const omlxOn = await omlxEnabled();
    const omlxInstalled = omlxOn ? await hasOmlx() : false;
    const ollamaOn = await ollamaEnabled();
    const ollamaInstalled = ollamaOn ? await hasOllama() : false;
    const piInstalled = await hasPi();

    let omlxServerUp = false;
    if (omlxInstalled) {
      omlxServerUp = await serverReady(BACKENDS.omlx.defaultBaseUrl);
    }
    let ollamaServerUp = false;
    if (ollamaInstalled) {
      ollamaServerUp = await serverReady(BACKENDS.ollama.defaultBaseUrl);
    }

    const runtimeRows = [
      ["llama.cpp", llamaBinary ? pc.green("✓ ") + pc.dim(llamaBinary) : pc.red("✗ not found")],
    ];
    if (omlxOn) {
      runtimeRows.push(["oMLX", omlxInstalled ? (omlxServerUp ? pc.green("✓ server up") : pc.yellow("✓ installed · server down")) : pc.red("✗ not found")]);
    }
    if (ollamaOn) {
      runtimeRows.push(["Ollama", ollamaInstalled ? (ollamaServerUp ? pc.green("✓ server up") : pc.yellow("✓ installed · server down")) : pc.red("✗ not found")]);
    }
    runtimeRows.push(["Pi", piInstalled ? pc.green("✓ installed") : pc.red("✗ not found")]);

    console.log("");
    console.log(renderCard("Runtime status", renderRows(runtimeRows), { formatBorder: pc.cyan }));

    const scanDirs = await getModelScanDirs();
    const defaultSet = new Set(DEFAULT_MODEL_DIRS);
    const pathLabels = new Map([
      [join(homedir(), ".lmstudio", "models"), "LM Studio downloads"],
      [join(homedir(), ".omlx", "models"), "oMLX downloads"],
      [HF_HUB_DIR, "HuggingFace CLI downloads"],
    ]);
    const pathRows = scanDirs.map((dir) => {
      const exists = existsSync(dir);
      const isBuiltin = defaultSet.has(dir);
      const desc = pathLabels.get(dir);
      const label = `${exists ? pc.green("✓") : pc.red("✗")}  ${dir}`;
      const tags = [desc, isBuiltin ? "built-in" : "custom"].filter(Boolean).join(pc.dim(" · "));
      return [label, pc.dim(tags)];
    });
    console.log("");
    console.log(renderCard("Discovery paths", renderRows(pathRows), { formatBorder: pc.magenta }));

    const customDirs = scanDirs.filter((d) => !defaultSet.has(d));
    const choices = [
      { value: "add", label: "Add discovery path" },
      ...(customDirs.length > 0 ? [{ value: "remove", label: "Remove discovery path" }] : []),
      { value: "done", label: "Done" },
    ];
    const action = await prompt.choice("Settings", choices, "done");

    if (!action || action === "done") return;

    if (action === "add") {
      const dir = await prompt.text("Path to model directory", "");
      if (!dir || !dir.trim()) continue;
      const cleanDir = dir.trim();
      if (!existsSync(cleanDir)) {
        console.log(pc.red(`Directory not found: ${cleanDir}`));
        continue;
      }
      await addModelScanDir(cleanDir);
      console.log(pc.green(`Added: ${cleanDir}`));
    }

    if (action === "remove") {
      const removeChoices = customDirs.map((d) => ({ value: d, label: d }));
      const toRemove = await prompt.choice("Remove path", removeChoices);
      if (!toRemove) continue;
      await removeModelScanDir(toRemove);
      console.log(pc.green(`Removed: ${toRemove}`));
    }
  }
}