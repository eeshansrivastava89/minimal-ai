import { ensureDirs, omlxEnabled, ollamaEnabled, benchmarkingEnabled } from "../config.mjs";
import { stripVTControlCharacters } from "node:util";
import { backendFor, BACKENDS } from "../backends.mjs";
import { createProfileFromModel, readProfile, saveProfile, deleteProfile, profileJsonPath } from "../profiles.mjs";
import { isProfileRunning, modelAvailableOnServer, stopProfile, unloadModelFromServer } from "../process.mjs";
import { syncPiConfig, removeFromPiConfig } from "../harness-pi.mjs";
import { hasOmlx, installOmlx } from "../omlx-runtime.mjs";
import { hasOllama, installOllama } from "../ollama-runtime.mjs";
import { configureLocalProfile, configureManagedProfile } from "../profile-setup.mjs";
import { pc, startInteractive, createPrompt, modelSelect, divider } from "../ui.mjs";
import { buildCatalogItems, createManagedProfile, itemKey, loadModelCatalog, normalizeCatalog } from "../model-catalog.mjs";
import { modelSelectOption, modelNameWidth, inferBackendId, formatSourceLabel, discoverySourceForItem, printGgufModelDetails, printManagedModelDetails, printProfileDetails } from "../model-presenters.mjs";
import { runProfile } from "./run.mjs";
import { downloadHfGguf, downloadOllamaLibrary, downloadOllamaHfGguf } from "../download.mjs";
import { serverReady } from "../server-check.mjs";
import { resolveBenchyModel, benchmarkItem } from "./models-benchmark.mjs";
import { deleteModelFromSource } from "./models-delete.mjs";
import { runtimeStatusFlow, discoveryPathsFlow } from "./models-settings.mjs";

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
  await showModelPicker(catalog);
}

async function showModelPicker(catalog) {
  const normalized = normalizeCatalog(catalog);
  const allItems = buildCatalogItems(normalized);
  if (allItems.length === 0) {
    console.log(pc.dim("No models found yet — pick a download option below to get started.\n"));
  }

  const runningProfilesNow = [];
  const modelMissingIds = new Set();
  for (const profile of normalized.profiles) {
    if (await isProfileRunning(profile)) {
      runningProfilesNow.push(profile);
      continue;
    }
    if (backendFor(profile.backend).type === "managed-server" && await serverReady(profile.baseUrl)) {
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

  // Build action items — grouped by section with dividers
  const isAppleSilicon = process.platform === "darwin" && process.arch === "arm64";
  const omlxOn = await omlxEnabled();
  const ollamaOn = await ollamaEnabled();
  const omlxInstalled = (isAppleSilicon && omlxOn) ? await hasOmlx() : true;
  const ollamaInstalled = ollamaOn ? await hasOllama() : true;

  // Download section — each path is one click, no sub-menus
  const downloadItems = [
    { value: "__download_hf_gguf__", label: `${pc.dim("○")}  ${pc.green("↓ GGUF from HuggingFace")} ${pc.dim("(for llama.cpp)")}` },
  ];
  if (ollamaOn) {
    downloadItems.push({ value: "__download_ollama_library__", label: `${pc.dim("○")}  ${pc.green("↓ Model from Ollama library")} ${pc.dim("(for Ollama)")}` });
    downloadItems.push({ value: "__download_ollama_hf__", label: `${pc.dim("○")}  ${pc.green("↓ GGUF from HuggingFace")} ${pc.dim("(for Ollama)")}` });
  }
  if (omlxOn) {
    downloadItems.push({ value: "__download_omlx__", label: `${pc.dim("○")}  ${pc.green("↓ oMLX model")} ${pc.dim("(open and download from oMLX app)")}`, disabled: true });
  }
  groups.push({ separator: `  ${divider("Download")}`, items: downloadItems });

  // Manage section — runtime status, discovery paths, installs
  const manageItems = [];
  if (isAppleSilicon && !omlxInstalled) {
    manageItems.push({ value: "__install_omlx__", label: `${pc.dim("○")}  ${pc.yellow("↓ Install oMLX")} ${pc.dim("(Apple Silicon — faster for MLX)")}` });
  }
  if (ollamaOn && !ollamaInstalled) {
    manageItems.push({ value: "__install_ollama__", label: `${pc.dim("○")}  ${pc.yellow("↓ Install Ollama")} ${pc.dim("(managed model runner)")}` });
  }
  manageItems.push({ value: "__runtime_status__", label: `${pc.dim("○")}  ${pc.cyan("⚡ Runtime status & running models")}` });
  manageItems.push({ value: "__discovery_paths__", label: `${pc.dim("○")}  ${pc.cyan("📁 Discovery paths")}` });
  groups.push({ separator: `  ${divider("Manage")}`, items: manageItems });

  const prompt = createPrompt();
  const selected = await modelSelect("Select a model", groups);
  if (!selected) return;

  // Download actions — flattened, no sub-menu
  if (selected === "__download_hf_gguf__") {
    await downloadHfGguf(prompt);
    console.log("");
    return;
  }
  if (selected === "__download_ollama_library__") {
    await downloadOllamaLibrary(prompt);
    console.log("");
    return;
  }
  if (selected === "__download_ollama_hf__") {
    await downloadOllamaHfGguf(prompt);
    console.log("");
    return;
  }

  // Manage actions
  if (selected === "__runtime_status__") {
    await runtimeStatusFlow(prompt);
    console.log("");
    return;
  }
  if (selected === "__discovery_paths__") {
    await discoveryPathsFlow(prompt);
    console.log("");
    return;
  }

  if (selected === "__install_omlx__") {
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

  const benchOn = await benchmarkingEnabled();
  const actions = actionsForItem(item, { runningProfilesNow, benchOn });
  const action = await prompt.choice(item.label, actions, actions[0].value);
  if (!action) return;
  await performAction(prompt, action, item, { benchOn });
  console.log("");
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

function actionsForItem(item, { runningProfilesNow = [], benchOn = false } = {}) {
  const missing = item.type === "profile" && item.missing;
  if (item.type === "profile") {
    const available = [
      { value: "inspect", name: "Details", desc: "Paths, ports, flags" },
    ];
    if (!missing) {
      const profile = item.profile;
      const isManaged = backendFor(profile.backend).type === "managed-server";
      const benchySupported = benchOn && Boolean(resolveBenchyModel(profile, isManaged));
      const isRunning = runningProfilesNow.some((p) => p.id === profile.id);
      const serverActions = isRunning
        ? [
            { value: "stop", name: "Stop server", desc: "Stop and free memory" },
            { value: "server", name: "Start server", desc: "Already running", dimmed: true, dimmedDesc: "Already running" },
          ]
        : [
            { value: "server", name: "Start server", desc: "API only, no Pi" },
          ];
      available.unshift(
        { value: "run", name: "Start chatting", desc: "Launch and open Pi" },
        ...serverActions,
      );
      if (benchOn) {
        available.push(
          { value: "benchmark", name: "Benchmark", desc: benchySupported ? "Quick · Standard · Thorough" : "Needs HF model for tokenizer", dimmed: !benchySupported, dimmedDesc: "Needs HF model for tokenizer" },
        );
      }
      available.push(
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

async function performAction(prompt, action, item, { benchOn = false } = {}) {
  const missing = item.type === "profile" && item.missing;
  if (missing && ["run", "reconfigure"].includes(action)) {
    const backend = item.type === "profile" ? backendFor(item.profile.backend) : null;
    const reason = backend?.type === "managed-server" ? "model is no longer available on the server" : "model file is no longer on disk";
    console.log(pc.red(`This model's ${reason}. Remove the setup or restore the model.`));
    return;
  }
  if (action === "benchmark" && item.type === "profile") {
    if (!benchOn) return;
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
  if (action === "stop") return await stopServerItem(item);
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

async function stopServerItem(item) {
  const profile = await readProfile(item.profile.id);
  const isManaged = backendFor(profile.backend).type === "managed-server";
  if (isManaged) {
    const result = await unloadModelFromServer(profile);
    if (result.unloaded) {
      console.log(pc.green(`[unload] ${profile.label}: model unloaded`));
    } else if (result.reason) {
      console.log(pc.dim(`[unload] ${profile.label}: ${result.reason}`));
    } else if (result.error) {
      console.log(pc.yellow(`[unload] ${profile.label}: ${result.error}`));
    }
  } else {
    const result = await stopProfile(profile);
    console.log(result.stopped ? pc.green(`[stop] ${result.message}`) : pc.dim(`[stop] ${result.message}`));
  }
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
  if (profile.capabilities?.missingContextLength) {
    console.log(pc.red("\nCannot configure this model: GGUF metadata is missing context_length."));
    console.log(pc.dim("Without context_length, we cannot safely determine KV cache size —\nthis can cause out-of-memory errors or silent context truncation.\nUse a GGUF with complete metadata, or fix the file with a GGUF editor."));
    return;
  }
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
  const confirmed = await prompt.yesNo(`Remove ${profile.label} (${profile.id})?`, false);
  if (!confirmed) {
    console.log(pc.dim("Cancelled."));
    return;
  }
  if (await isProfileRunning(profile)) {
    console.log(pc.yellow("Stopping running server..."));
    await stopProfile(profile);
  }
  await removeFromPiConfig(profile);
  await deleteProfile(id);
  console.log(pc.green(`Removed ${profile.label} (${profile.id})`));
}