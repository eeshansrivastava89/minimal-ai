import { totalmem } from "node:os";
import { existsSync, statSync, rmSync } from "node:fs";
import { ensureDirs, findLlamaServer, hasHomebrew, DATA_DIR } from "./config.mjs";
import { scanGgufModels } from "./scan.mjs";
import { createProfileFromModel, normalizeProfile } from "./profiles.mjs";
import { readProfile, saveProfile, deleteProfile, loadProfiles } from "./profiles.mjs";
import { backendFor, BACKENDS } from "./backends.mjs";
import { startServer, stopProfile, waitForReady, serverReady, isProfileRunning, profileRuntimeStatus } from "./process.mjs";
import { syncPiConfig, removeFromPiConfig, hasPiModel, launchPi, hasPi } from "./harness-pi.mjs";
import { tailFriendly } from "./logs.mjs";
import { estimateMemory } from "./estimate.mjs";
import { pc, formatBytes, renderRows, renderSection, renderCard, humanCapabilitySummary, statusText, startInteractive, createPrompt, parseOptions } from "./ui.mjs";
import { checkForUpdate, currentPackageVersion, detectInvocation, updateCommand, runUpdateCommand } from "./updates.mjs";
import { removeInstallerPathEntries } from "./shell-path.mjs";
import { configureLocalProfile } from "./profile-setup.mjs";
import { buildPrettyCommand } from "./command.mjs";
import { detectCapabilities } from "./autodetect.mjs";
import { offerManagedLlamaRuntimeUpdate } from "./runtime.mjs";

// ── Entry point ────────────────────────────────────────────────────────────

async function offerUpdate(argv) {
  const invocation = detectInvocation();
  const update = await checkForUpdate({ force: invocation === "npx" });
  if (!update) return false;

  const plan = updateCommand(invocation, argv);
  console.log(pc.yellow(`\nUpdate available: v${update.latest}. You have v${update.current}.`));
  console.log(pc.dim(`Run: ${plan.display}`));
  console.log();

  if (!process.stdin.isTTY) return false;

  const prompt = createPrompt();
  try {
    const shouldUpdate = await prompt.yesNo("Update now?", false);
    if (!shouldUpdate) return false;
    await runUpdateCommand(plan);
    if (plan.mode === "install-global") {
      console.log(pc.green("Updated. Run offgrid-ai again to use the new version."));
    }
    return true;
  } finally {
    prompt.close();
  }
}

export async function run(argv) {
  if (argv.length === 0) {
    if (await offerUpdate(argv)) return;
    return mainFlow();
  }
  const [command] = argv;

  if (command === "help" || command === "--help" || command === "-h") return printHelp();
  if (command === "version" || command === "--version" || command === "-v") return printVersion();
  if (command === "models") return modelsCommand(argv.slice(1));
  if (command === "run") return runCommand(argv.slice(1));
  if (command === "status") return statusCommand();
  if (command === "stop") return stopCommand(argv.slice(1));
  if (command === "uninstall" || command === "--uninstall") return uninstallCommand(argv.slice(1));
  if (command === "--verbose") return mainFlow(); // verbose flag handled inside onboardFlow

  throw new Error(`Unknown command: ${command}. Run offgrid-ai help`);
}

export async function mainFlow() {
  await ensureDirs();

  if (process.stdin.isTTY) {
    const runtimePrompt = createPrompt();
    try {
      await offerManagedLlamaRuntimeUpdate(runtimePrompt);
    } finally {
      runtimePrompt.close();
    }
  }

  // 1. Check what backends are available
  const llamaBinary = await findLlamaServer();
  const ggufModels = await scanGgufModels();
  const managedModels = await scanManagedModels();
  const profiles = await loadProfiles();
  const hasAnyBackend = llamaBinary || managedModels.some((m) => m.models.length > 0);
  const hasAnyModels = ggufModels.length > 0 || managedModels.some((m) => m.models.length > 0);
  const totalManaged = managedModels.reduce((sum, m) => sum + m.models.length, 0);

  // 2. Check mandatory deps — if anything essential is missing, re-offer onboarding
  const piInstalled = await hasPi();
  const brewInstalled = await hasHomebrew();
  const missingDeps = [];
  if (!brewInstalled) missingDeps.push("Homebrew");
  if (!llamaBinary) missingDeps.push("llama-server");
  if (!piInstalled) missingDeps.push("Pi");
  if (missingDeps.length > 0) {
    if (!process.stdin.isTTY) {
      throw new Error(`Missing dependencies: ${missingDeps.join(", ")}. Run offgrid-ai interactively to install.`);
    }
    console.log(pc.yellow(`Missing: ${missingDeps.join(", ")}`));
    console.log(pc.dim("offgrid-ai needs these to run. Let's finish setup.\n"));
    return await onboardFlow();
  }

  // 3. Nothing available at all — need onboarding
  if (!hasAnyBackend && !hasAnyModels && profiles.length === 0) {
    if (!process.stdin.isTTY) {
      throw new Error("No local LLM backends found. Run offgrid-ai interactively to set up.");
    }
    return await onboardFlow();
  }

  // 3. Has models but no llama-server (managed backends only)
  if (!llamaBinary && ggufModels.length > 0) {
    // They have GGUF files but can't run them — tell them about llama-server
    console.log(pc.yellow(`${ggufModels.length} GGUF model${ggufModels.length === 1 ? "" : "s"} found, but llama-server is not installed.`));
    console.log(pc.dim("Install it with: brew install llama.cpp"));
    console.log(pc.dim("Or use Ollama/oMLX for managed model backends."));
    if (totalManaged === 0 && profiles.length === 0) {
      return; // Nothing to do without llama-server
    }
    // Fall through — they can still use managed backends
  }

  // 4. No models found at all (but backends may exist)
  if (!hasAnyModels && profiles.length === 0) {
    if (!process.stdin.isTTY) {
      throw new Error("No models found. Download a model, then run offgrid-ai.");
    }
    console.log(pc.yellow("No models found."));
    console.log(pc.dim("You need to download a model to use offgrid-ai.\n"));
    // Detect which backends are installed
    const ollamaInstalled = await hasOllamaInstalled();
    const omlxInstalled = await hasOmlxInstalled();
    const lmStudioInstalled = existsSync("/Applications/LM Studio.app");
    const hasBackends = llamaBinary || ollamaInstalled || omlxInstalled || lmStudioInstalled;
    if (hasBackends) {
      console.log(pc.bold("Backend status:"));
      console.log(`  ${lmStudioInstalled ? pc.green("✓") : pc.red("✗")} LM Studio ${lmStudioInstalled ? "— installed" : "— not installed"}`);
      console.log(`  ${ollamaInstalled ? pc.green("✓") : pc.red("✗")} Ollama ${ollamaInstalled ? "— installed" : "— not installed"}`);
      console.log(`  ${omlxInstalled ? pc.green("✓") : pc.red("✗")} oMLX ${omlxInstalled ? "— installed" : "— not installed"}`);
      console.log(`  ${llamaBinary ? pc.green("✓") : pc.red("✗")} llama-server ${llamaBinary ? "— installed" : "— not installed"}`);
      console.log();
      const model = recommendedModel();
      console.log(pc.bold("Next step — download a model:"));
      if (lmStudioInstalled) {
        console.log("  Open LM Studio → browse models → download");
        console.log(pc.dim(`  Recommended: ${model.label}`));
      }
      if (ollamaInstalled) {
        console.log(pc.bold(`  ollama pull ${model.ollama}`));
      }
      if (omlxInstalled) {
        console.log(pc.bold("  omlx start"));
      }
    } else {
      console.log(pc.dim("Run offgrid-ai to install a backend and download a model."));
    }
    return;
  }

  // 5. If not interactive, just show status
  if (!process.stdin.isTTY) {
    await statusCommand();
    return;
  }

  // 6. Interactive: one command center after onboarding.
  startInteractive("offgrid-ai");
  return await modelCommandCenter({ profiles, ggufModels, managedModels });
}

// ── Model command center ────────────────────────────────────────────────────

async function modelsCommand(argv) {
  await ensureDirs();
  const catalog = await loadModelCatalog();

  if (argv[0]) {
    const profile = await readProfile(argv[0]);
    await printProfileDetails(profile);
    return;
  }

  if (process.stdin.isTTY) startInteractive("offgrid-ai");
  return await modelCommandCenter(catalog);
}

async function modelCommandCenter(catalog) {
  const normalized = normalizeCatalog(catalog);
  const items = modelCatalogItems(normalized);
  await printModelCatalog(normalized, items);
  if (!process.stdin.isTTY) return;

  if (items.length === 0) return;

  const prompt = createPrompt();
  try {
    const action = await prompt.choice("What would you like to do?", [
      { value: "run", label: "Start chatting", hint: "Start a local model and open Pi" },
      { value: "setup", label: "Set up a downloaded model", hint: "One-time setup or Pi sync" },
      { value: "inspect", label: "See model details", hint: "Show advanced paths, ports, and flags" },
      { value: "benchmark", label: "Benchmark", hint: "Coming soon" },
      { value: "remove", label: "Remove a saved setup", hint: "Delete a model setup from offgrid-ai" },
    ], "run");
    if (action === "benchmark") return await benchmarkFlow();
    const item = await chooseCatalogItem(prompt, items, action);
    if (!item) return;
    return await handleCatalogAction(prompt, action, item);
  } finally {
    prompt.close();
  }
}

async function runCommand(argv) {
  await ensureDirs();
  const { positional } = parseOptions(argv);
  if (!positional[0]) return await mainFlow();
  const profile = await readProfile(positional[0]);
  return await runProfile(profile);
}

async function loadModelCatalog() {
  const [profiles, ggufModels, managedModels] = await Promise.all([
    loadProfiles(),
    scanGgufModels(),
    scanManagedModels(),
  ]);
  return normalizeCatalog({ profiles, ggufModels, managedModels });
}

function normalizeCatalog(catalog) {
  if (catalog.newModels && catalog.managedItems) return catalog;
  const { profiles, ggufModels, managedModels } = catalog;
  const profiledPaths = new Set(profiles.map((p) => p.modelPath).filter(Boolean));
  const newModels = ggufModels.filter((m) => !profiledPaths.has(m.path));
  const managedItems = [];
  for (const { backendId, models } of managedModels) {
    const profiledAliases = new Set(
      profiles.filter((p) => p.backend === backendId).map((p) => backendId === "ollama" ? `ollama:${p.ollamaModel ?? p.modelAlias}` : `omlx:${p.omlxModel ?? p.modelAlias}`)
    );
    for (const model of models) {
      if (!profiledAliases.has(`${backendId}:${model.id}`)) managedItems.push({ model, backendId });
    }
  }
  return { profiles, ggufModels, managedModels, newModels, managedItems };
}

async function printModelCatalog({ profiles, newModels, managedItems }, items = modelCatalogItems({ profiles, newModels, managedItems })) {
  const itemNumber = (predicate) => {
    const index = items.findIndex(predicate);
    return index === -1 ? "  " : String(index + 1).padStart(2, " ");
  };
  const runningProfilesNow = [];
  for (const profile of profiles) {
    if (await isProfileRunning(profile)) runningProfilesNow.push(profile);
  }

  console.log("\n" + renderCard("Your local AI workspace", renderRows([
    ["Ready to chat", pc.green(`${profiles.length} saved setup${profiles.length === 1 ? "" : "s"}`)],
    ["Need setup", newModels.length > 0 ? pc.yellow(`${newModels.length} downloaded model${newModels.length === 1 ? "" : "s"}`) : pc.green("none")],
    ["Running now", runningProfilesNow.length > 0 ? pc.green(String(runningProfilesNow.length)) : pc.dim("none")],
    ["Next step", profiles.length > 0 ? "Start chatting" : newModels.length > 0 ? "Set up a downloaded model" : "Download a model"],
  ]), { formatBorder: pc.cyan }));

  console.log("\n" + pc.bold("Ready to chat"));
  if (profiles.length === 0) {
    console.log(renderCard("No saved setups yet", "Downloaded models will appear below. Set one up once, then it will be ready from here.", { formatBorder: pc.yellow }));
  } else {
    for (const profile of profiles) {
      const running = runningProfilesNow.some((item) => item.id === profile.id);
      const piConfigured = await hasPiModel(profile);
      const num = itemNumber((item) => item.type === "profile" && item.profile.id === profile.id);
      console.log(profileCatalogCard(num, profile, { running, piConfigured }));
    }
  }

  console.log("\n" + pc.bold("Downloaded, needs one-time setup"));
  if (newModels.length === 0) {
    console.log(renderCard("All set", "Every downloaded local model already has a saved setup.", { formatBorder: pc.green }));
  } else {
    for (const model of newModels.slice(0, 20)) {
      const caps = detectCapabilities(model.path, model.mmprojPath);
      const num = itemNumber((item) => item.type === "new" && item.model.path === model.path);
      console.log(downloadedModelCard(num, model, caps));
    }
    if (newModels.length > 20) console.log(pc.dim(`  ... and ${newModels.length - 20} more`));
  }

  for (const backendId of ["ollama", "omlx"]) {
    const backendItems = managedItems.filter((item) => item.backendId === backendId);
    if (backendItems.length === 0) continue;
    const be = BACKENDS[backendId];
    console.log("\n" + pc.bold(`Local models via ${be.label}`));
    for (const { model } of backendItems.slice(0, 10)) {
      const num = itemNumber((item) => item.type === "managed" && item.backendId === backendId && item.model.id === model.id);
      console.log(managedModelCard(num, model, be));
    }
    if (backendItems.length > 10) console.log(pc.dim(`  ... and ${backendItems.length - 10} more`));
  }
}

function profileCatalogCard(num, profile, { running, piConfigured }) {
  const backend = backendFor(profile.backend);
  const caps = profile.capabilities ?? {};
  const status = running ? statusText("running", "Running now") : statusText("ready", "Ready to chat");
  return renderCard(`${num}. ${profile.label}`, renderRows([
    ["Status", status],
    ["Good for", humanCapabilitySummary(caps)],
    ["Pi", piConfigured ? pc.green("Synced") : pc.yellow("Needs sync")],
    ["Runs with", backend.label],
  ]), { formatBorder: running ? pc.green : pc.cyan });
}

function downloadedModelCard(num, model, caps) {
  return renderCard(`${num}. ${model.label}`, renderRows([
    ["Status", statusText("warning", "Needs one-time setup")],
    ["Good for", humanCapabilitySummary(caps)],
    ["Size", formatBytes(model.sizeBytes)],
  ]), { formatBorder: pc.yellow });
}

function managedModelCard(num, model, backend) {
  return renderCard(`${num}. ${model.label}`, renderRows([
    ["Status", statusText("info", `Local model via ${backend.label}`)],
    ["Runs with", backend.label],
    ["Model ID", pc.cyan(model.id)],
    ...(model.quant ? [["Size/type", model.quant]] : []),
  ]), { formatBorder: pc.magenta });
}

function modelCatalogItems({ profiles, newModels, managedItems }) {
  return [
    ...profiles.map((profile) => ({ type: "profile", profile, label: profile.label, hint: `${profile.modelAlias} · ${profile.baseUrl}` })),
    ...newModels.map((model) => ({ type: "new", model, label: model.label, hint: `${model.quant ?? "GGUF"} · ${formatBytes(model.sizeBytes)}` })),
    ...managedItems.map(({ model, backendId }) => ({ type: "managed", model, backendId, label: model.label, hint: BACKENDS[backendId].label })),
  ];
}

async function chooseCatalogItem(prompt, items, action) {
  if (action === "remove" && !items.some((item) => item.type === "profile")) {
    console.log(pc.yellow("No saved profiles to remove."));
    return null;
  }

  const input = await prompt.text(action === "remove" ? "Which saved setup should be removed? Enter its number" : "Which model? Enter its number", "");
  if (!input) return null;
  const index = Number(input) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    console.log(pc.yellow(`No item ${input}.`));
    return null;
  }

  const item = items[index];
  if (action === "remove" && item.type !== "profile") {
    console.log(pc.yellow("Only saved profiles can be removed."));
    return null;
  }
  return item;
}

async function handleCatalogAction(prompt, action, item) {
  if (action === "inspect") {
    if (item.type === "profile") return await printProfileDetails(await readProfile(item.profile.id));
    if (item.type === "managed") return printManagedModelDetails(item.model, BACKENDS[item.backendId]);
    return printGgufModelDetails(item.model);
  }

  if (action === "setup") {
    if (item.type === "profile") return await syncPiConfig(await readProfile(item.profile.id));
    if (item.type === "managed") {
      const profile = createManagedProfile(item.model, item.backendId);
      await saveProfile(profile);
      return await syncPiConfig(profile);
    }
    const profile = await createProfileFromModel(item.model);
    const configured = await configureLocalProfile(prompt, profile);
    if (!configured) return;
    await saveProfile(configured);
    return await syncPiConfig(configured);
  }

  if (action === "run") {
    if (item.type === "profile") return await runProfile(await readProfile(item.profile.id));
    if (item.type === "managed") {
      const profile = createManagedProfile(item.model, item.backendId);
      await saveProfile(profile);
      await syncPiConfig(profile);
      return await runProfile(profile);
    }
    const profile = await createProfileFromModel(item.model);
    const configured = await configureLocalProfile(prompt, profile);
    if (!configured) return;
    await saveProfile(configured);
    await syncPiConfig(configured);
    return await runProfile(configured);
  }

  if (action === "remove" && item.type === "profile") return await removeProfileInteractive(item.profile.id);
}

async function printProfileDetails(profile) {
  const backend = backendFor(profile.backend);
  const isManaged = backend.type === "managed-server";
  const piConfigured = await hasPiModel(profile);
  const running = await isProfileRunning(profile);
  console.log("\n" + renderSection("Model overview", renderRows([
    ["Name", pc.bold(profile.label)],
    ["Status", running ? pc.green("Running now") : pc.green("Ready to chat")],
    ["Good for", humanCapabilitySummary(profile.capabilities ?? {})],
    ["Pi", piConfigured ? pc.green("Synced") : pc.yellow("Needs sync")],
    ["Server", pc.green(profile.baseUrl)],
  ])));

  console.log("\n" + renderSection("Model details", renderRows([
    ["Setup ID", pc.cyan(profile.id)],
    ["Runs with", backend.label],
    ["Model alias", pc.cyan(profile.modelAlias)],
    ...(profile.capabilities ? [["Detected", capabilitySummary(profile.capabilities)]] : []),
    ...(!isManaged ? [
      ["Local file", profile.modelPath ?? "unknown"],
      ["Vision file", profile.mmprojPath ?? "none"],
      ["Model size", profile.modelPath && existsSync(profile.modelPath) ? formatBytes(statSync(profile.modelPath).size) : "unknown"],
    ] : []),
  ]), { columns: 110 }));

  if (!isManaged && profile.commandArgv) {
    console.log("\n" + renderSection("llama-server command", pc.dim(buildPrettyCommand(profile)), { columns: 120 }));
  }
}

function printGgufModelDetails(model) {
  const caps = detectCapabilities(model.path, model.mmprojPath);
  console.log("\n" + renderSection("Downloaded model", renderRows([
    ["Name", pc.bold(model.label)],
    ["Status", pc.yellow("Needs one-time setup")],
    ["Good for", humanCapabilitySummary(caps)],
    ["Size", formatBytes(model.sizeBytes)],
  ])));
  console.log("\n" + renderSection("Model details", renderRows([
    ["Local file", model.path],
    ["Vision file", model.mmprojPath ?? "none"],
    ["Detected", capabilitySummary(caps)],
    ["Quant", model.quant ?? "unknown"],
  ]), { columns: 110 }));
}

function printManagedModelDetails(model, backend) {
  console.log("\n" + renderSection(`${backend.label} model`, renderRows([
    ["Name", pc.bold(model.label)],
    ["Status", pc.green(`Local model via ${backend.label}`)],
    ["Model ID", pc.cyan(model.id)],
    ["Quant", model.quant ?? "unknown"],
    ["Family", model.family ?? "unknown"],
  ])));
}

function capabilitySummary(caps) {
  const parts = [];
  if (caps.architecture) parts.push(caps.architecture);
  if (caps.quant) parts.push(caps.quant);
  if (caps.mtp) parts.push("MTP");
  if (caps.qat) parts.push("QAT");

  if (caps.thinking) parts.push("thinking");
  if (caps.vision) parts.push("vision");
  return parts.length > 0 ? parts.join(" · ") : "standard GGUF";
}

function isUnsupportedMmprojError(err, profile) {
  const message = String(err?.message ?? "");
  return Boolean(profile.mmprojPath && /unknown projector type|failed to load multimodal model|failed to load CLIP model/i.test(message));
}

function textOnlyProfile(profile) {
  return normalizeProfile({
    ...profile,
    mmprojPath: null,
    disabledMmprojPath: profile.disabledMmprojPath ?? profile.mmprojPath,
    capabilities: { ...(profile.capabilities ?? {}), vision: false, visionDisabledReason: "unsupported-mmproj" },
    commandArgv: removeCommandOption(profile.commandArgv ?? [], "--mmproj"),
  });
}

function removeCommandOption(argv, flag) {
  const next = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      if (argv[i + 1] && !argv[i + 1].startsWith("--")) i += 1;
      continue;
    }
    next.push(argv[i]);
  }
  return next;
}

function createManagedProfile(model, backendId) {
  return normalizeProfile({
    id: model.id.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase(),
    label: model.label,
    backend: backendId,
    modelAlias: model.aliasSuggestion,
    ...(backendId === "ollama" ? { ollamaModel: model.id } : {}),
    ...(backendId === "omlx" ? { omlxModel: model.id } : {}),
  });
}

async function runProfile(profile, options = {}) {
  const backend = backendFor(profile.backend);
  const withHarness = options.with ?? "pi";

  // Check harness
  if (withHarness === "pi") {
    const piInstalled = await hasPi();
    if (!piInstalled) {
      console.log(pc.yellow("Pi is not installed. Run with --with server, or install Pi from https://pi.app"));
      console.log(pc.dim("Starting server only..."));
      return await runProfile(profile, { ...options, with: "server" });
    }
  }

  const isManaged = backend.type === "managed-server";

  // Start/verify server
  if (isManaged) {
    if (!(await serverReady(profile.baseUrl))) {
      throw new Error(`${backend.label} is not running at ${profile.baseUrl}. Start it and try again.`);
    }
    console.log(pc.green(`[ready] ${backend.label} at ${profile.baseUrl}`));
  } else {
    const ready = await serverReady(profile.baseUrl);
    if (ready) {
      console.log(pc.green(`[ready] Reusing server at ${profile.baseUrl}`));
    } else {
      console.log(pc.dim(`Starting ${backend.label} for ${profile.label}...`));
      let state;
      try {
        state = await startServer(profile);
        const tail = state?.rawLogPath ? tailFriendly(state.rawLogPath, state.friendlyLogPath) : { stop() {} };
        try {
          await waitForReady(profile, state?.pid, state?.rawLogPath);
          console.log(pc.green(`[ready] ${profile.baseUrl}/models`));
        } finally {
          tail.stop();
        }
      } catch (err) {
        // Clean up orphaned server process if startup failed
        if (state?.pid) {
          try { await stopProfile(profile); } catch { /* best effort */ }
        }
        if (!options.textOnlyRetry && isUnsupportedMmprojError(err, profile)) {
          console.log(pc.yellow("Vision projector is not supported by this llama.cpp build. Retrying text-only."));
          console.log(pc.dim("Update llama.cpp later to re-enable vision for this model."));
          const textOnly = textOnlyProfile(profile);
          await saveProfile(textOnly);
          return await runProfile(textOnly, { ...options, textOnlyRetry: true });
        }
        throw err;
      }
    }
  }

  // Show memory estimate for local models
  if (!isManaged && profile.modelPath && existsSync(profile.modelPath)) {
    try {
      const est = estimateMemory(profile.modelPath, profile.mmprojPath, null, profile.flags);
      console.log(renderSection("Memory estimate", renderRows([
        ["Estimated total", pc.bold(`~${formatBytes(est.totalBytes)}`)],
        ["Model file", formatBytes(est.modelBytes)],
        ["Conversation memory", est.kvBytes ? `~${formatBytes(est.kvBytes)}` : "unknown"],
      ])));
    } catch { /* estimate failed, skip */ }
  }

  // Launch harness
  if (withHarness === "pi") {
    if (!(await hasPiModel(profile))) await syncPiConfig(profile);
    try {
      await launchPi(profile);
    } finally {
      if (!isManaged && !options["keep-server"]) {
        const result = await stopProfile(profile);
        console.log(result.stopped ? pc.green(`[stop] ${result.message}`) : pc.dim(`[stop] ${result.message}`));
      }
    }
  } else {
    if (!isManaged) {
      console.log(pc.dim(`Server running at ${profile.baseUrl}`));
      console.log(pc.dim(`Stop with: offgrid-ai stop ${profile.id}`));
    } else {
      console.log(pc.dim(`${backend.label} is a managed service — offgrid-ai does not stop it.`));
    }
  }
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
    if (!confirmed) { console.log(pc.dim("Cancelled.")); return; }
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

// ── Benchmark (stub) ────────────────────────────────────────────────────────

async function benchmarkFlow() {
  console.log("\n" + renderCard("Benchmark", renderRows([
    ["Status", pc.yellow("Coming soon")],
    ["What it will do", "Compare local models with repeatable prompts"],
    ["For now", "Start a model with offgrid-ai, then run benchmarks manually"],
  ]), { formatBorder: pc.yellow }));
}

// ── Status ──────────────────────────────────────────────────────────────────

async function statusCommand() {
  await ensureDirs();
  const profiles = await loadProfiles();

  // Check all profiles for running status
  const statuses = [];
  for (const profile of profiles) {
    const status = await profileRuntimeStatus(profile);
    statuses.push({ profile, status });
  }

  const running = statuses.filter((s) => s.status.running);

  if (running.length === 0) {
    console.log(renderCard("Status", renderRows([
      ["Running now", pc.dim("none")],
      ["Ready setups", profiles.length > 0 ? pc.green(String(profiles.length)) : pc.dim("none")],
      ["Next step", profiles.length > 0 ? "Run offgrid-ai to start chatting" : "Run offgrid-ai to set up a model"],
    ]), { formatBorder: profiles.length > 0 ? pc.cyan : pc.yellow }));
    return;
  }

  console.log(renderCard("Status", renderRows([
    ["Running now", pc.green(`${running.length} model${running.length === 1 ? "" : "s"}`)],
    ["Stop", "offgrid-ai stop"],
  ]), { formatBorder: pc.green }));
  for (const { profile, status } of running) {
    const backend = backendFor(profile.backend);
    console.log("\n" + renderCard(profile.label, renderRows([
      ["Status", status.ready ? pc.green("Ready") : pc.yellow("Starting up")],
      ["Runs with", backend.label],
      ["Process", `pid ${status.pid}`],
      ["Server", profile.baseUrl],
    ]), { formatBorder: status.ready ? pc.green : pc.yellow }));
  }
}

// ── Stop ────────────────────────────────────────────────────────────────────

async function stopCommand(argv) {
  await ensureDirs();
  const { positional, options } = parseOptions(argv);

  if (options.all) return stopAll();
  if (positional[0]) return stopOne(positional[0]);

  // Interactive
  const running = await runningProfiles();
  if (running.length === 0) {
    console.log(pc.dim("No offgrid-ai servers are running."));
    return;
  }

  if (!process.stdin.isTTY) {
    for (const { profile, status } of running) {
      console.log(`  ${pc.green("●")} ${pc.bold(profile.label)} · pid ${status.pid}`);
    }
    console.log(pc.dim("Stop with: offgrid-ai stop <id>"));
    return;
  }

  startInteractive("offgrid-ai stop");
  const prompt = createPrompt();
  try {
    const choices = running.map(({ profile, status }) => ({
      value: profile.id, label: profile.label, hint: `pid ${status.pid} · ${profile.baseUrl}`,
    }));
    if (running.length > 1) choices.unshift({ value: "__all", label: "Stop all", hint: `${running.length} servers` });
    choices.push({ value: "__cancel", label: "Cancel" });

    const selected = await prompt.choice("Stop", choices, choices[0].value);
    if (selected === "__cancel") return;

    const targets = selected === "__all" ? running : running.filter((i) => i.profile.id === selected);
    for (const { profile } of targets) {
      const result = await stopProfile(profile);
      console.log(result.stopped ? pc.green(result.message) : pc.yellow(result.message));
    }
  } finally {
    prompt.close();
  }
}

async function stopOne(id) {
  const profile = await readProfile(id);
  const result = await stopProfile(profile);
  console.log(result.stopped ? pc.green(result.message) : pc.yellow(result.message));
}

async function stopAll() {
  const running = await runningProfiles();
  if (running.length === 0) {
    console.log(pc.dim("No offgrid-ai servers are running."));
    return;
  }
  for (const { profile } of running) {
    const result = await stopProfile(profile);
    console.log(result.stopped ? pc.green(result.message) : pc.yellow(result.message));
  }
}

async function runningProfiles() {
  const profiles = await loadProfiles();
  const statuses = await Promise.all(profiles.map(async (profile) => ({ profile, status: await profileRuntimeStatus(profile) })));
  return statuses.filter((i) => i.status.running);
}

// ── Onboarding ──────────────────────────────────────────────────────────────

// ── Model recommendations by RAM ───────────────────────────────────────
// Tier → { lms: [...], ollama: string, label }
// lms entries are tried in order (first staff-pick match wins, or @quant forces it)
const MODEL_TIERS = [
  { maxGB: 8,  lms: "google/gemma-4-e2b",                   ollama: "gemma4:e2b",             label: "Gemma 4 E2B (2B effective)" },
  { maxGB: 16, lms: "google/gemma-4-e4b",                   ollama: "gemma4:e4b",             label: "Gemma 4 E4B (4B effective)" },
  { maxGB: 32, lms: "qwen/qwen3.5-9b",                     ollama: "qwen3.5:9b-q4_K_M",     label: "Qwen 3.5 9B" },
  { maxGB: Infinity, lms: "qwen/qwen3.6-35b-a3b",          ollama: "qwen3.6:35b-a3b",        label: "Qwen 3.6 35B-A3B" },
];

function recommendedModel() {
  const gb = totalmem() / (1024 ** 3);
  const tier = MODEL_TIERS.find(t => gb <= t.maxGB) || MODEL_TIERS[MODEL_TIERS.length - 1];
  return tier;
}

async function onboardFlow() {
  startInteractive("offgrid-ai setup");
  const prompt = createPrompt();
  const verbose = process.argv.includes("--verbose");

  const { spawn } = await import("node:child_process");

  /** Run a command. Verbose: stream output. Quiet: show only label + result. */
  const run = (cmd, args, label) => new Promise((resolve, reject) => {
    if (verbose) {
      const child = spawn(cmd, args, { stdio: "inherit" });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${label || cmd} exited with code ${code}`));
      });
      child.on("error", (err) => reject(err));
    } else {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.split("\n").filter(l => l.trim()).slice(-3).join("\n") || `${label || cmd} exited with code ${code}`));
      });
      child.on("error", (err) => reject(err));
    }
  });
  try {
    console.log(pc.bold("Welcome to offgrid-ai!"));
    console.log(pc.dim("Let's make sure you have everything you need to run local models.\n"));

    // 1. Homebrew
    const hasBrew = await hasHomebrew();
    if (!hasBrew) {
      const install = await prompt.yesNo("Homebrew is required. Install it now?", true);
      if (!install) {
        console.log(pc.red("offgrid-ai needs Homebrew to install dependencies."));
        console.log(pc.dim("Install it from https://brew.sh, then run offgrid-ai again."));
        return;
      }
      console.log(pc.cyan("Installing Homebrew..."));
      try {
        await run("/bin/bash", ["-c", "NONINTERACTIVE=1 /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""], "Homebrew");
        // Add brew to PATH for this session
        const brewPaths = ["/opt/homebrew/bin", "/usr/local/bin"];
        for (const p of brewPaths) {
          if (existsSync(p)) {
            process.env.PATH = `${p}:${process.env.PATH}`;
            break;
          }
        }
      } catch {
        console.log(pc.red(`✗ Homebrew installation failed.`));
        console.log(pc.dim("Install it manually from https://brew.sh, then run offgrid-ai again."));
        return;
      }
      if (!(await hasHomebrew())) {
        console.log(pc.red("Homebrew was installed but not found on PATH. Restart your terminal and run offgrid-ai again."));
        return;
      }
    }
    console.log(pc.green("✓ Homebrew found"));

    // 2. llama-server
    let llamaBinary = await findLlamaServer();
    if (!llamaBinary) {
      const install = await prompt.yesNo("llama-server is required to run local models. Install via Homebrew?", true);
      if (!install) {
        console.log(pc.red("offgrid-ai needs llama-server to run local models."));
        console.log(pc.dim("Install it manually: brew install llama.cpp"));
        return;
      }
      console.log(pc.cyan("Installing llama.cpp..."));
      try {
        await run("brew", ["install", "llama.cpp"], "llama.cpp");
        llamaBinary = await findLlamaServer();
      } catch {
        console.log(pc.red("✗ Failed to install llama.cpp."));
        console.log(pc.dim("Install it manually: brew install llama.cpp"));
        return;
      }
      if (!llamaBinary) {
        console.log(pc.yellow("llama.cpp installed but llama-server not found. You may need to restart your terminal."));
        return;
      }
    }
    console.log(pc.green(`✓ llama-server: ${llamaBinary}`));

    // 3. Pi coding agent
    const piInstalled = await hasPi();
    if (!piInstalled) {
      const install = await prompt.yesNo("Pi coding agent is required to chat with models. Install via npm?", true);
      if (!install) {
        console.log(pc.red("offgrid-ai needs Pi to run models."));
        console.log(pc.dim("Install it manually: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"));
        return;
      }
      console.log(pc.cyan("Installing Pi..."));
      try {
        await run("npm", ["install", "-g", "--ignore-scripts", "@earendil-works/pi-coding-agent"], "Pi");
      } catch {
        console.log(pc.red("✗ Failed to install Pi."));
        console.log(pc.dim("Install it manually: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"));
        return;
      }
      if (!(await hasPi())) {
        console.log(pc.yellow("Pi was installed but not found on PATH. Restart your terminal and run offgrid-ai again."));
        return;
      }
    }
    console.log(pc.green("✓ Pi found"));

    // 4. Model backends — at least one is mandatory
    const ggufModels = await scanGgufModels();
    const managedModels = await scanManagedModels();
    const totalManaged = managedModels.reduce((sum, m) => sum + m.models.length, 0);
    const hasModels = ggufModels.length > 0 || totalManaged > 0;

    if (hasModels) {
      // They already have models — show what was found
      if (ggufModels.length > 0) {
        console.log(pc.green(`✓ Found ${ggufModels.length} GGUF model${ggufModels.length === 1 ? "" : "s"}`));
      }
      for (const { backendId, models } of managedModels) {
        if (models.length > 0) {
          console.log(pc.green(`✓ ${BACKENDS[backendId].label}: ${models.length} model${models.length === 1 ? "" : "s"}`));
        }
      }
    } else {
      // No models found — offer to install backends that come with models
      console.log(pc.yellow("\nNo models found."));
      console.log(pc.dim("You need at least one model backend to use offgrid-ai.\n"));

      const backendChoice = await prompt.choice("Install a model backend?", [
        { value: "lmstudio", label: "LM Studio (recommended)", hint: "brew install --cask lm-studio — visual model browser + CLI" },
        { value: "ollama", label: "Ollama", hint: "brew install ollama — models download on demand" },
        { value: "omlx", label: "oMLX", hint: "brew tap jundot/omlx && brew install omlx — Apple Silicon optimized" },
        { value: "all", label: "Install all three", hint: "LM Studio + Ollama + oMLX" },
        { value: "skip", label: "Skip for now", hint: "I'll set up models myself" },
      ], "lmstudio");

      const model = recommendedModel();

      if (backendChoice === "lmstudio") {
        console.log(pc.cyan("Installing LM Studio via Homebrew..."));
        try {
          await run("brew", ["install", "--cask", "lm-studio"], "LM Studio");
          console.log(pc.green("✓ LM Studio installed"));
          console.log(pc.yellow("\nOpen LM Studio and download a model to get started."));
          console.log(pc.dim(`Recommended for your machine: ${model.label}`));
          console.log(pc.dim("Then run offgrid-ai again to pick and run a model."));
        } catch {
          console.log(pc.red("✗ LM Studio installation failed."));
          console.log(pc.dim("Download it manually from https://lmstudio.ai"));
        }
      } else if (backendChoice === "ollama") {
        console.log(pc.cyan("Installing Ollama via Homebrew..."));
        try {
          await run("brew", ["install", "ollama"], "Ollama");
          console.log(pc.green("✓ Ollama installed"));
          console.log(pc.yellow("\nStart Ollama and pull a model:"));
          console.log(pc.bold(`  ollama serve \u0026   ollama pull ${model.ollama}`));
          console.log(pc.dim(`Recommended for your machine: ${model.label}`));
          console.log(pc.dim("Then run offgrid-ai again to pick and run a model."));
        } catch {
          console.log(pc.red("✗ Ollama installation failed."));
          console.log(pc.dim("Install it manually from https://ollama.com"));
        }
      } else if (backendChoice === "omlx") {
        console.log(pc.cyan("Installing oMLX via Homebrew..."));
        try {
          await run("brew", ["tap", "jundot/omlx", "https://github.com/jundot/omlx"], "oMLX tap");
          await run("brew", ["install", "omlx"], "oMLX");
          console.log(pc.green("✓ oMLX installed"));
          console.log(pc.yellow("\nStart oMLX and download a model:"));
          console.log(pc.bold("  omlx start"));
          console.log(pc.dim(`Recommended for your machine: ${model.label}`));
          console.log(pc.dim("Then run offgrid-ai again to pick and run a model."));
        } catch {
          console.log(pc.red("✗ oMLX installation failed."));
          console.log(pc.dim("Install manually: brew tap jundot/omlx && brew install omlx"));
        }
      } else if (backendChoice === "all") {
        let installed = [];
        // LM Studio
        console.log(pc.cyan("Installing LM Studio via Homebrew..."));
        try {
          await run("brew", ["install", "--cask", "lm-studio"], "LM Studio");
          installed.push("LM Studio");
        } catch {
          console.log(pc.yellow("✗ LM Studio installation failed. Download from https://lmstudio.ai"));
        }
        // Ollama
        console.log(pc.cyan("Installing Ollama via Homebrew..."));
        try {
          await run("brew", ["install", "ollama"], "Ollama");
          installed.push("Ollama");
        } catch {
          console.log(pc.yellow("✗ Ollama installation failed. Install manually from https://ollama.com"));
        }
        // oMLX
        console.log(pc.cyan("Installing oMLX via Homebrew..."));
        try {
          await run("brew", ["tap", "jundot/omlx", "https://github.com/jundot/omlx"], "oMLX tap");
          await run("brew", ["install", "omlx"], "oMLX");
          installed.push("oMLX");
        } catch {
          console.log(pc.yellow("✗ oMLX installation failed. Install manually: brew tap jundot/omlx && brew install omlx"));
        }
        if (installed.length > 0) {
          console.log(pc.green(`\n✓ Installed: ${installed.join(", ")}`));
          console.log(pc.dim(`Recommended for your machine (${(totalmem() / (1024 ** 3)).toFixed(0)}GB RAM): ${model.label}`));
        }
      } else {
        console.log(pc.dim("Run offgrid-ai again when you've set up a model backend."));
      }
      return;
    }

    console.log(pc.green("\n✓ Setup complete! Run offgrid-ai to pick and run a model."));
  } finally {
    prompt.close();
  }
}

// ── Uninstall ───────────────────────────────────────────────────────────────

async function uninstallCommand(argv) {
  const { options } = parseOptions(argv);
  const force = options.force || options.f;

  if (!process.stdin.isTTY && !force) {
    throw new Error("Non-interactive uninstall requires --force to avoid accidental data loss.");
  }

  if (force) {
    await stopTrackedServers();
    await removeDataDir();
    await removeShellPath();
    await removeSelf();
    return;
  }

  startInteractive("offgrid-ai uninstall");
  const prompt = createPrompt();
  try {
    console.log(pc.bold("offgrid-ai uninstall\n"));

    // Stop any running servers first
    const running = await runningProfiles();
    if (running.length > 0) {
      console.log(pc.yellow(`${running.length} server(s) still running. Stopping...`));
      for (const { profile } of running) {
        await stopProfile(profile);
      }
      console.log(pc.green("All servers stopped."));
    }

    const dataDir = DATA_DIR;
    const mode = await prompt.choice("Choose uninstall type", [
      { value: "keep-data", label: "Uninstall app only", hint: `keep profiles and settings in ${dataDir}` },
      { value: "delete-data", label: "Full uninstall", hint: "delete profiles/settings, then uninstall app" },
      { value: "cancel", label: "Cancel" },
    ], "keep-data");

    if (mode === "cancel") {
      console.log(pc.dim("Cancelled."));
      return;
    }

    if (mode === "delete-data") await removeDataDir();
    else console.log(pc.dim(`Keeping ${dataDir} for when you reinstall.`));

    await removeShellPath();
    await removeSelf();
  } finally {
    prompt.close();
  }
}

async function stopTrackedServers() {
  const running = await runningProfiles();
  for (const { profile } of running) {
    const result = await stopProfile(profile);
    console.log(result.stopped ? pc.green(`✓ ${result.message}`) : pc.dim(result.message));
  }
}

async function removeDataDir() {
  const dataDir = DATA_DIR;
  if (existsSync(dataDir)) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      console.log(pc.green(`✓ Removed ${dataDir}`));
    } catch (err) {
      console.log(pc.red(`Failed to remove ${dataDir}: ${err.message}`));
      console.log(pc.dim(`Remove it manually: rm -rf ${dataDir}`));
    }
  } else {
    console.log(pc.dim(`${dataDir} doesn't exist — already clean.`));
  }
}

async function removeShellPath() {
  const cleaned = await removeInstallerPathEntries();
  if (cleaned.length === 0) {
    console.log(pc.dim("No offgrid-ai PATH entries found in shell configs."));
    return;
  }
  for (const rcFile of cleaned) {
    console.log(pc.green(`✓ Cleaned PATH from ${rcFile}`));
  }
}

async function removeSelf() {
  console.log(pc.cyan("\nUninstalling offgrid-ai..."));
  const { spawn: spawnUninstall } = await import("node:child_process");
  const verbose = process.argv.includes("--verbose");
  const runCmd = (cmd, args, label) => new Promise((resolve, reject) => {
    const stdio = verbose ? "inherit" : ["ignore", "pipe", "pipe"];
    const child = spawnUninstall(cmd, args, { stdio });
    if (!verbose) {
      let stderr = "";
      child.stderr?.on("data", (d) => { stderr += d; });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.split("\n").filter(l => l.trim()).slice(-3).join("\n") || `${label || cmd} exited with code ${code}`));
      });
    } else {
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${label || cmd} exited with code ${code}`)));
    }
    child.on("error", (err) => reject(err));
  });
  try {
    await runCmd("npm", ["uninstall", "-g", "offgrid-ai"], "npm uninstall");
    console.log(pc.green("\n✓ offgrid-ai has been uninstalled."));
    console.log(pc.dim("Reinstall anytime with: npm install -g offgrid-ai"));
  } catch {
    console.log(pc.red("\n✗ Could not auto-uninstall. Run this manually:"));
    console.log(pc.bold("  npm uninstall -g offgrid-ai"));
  }
}

// ── Backend install detection (for status display) ────────────────────────

async function hasOllamaInstalled() {
  try {
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    await promisify(execFile)("which", ["ollama"]);
    return true;
  } catch { return false; }
}

async function hasOmlxInstalled() {
  try {
    const { promisify } = await import("node:util");
    const { execFile } = await import("node:child_process");
    await promisify(execFile)("which", ["omlx"]);
    return true;
  } catch { return false; }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function scanManagedModels() {
  const results = [];
  for (const backendId of ["ollama", "omlx"]) {
    const be = BACKENDS[backendId];
    try {
      const models = await be.scanModels();
      results.push({ backendId, models });
    } catch { /* backend not running */ }
  }
  return results;
}

async function printVersion() {
  const version = currentPackageVersion();
  console.log(`offgrid-ai v${version}`);
  const invocation = detectInvocation();
  const update = await checkForUpdate({ force: invocation === "npx" });
  if (update) {
    const plan = updateCommand(invocation, ["version"]);
    console.log(pc.yellow(`Update available: v${update.latest}. Run: ${plan.display}`));
  }
}

function printHelp() {
  console.log(renderCard("offgrid-ai", renderRows([
    ["What it is", "A privacy-first local AI runner"],
    ["Start", pc.bold("offgrid-ai")],
    ["Status", "offgrid-ai status"],
    ["Stop", "offgrid-ai stop"],
    ["Uninstall", "offgrid-ai uninstall"],
    ["Version", "offgrid-ai version"],
  ]), { formatBorder: pc.cyan }));
  console.log("\n" + renderCard("How it works", "Run offgrid-ai, choose a local model, and start chatting in Pi.\n\nFirst run walks you through missing tools. After that, offgrid-ai remembers your model setup.", { formatBorder: pc.magenta }));
  console.log("\n" + pc.dim("Tip: use --verbose only when you want detailed install output."));
}