import { ensureDirs } from "../config.mjs";
import { backendFor, BACKENDS } from "../backends.mjs";
import { createProfileFromModel, readProfile, saveProfile, deleteProfile, profileJsonPath } from "../profiles.mjs";
import { isProfileRunning, isProfileServerUp, modelAvailableOnServer, stopProfile } from "../process.mjs";
import { syncPiConfig, removeFromPiConfig } from "../harness-pi.mjs";
import { configureLocalProfile } from "../profile-setup.mjs";
import { pc, startInteractive, createPrompt, modelSelect } from "../ui.mjs";
import { buildCatalogItems, createManagedProfile, itemKey, loadModelCatalog, normalizeCatalog } from "../model-catalog.mjs";
import { modelSelectOption, modelNameWidth, inferBackendId, formatSourceLabel, discoverySourceForItem, printGgufModelDetails, printMlxModelDetails, printManagedModelDetails, printWorkspaceHeader, printBenchmarkLine, printProfileDetails } from "../model-presenters.mjs";
import { runProfile } from "./run.mjs";

const { stripVTControlCharacters } = await import("node:util");

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

  const catalog = initialCatalog.newModels ? initialCatalog : await loadModelCatalog();
  const normalized = normalizeCatalog(catalog);
  const allItems = buildCatalogItems(normalized);
  if (allItems.length === 0) {
    console.log(pc.dim("No models found."));
    return;
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
  printWorkspaceHeader(normalized, runningProfilesNow, modelMissingIds);
  await printBenchmarkLine();

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
    const sep = sourceLabel && sourceLabel !== backendLabel
      ? `${backendLabel} · ${sourceLabel} (${items.length})`
      : `${backendLabel} (${items.length})`;
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
    groups.push({ separator: `  Needs setup (${setupItems.length})`, items: groupItems });
  }

  const prompt = createPrompt();
  try {
    const selected = await modelSelect("Select a model", groups, { pageSize: 20 });
    if (!selected) return;
    const item = allItems.find((candidate) => itemKey(candidate) === selected);
    if (!item) return;

    const actions = actionsForItem(item);
    const action = await prompt.choice(item.label, actions, actions[0].value);
    if (!action) return;
    await performAction(prompt, action, item);
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
    const desc = a.dimmed ? pc.red("file not found") : pc.dim(a.desc);
    return { value: a.value, label: name + sep + desc };
  });
}

function actionsForItem(item) {
  const missing = item.type === "profile" && item.fileMissing;
  if (item.type === "profile") {
    const available = [
      { value: "inspect", name: "Details", desc: "Paths, ports, flags" },
    ];
    if (!missing) {
      available.unshift(
        { value: "run", name: "Start chatting", desc: "Launch and open Pi" },
        { value: "reconfigure", name: "Reconfigure", desc: "Change context, MTP, settings" },
      );
      const backend = backendFor(item.profile.backend);
      if (backend.type === "local-server" || backend.type === "managed-server") {
        available.push({ value: "benchmark", name: "Benchmark", desc: "Prepare a benchmark run" });
      }
    }
    available.push({ value: "remove", name: "Remove", desc: missing ? "Delete this broken setup" : "Delete this setup" });
    if (missing) {
      available.unshift(
        { value: "run", name: "Start chatting", desc: "Launch and open Pi", dimmed: true },
        { value: "reconfigure", name: "Reconfigure", desc: "Change context, MTP, settings", dimmed: true },
      );
      const backend = backendFor(item.profile.backend);
      if (backend.type === "local-server" || backend.type === "managed-server") {
        available.push({ value: "benchmark", name: "Benchmark", desc: "Prepare a benchmark run", dimmed: true });
      }
    }
    return formatActions(available);
  }
  if (item.type === "new") {
    return formatActions([
      { value: "setup", name: "Set up", desc: "Configure and save" },
      { value: "inspect", name: "Details", desc: "Model info" },
    ]);
  }
  return formatActions([
    { value: "setup", name: "Set up", desc: `Connect via ${BACKENDS[item.backendId].label}` },
    { value: "inspect", name: "Details", desc: "Model info" },
  ]);
}

async function performAction(prompt, action, item) {
  const missing = item.type === "profile" && item.fileMissing;
  if (missing && ["run", "reconfigure", "benchmark"].includes(action)) {
    console.log(pc.red("This model's file is no longer on disk. Remove the setup or move the file back."));
    return;
  }
  if (action === "inspect") {
    if (item.type === "profile") return await printProfileDetails(await readProfile(item.profile.id));
    if (item.type === "managed") return printManagedModelDetails(item.model, BACKENDS[item.backendId]);
    if (item.model?.format === "mlx") return await printMlxModelDetails(item.model);
    return printGgufModelDetails(item.model, item.drafter);
  }
  if (action === "benchmark") {
    if (item.type === "profile") {
      const { benchmarkForProfile } = await import("../benchmark.mjs");
      return await benchmarkForProfile(await readProfile(item.profile.id));
    }
    const { benchmarkFlow } = await import("../benchmark.mjs");
    return await benchmarkFlow();
  }
  if (action === "run") return await runItem(item);
  if (action === "reconfigure" || action === "setup") return await setupItem(prompt, item, action);
  if (action === "remove" && item.type === "profile") return await removeProfileInteractive(item.profile.id);
}

async function runItem(item) {
  return await runProfile(await readProfile(item.profile.id));
}

function printProfileSaved(id) {
  console.log(pc.dim(`  Profile: ${profileJsonPath(id)}`));
}

async function setupItem(prompt, item, action) {
  if (item.type === "profile") {
    const configured = await configureLocalProfile(prompt, await readProfile(item.profile.id));
    if (!configured) return;
    await saveProfile(configured, { writeCommand: true });
    await syncPiConfig(configured);
    printProfileSaved(configured.id);
    return;
  }
  if (item.type === "managed") {
    const profile = createManagedProfile(item.model, item.backendId);
    await saveProfile(profile);
    await syncPiConfig(profile);
    printProfileSaved(profile.id);
    return;
  }
  // MLX models: build a mlx-vlm profile and run interactive config.
  if (item.model.format === "mlx") {
    const { createProfileFromMlxModel } = await import("../profiles.mjs");
    const { configureMlxProfile } = await import("../profile-setup.mjs");
    const profile = await createProfileFromMlxModel(item.model);
    const configured = await configureMlxProfile(prompt, profile);
    if (!configured) return;
    await saveProfile(configured, { writeCommand: true });
    await syncPiConfig(configured);
    printProfileSaved(configured.id);
    return;
  }
  const profile = await createProfileFromModel(item.model, null, item.drafter?.path);
  const configured = await configureLocalProfile(prompt, profile);
  if (!configured) return;
  await saveProfile(configured, { writeCommand: action === "reconfigure" });
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