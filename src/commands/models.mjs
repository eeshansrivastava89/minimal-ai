import { ensureDirs, omlxEnabled, ollamaEnabled, benchmarkingEnabled } from "../config.mjs";
import { stripVTControlCharacters } from "node:util";
import { backendFor, BACKENDS } from "../backends.mjs";
import { createProfileFromModel, readProfile, saveProfile, deleteProfile, profileJsonPath } from "../profiles.mjs";
import { isProfileRunning, modelAvailableOnServer, stopProfile, unloadModelFromServer } from "../process.mjs";
import { syncPiConfig, removeFromPiConfig } from "../harness-pi.mjs";
import { hasOmlx, installOmlx } from "../omlx-runtime.mjs";
import { hasOllama, installOllama } from "../ollama-runtime.mjs";
import { configureLocalProfile, configureManagedProfile } from "../profile-setup.mjs";
import { startInteractive, promptSelectModel, promptChoice, promptConfirm, theme, status } from "../ui.mjs";
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
    console.log(theme.subtle("No models found yet — pick a download option below to get started.\n"));
  }

  const runningProfilesNow = [];
  const modelMissingIds = new Set();
  await Promise.all(normalized.profiles.map(async (profile) => {
    if (await isProfileRunning(profile)) {
      runningProfilesNow.push(profile);
      return;
    }
    if (backendFor(profile.backend).type === "managed-server" && await serverReady(profile.baseUrl)) {
      if (!(await modelAvailableOnServer(profile))) modelMissingIds.add(profile.id);
    }
  }));
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
    const label = backendLabel === sourceLabel ? backendLabel : `${backendLabel} · ${sourceLabel}`;
    const sep = `${theme.bold(label)} ${theme.subtle(`(${items.length})`)}`;
    const groupItems = items.map((item) => {
      const opt = modelSelectOption(item, { runningProfilesNow, modelMissingIds, nameWidth, compact: true });
      return { value: opt.value, label: opt.label, description: opt.description };
    });
    groups.push({ separator: sep, items: groupItems });
  }

  if (setupItems.length > 0) {
    const groupItems = setupItems.map((item) => {
      const opt = modelSelectOption(item, { runningProfilesNow, modelMissingIds, nameWidth, compact: true });
      return { value: opt.value, label: opt.label, description: opt.description };
    });
    groups.push({ separator: theme.warning(`Needs setup (${setupItems.length})`), items: groupItems });
  }

  const isAppleSilicon = process.platform === "darwin" && process.arch === "arm64";
  const omlxOn = await omlxEnabled();
  const ollamaOn = await ollamaEnabled();
  const omlxInstalled = (isAppleSilicon && omlxOn) ? await hasOmlx() : true;
  const ollamaInstalled = ollamaOn ? await hasOllama() : true;

  const downloadItems = [
    { value: "__download_hf_gguf__", label: `${theme.success("↓ GGUF from HuggingFace")} ${theme.subtle("(for llama.cpp)")}` },
  ];
  if (ollamaOn) {
    downloadItems.push({ value: "__download_ollama_library__", label: `${theme.success("↓ Model from Ollama library")} ${theme.subtle("(for Ollama)")}` });
    downloadItems.push({ value: "__download_ollama_hf__", label: `${theme.success("↓ GGUF from HuggingFace")} ${theme.subtle("(for Ollama)")}` });
  }
  if (omlxOn) {
    downloadItems.push({ value: "__download_omlx__", label: `${theme.success("↓ oMLX model")} ${theme.subtle("(open and download from oMLX app)")}` });
  }
  groups.push({ separator: theme.bold("Download"), items: downloadItems });

  const manageItems = [];
  if (isAppleSilicon && !omlxInstalled) {
    manageItems.push({ value: "__install_omlx__", label: `${theme.warning("↓ Install oMLX")} ${theme.subtle("(Apple Silicon — faster for MLX)")}` });
  }
  if (ollamaOn && !ollamaInstalled) {
    manageItems.push({ value: "__install_ollama__", label: `${theme.warning("↓ Install Ollama")} ${theme.subtle("(managed model runner)")}` });
  }
  manageItems.push({ value: "__runtime_status__", label: theme.brand("⚡ Runtime status & running models") });
  manageItems.push({ value: "__discovery_paths__", label: theme.brand("📁 Discovery paths") });
  groups.push({ separator: theme.bold("Manage"), items: manageItems });

  if (runningProfilesNow.length > 0) {
    console.log("");
  }

  const selected = await promptSelectModel({ message: "Select a model", groups });
  if (!selected) return;

  if (selected === "__download_hf_gguf__") {
    await downloadHfGguf();
    console.log("");
    return;
  }
  if (selected === "__download_ollama_library__") {
    await downloadOllamaLibrary();
    console.log("");
    return;
  }
  if (selected === "__download_ollama_hf__") {
    await downloadOllamaHfGguf();
    console.log("");
    return;
  }
  if (selected === "__download_omlx__") {
    console.log(status({ kind: "info", message: "oMLX models are downloaded from the oMLX app." }));
    console.log(theme.subtle("Open oMLX, browse the model library, and download a model. It will appear here automatically.\n"));
    return;
  }

  if (selected === "__runtime_status__") {
    await runtimeStatusFlow();
    console.log("");
    return;
  }
  if (selected === "__discovery_paths__") {
    await discoveryPathsFlow();
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
  const action = await promptChoice({ message: item.label, choices: actions });
  if (!action) return;
  await performAction(action, item, { benchOn });
  console.log("");
}

function formatActions(rawActions) {
  const sep = theme.subtle("  │  ");
  const maxName = Math.max(...rawActions.map((a) => stripVTControlCharacters(a.name).length));
  const width = Math.max(17, maxName + 2);
  return rawActions.map((a) => {
    const name = a.dimmed ? theme.subtle(a.name.padEnd(width).slice(0, width)) : theme.bold(a.name.padEnd(width).slice(0, width));
    const desc = a.dimmed ? theme.error(a.dimmedDesc ?? "not available") : theme.subtle(a.desc);
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

async function performAction(action, item, { benchOn = false } = {}) {
  const missing = item.type === "profile" && item.missing;
  if (missing && ["run", "reconfigure"].includes(action)) {
    const backend = item.type === "profile" ? backendFor(item.profile.backend) : null;
    const reason = backend?.type === "managed-server" ? "model is no longer available on the server" : "model file is no longer on disk";
    console.log(status({ kind: "error", message: `This model's ${reason}. Remove the setup or restore the model.` }));
    return;
  }
  if (action === "benchmark" && item.type === "profile") {
    if (!benchOn) return;
    const profile = item.profile;
    const isManaged = backendFor(profile.backend).type === "managed-server";
    if (!resolveBenchyModel(profile, isManaged)) {
      console.log(status({ kind: "warning", message: "Benchmarking is not supported for this model." }));
      console.log(theme.subtle("llama-benchy needs a HuggingFace model name for the tokenizer. Only models from HuggingFace can be benchmarked."));
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
  if (action === "reconfigure" || action === "setup") return await setupItem(item);
  if (action === "remove_config" && item.type === "profile") return await removeProfileInteractive(item.profile.id);
  if (action === "delete_model") return await deleteModelFromSource(item);
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
      console.log(status({ kind: "success", message: `[unload] ${profile.label}: model unloaded` }));
    } else if (result.reason) {
      console.log(theme.subtle(`[unload] ${profile.label}: ${result.reason}`));
    } else if (result.error) {
      console.log(status({ kind: "warning", message: `[unload] ${profile.label}: ${result.error}` }));
    }
  } else {
    const result = await stopProfile(profile);
    console.log(result.stopped ? status({ kind: "success", message: `[stop] ${result.message}` }) : theme.subtle(`[stop] ${result.message}`));
  }
}

function printProfileSaved(id) {
  console.log(theme.subtle(`  Profile: ${profileJsonPath(id)}`));
}

async function setupItem(item) {
  if (item.type === "profile") {
    const profile = await readProfile(item.profile.id);
    const backend = backendFor(profile.backend);
    const configured = backend.type === "managed-server"
      ? await configureManagedProfile(profile)
      : await configureLocalProfile(profile);
    if (!configured) return;
    await saveProfile(configured);
    await syncPiConfig(configured);
    printProfileSaved(configured.id);
    return;
  }
  if (item.type === "managed") {
    const profile = createManagedProfile(item.model, item.backendId);
    const configured = await configureManagedProfile(profile);
    if (!configured) return;
    await saveProfile(configured);
    await syncPiConfig(configured);
    printProfileSaved(configured.id);
    return;
  }
  const profile = await createProfileFromModel(item.model, null, item.drafter?.path);
  if (profile.capabilities?.missingContextLength) {
    console.log(status({ kind: "error", message: "\nCannot configure this model: GGUF metadata is missing context_length." }));
    console.log(theme.subtle("Without context_length, we cannot safely determine KV cache size —\nthis can cause out-of-memory errors or silent context truncation.\nUse a GGUF with complete metadata, or fix the file with a GGUF editor."));
    return;
  }
  const configured = await configureLocalProfile(profile);
  if (!configured) return;
  await saveProfile(configured);
  await syncPiConfig(configured);
  printProfileSaved(configured.id);
}

async function removeProfileInteractive(id) {
  const profile = await readProfile(id);
  if (!process.stdin.isTTY) {
    console.log(status({ kind: "error", message: `Use --force to remove ${id} non-interactively.` }));
    return;
  }
  const confirmed = await promptConfirm({ message: `Remove ${profile.label} (${profile.id})?`, initialValue: false });
  if (!confirmed) {
    console.log(theme.subtle("Cancelled."));
    return;
  }
  if (await isProfileRunning(profile)) {
    console.log(status({ kind: "warning", message: "Stopping running server..." }));
    await stopProfile(profile);
  }
  await removeFromPiConfig(profile);
  await deleteProfile(id);
  console.log(status({ kind: "success", message: `Removed ${profile.label} (${profile.id})` }));
}
