import { ensureDirs, getModelScanDirs, addModelScanDir, removeModelScanDir, DEFAULT_MODEL_DIRS, findLlamaServer, HF_HUB_DIR } from "../config.mjs";
import { existsSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { backendFor, BACKENDS } from "../backends.mjs";
import { createProfileFromModel, readProfile, saveProfile, deleteProfile, profileJsonPath } from "../profiles.mjs";
import { isProfileRunning, isProfileServerUp, modelAvailableOnServer, stopProfile, serverReady } from "../process.mjs";
import { syncPiConfig, removeFromPiConfig, hasPi } from "../harness-pi.mjs";
import { hasOmlx, offerOmlxRestart, installOmlx } from "../omlx-runtime.mjs";
import { configureLocalProfile, configureManagedProfile } from "../profile-setup.mjs";
import { findOmlxModelDir } from "../mlx-discovery.mjs";
import { pc, startInteractive, createPrompt, modelSelect, renderCard, renderRows } from "../ui.mjs";
import { buildCatalogItems, createManagedProfile, itemKey, loadModelCatalog, normalizeCatalog } from "../model-catalog.mjs";
import { modelSelectOption, modelNameWidth, inferBackendId, formatSourceLabel, discoverySourceForItem, printGgufModelDetails, printManagedModelDetails, printProfileDetails } from "../model-presenters.mjs";
import { runProfile } from "./run.mjs";
import { downloadFlow } from "../download.mjs";
import { execFileAsync } from "../exec.mjs";

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

  // Build action items — conditionally include oMLX install on Apple Silicon
  const isAppleSilicon = process.platform === "darwin" && process.arch === "arm64";
  const omlxInstalled = isAppleSilicon ? await hasOmlx() : true;
  const actionItems = [
    { value: "__download__", label: `${pc.dim("○")}  ${pc.green("↓ Download a model")}` },
  ];
  if (isAppleSilicon && !omlxInstalled) {
    actionItems.push({ value: "__install_omlx__", label: `${pc.dim("○")}  ${pc.yellow("↓ Install oMLX")} ${pc.dim("(Apple Silicon — faster for MLX)")}` });
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
  if (action === "inspect") {
    if (item.type === "profile") return await printProfileDetails(await readProfile(item.profile.id));
    if (item.type === "managed") return printManagedModelDetails(item.model, BACKENDS[item.backendId]);
    return printGgufModelDetails(item.model, item.drafter);
  }
  if (action === "run") return await runItem(item);
  if (action === "reconfigure" || action === "setup") return await setupItem(prompt, item);
  if (action === "remove_config" && item.type === "profile") return await removeProfileInteractive(item.profile.id);
  if (action === "delete_model") return await deleteModelFromSource(prompt, item);
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
      const modelId = item.profile.omlxModel || item.profile.modelAlias || item.profile.id;
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
  if (loc.kind === "hf-cache" && loc.repoId) {
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
    const omlxInstalled = await hasOmlx();
    const piInstalled = await hasPi();

    let omlxServerUp = false;
    if (omlxInstalled) {
      omlxServerUp = await serverReady(BACKENDS.omlx.defaultBaseUrl);
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