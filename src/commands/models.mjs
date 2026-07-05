import { ensureDirs, getModelScanDirs, addModelScanDir, removeModelScanDir, DEFAULT_MODEL_DIRS, findLlamaServer, HF_HUB_DIR } from "../config.mjs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { backendFor, BACKENDS } from "../backends.mjs";
import { createProfileFromModel, readProfile, saveProfile, deleteProfile, profileJsonPath } from "../profiles.mjs";
import { isProfileRunning, isProfileServerUp, modelAvailableOnServer, stopProfile } from "../process.mjs";
import { syncPiConfig, removeFromPiConfig, hasPi } from "../harness-pi.mjs";
import { hasOmlx } from "../omlx-runtime.mjs";
import { configureLocalProfile, configureManagedProfile } from "../profile-setup.mjs";
import { pc, startInteractive, createPrompt, modelSelect, renderCard, renderRows } from "../ui.mjs";
import { buildCatalogItems, createManagedProfile, itemKey, loadModelCatalog, normalizeCatalog } from "../model-catalog.mjs";
import { modelSelectOption, modelNameWidth, inferBackendId, formatSourceLabel, discoverySourceForItem, printGgufModelDetails, printManagedModelDetails, printProfileDetails } from "../model-presenters.mjs";
import { runProfile } from "./run.mjs";
import { downloadFlow } from "../download.mjs";

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
    groups.push({ separator: `  ${pc.yellow("Needs setup (" + setupItems.length + ")")}`, items: groupItems });
  }

  groups.push({ separator: " ", items: [
    { value: "__settings__", label: `${pc.dim("○")}  ${pc.cyan("⚙ Status & settings")}` },
    { value: "__download__", label: `${pc.dim("○")}  ${pc.green("↓ Download a model")}` },
  ] });

  const prompt = createPrompt();
  try {
    const selected = await modelSelect("Select a model", groups, { pageSize: 20 });
    if (!selected) return;

    if (selected === "__settings__") {
      await settingsFlow(prompt);
      return "rescan";
    }

    if (selected === "__download__") {
      await downloadFlow(prompt);
      return "rescan";
    }

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
    const desc = a.dimmed ? pc.red("not available") : pc.dim(a.desc);
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
      available.unshift(
        { value: "run", name: "Start chatting", desc: "Launch and open Pi" },
        { value: "reconfigure", name: "Reconfigure", desc: "Change context, MTP, settings" },
      );
    }
    available.push({ value: "remove", name: "Remove", desc: missing ? "Delete this broken setup" : "Delete this setup" });
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
    ]);
  }
  return formatActions([
    { value: "setup", name: "Set up", desc: `Connect via ${BACKENDS[item.backendId].label}` },
    { value: "inspect", name: "Details", desc: "Model info" },
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
  if (action === "inspect") {
    if (item.type === "profile") return await printProfileDetails(await readProfile(item.profile.id));
    if (item.type === "managed") return printManagedModelDetails(item.model, BACKENDS[item.backendId]);
    return printGgufModelDetails(item.model, item.drafter);
  }
  if (action === "run") return await runItem(item);
  if (action === "reconfigure" || action === "setup") return await setupItem(prompt, item);
  if (action === "remove" && item.type === "profile") return await removeProfileInteractive(item.profile.id);
}

async function runItem(item) {
  return await runProfile(await readProfile(item.profile.id));
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

// ── Settings & discovery path management ───────────────────────────────────

async function settingsFlow(prompt) {
  while (true) {
    const llamaBinary = await findLlamaServer();
    const omlxInstalled = await hasOmlx();
    const piInstalled = await hasPi();

    let omlxServerUp = false;
    if (omlxInstalled) {
      try {
        const res = await fetch("http://127.0.0.1:8000/v1/models", { signal: AbortSignal.timeout(2000) });
        omlxServerUp = res.ok;
      } catch { /* server down */ }
    }

    console.log("");
    console.log(renderCard("Runtime status", renderRows([
      ["llama.cpp", llamaBinary ? pc.green("✓ ") + pc.dim(llamaBinary) : pc.red("✗ not found")],
      ["oMLX", omlxInstalled ? (omlxServerUp ? pc.green("✓ server up") : pc.yellow("✓ installed · server down")) : pc.red("✗ not found")],
      ["Pi", piInstalled ? pc.green("✓ installed") : pc.red("✗ not found")],
    ]), { formatBorder: pc.cyan }));

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
      { value: "back", label: "Back to models" },
    ];
    const action = await prompt.choice("Settings", choices, "back");

    if (!action || action === "back") return;

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