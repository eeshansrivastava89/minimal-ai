import { ensureDirs } from "../config.mjs";
import { backendFor, BACKENDS } from "../backends.mjs";
import { createProfileFromModel, readProfile, saveProfile, deleteProfile, profileJsonPath } from "../profiles.mjs";
import { isProfileRunning, stopProfile } from "../process.mjs";
import { syncPiConfig, removeFromPiConfig } from "../harness-pi.mjs";
import { configureLocalProfile } from "../profile-setup.mjs";
import { pc, startInteractive, createPrompt } from "../ui.mjs";
import { buildCatalogItems, createManagedProfile, itemKey, loadModelCatalog, normalizeCatalog } from "../model-catalog.mjs";
import { modelSelectOption, printGgufModelDetails, printManagedModelDetails, printWorkspaceHeader, printBenchmarkLine, printTableHeader, printTableFooter, printProfileDetails } from "../model-presenters.mjs";
import { runProfile } from "./run.mjs";

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
  for (const profile of normalized.profiles) {
    if (await isProfileRunning(profile)) runningProfilesNow.push(profile);
  }
  printWorkspaceHeader(normalized, runningProfilesNow);
  await printBenchmarkLine();
  printTableHeader();

  const prompt = createPrompt();
  try {
    const selected = await prompt.choice("Select a model", allItems.map((item) => modelSelectOption(item, { runningProfilesNow })));
    if (!selected) return;
    const item = allItems.find((candidate) => itemKey(candidate) === selected);
    if (!item) return;
    printTableFooter();

    const actions = actionsForItem(item);
    const action = await prompt.choice(item.label, actions, actions[0].value);
    if (!action) return;
    await performAction(prompt, action, item);
  } finally {
    prompt.close();
  }
}



function actionsForItem(item) {
  if (item.type === "profile") {
    const actions = [
      { value: "run", label: "Start chatting", hint: "Launch and open Pi" },
      { value: "reconfigure", label: "Reconfigure", hint: "Change context, MTP, settings" },
      { value: "inspect", label: "Details", hint: "Paths, ports, flags" },
    ];
    const backend = backendFor(item.profile.backend);
    if (backend.type === "local-server" || backend.type === "managed-server") actions.push({ value: "benchmark", label: "Benchmark", hint: "Prepare a benchmark run" });
    if (!item.fileMissing) actions.push({ value: "remove", label: "Remove", hint: "Delete this setup" });
    return actions;
  }
  if (item.type === "new") {
    return [
      { value: "setup", label: "Set up", hint: "Configure and save" },
      { value: "inspect", label: "Details", hint: "Model info" },
    ];
  }
  return [
    { value: "setup", label: "Set up", hint: `Connect via ${BACKENDS[item.backendId].label}` },
    { value: "inspect", label: "Details", hint: "Model info" },
  ];
}

async function performAction(prompt, action, item) {
  if (action === "inspect") {
    if (item.type === "profile") return await printProfileDetails(await readProfile(item.profile.id));
    if (item.type === "managed") return printManagedModelDetails(item.model, BACKENDS[item.backendId]);
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
  if (action === "run") return await runItem(prompt, item);
  if (action === "reconfigure" || action === "setup") return await setupItem(prompt, item, action);
  if (action === "remove" && item.type === "profile") return await removeProfileInteractive(item.profile.id);
}

async function runItem(prompt, item) {
  if (item.type === "profile") return await runProfile(await readProfile(item.profile.id));
  const profile = await createProfileFromModel(item.model, null, item.drafter?.path);
  const configured = await configureLocalProfile(prompt, profile);
  if (!configured) return;
  await saveProfile(configured);
  await syncPiConfig(configured);
  printProfileSaved(configured.id);
  return await runProfile(configured);
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
