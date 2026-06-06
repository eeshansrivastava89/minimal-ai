import { homedir } from "node:os";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDirs, findLlamaServer, hasHomebrew } from "./config.mjs";
import { scanGgufModels } from "./scan.mjs";
import { createProfileFromModel, normalizeProfile } from "./profiles.mjs";
import { readProfile, saveProfile, deleteProfile, loadProfiles } from "./profiles.mjs";
import { backendFor, BACKENDS } from "./backends.mjs";
import { startServer, stopProfile, waitForReady, serverReady, isProfileRunning, profileRuntimeStatus } from "./process.mjs";
import { syncPiConfig, removeFromPiConfig, hasPiModel, launchPi, hasPi } from "./harness-pi.mjs";
import { tailFriendly } from "./logs.mjs";
import { estimateMemory } from "./estimate.mjs";
import { pc, formatBytes, renderRows, renderSection, startInteractive, createPrompt, parseOptions } from "./ui.mjs";

// ── Entry point ────────────────────────────────────────────────────────────

export async function run(argv) {
  if (argv.length === 0) return mainFlow();
  const [command] = argv;

  if (command === "help" || command === "--help" || command === "-h") return printHelp();
  if (command === "status") return statusCommand();
  if (command === "stop") return stopCommand(argv.slice(1));

  throw new Error(`Unknown command: ${command}. Run offgrid-ai help`);
}

export async function mainFlow() {
  await ensureDirs();

  // 1. Check onboarding — is llama-server available?
  const llamaBinary = await findLlamaServer();
  if (!llamaBinary) {
    if (!process.stdin.isTTY) throw new Error("llama-server not found. Run offgrid-ai interactively to set up.");
    return await onboardFlow();
  }

  // 2. Check for any models at all
  const ggufModels = await scanGgufModels();
  const managedModels = await scanManagedModels();
  const profiles = await loadProfiles();

  if (ggufModels.length === 0 && managedModels.length === 0 && profiles.length === 0) {
    if (!process.stdin.isTTY) throw new Error("No models found. Download one in LM Studio or start Ollama, then run offgrid-ai.");
    console.log(pc.yellow("No models found."));
    console.log(pc.dim("Download a model in LM Studio (https://lmstudio.ai), start Ollama, or install oMLX."));
    console.log(pc.dim("Then run offgrid-ai again."));
    return;
  }

  // 3. If not interactive, just show status
  if (!process.stdin.isTTY) {
    await statusCommand();
    return;
  }

  // 4. Interactive: pick an action
  startInteractive("offgrid-ai");
  const prompt = createPrompt();
  try {
    // Build items list
    const items = [];

    // Existing profiles (quick run)
    if (profiles.length > 0) {
      for (const profile of profiles) {
        const running = await isProfileRunning(profile);
        const backend = backendFor(profile.backend);
        items.push({ type: "profile", profile, running });
      }
    }

    // New GGUF models (auto-setup)
    const profiledPaths = new Set(profiles.map((p) => p.modelPath).filter(Boolean));
    const newModels = ggufModels.filter((m) => !profiledPaths.has(m.path));

    // Managed backend models
    const managedItems = [];
    for (const { backendId, models } of managedModels) {
      const profiledAliases = new Set(
        profiles.filter((p) => p.backend === backendId).map((p) => backendId === "ollama" ? `ollama:${p.ollamaModel ?? p.modelAlias}` : `omlx:${p.omlxModel ?? p.modelAlias}`)
      );
      for (const model of models) {
        if (!profiledAliases.has(`${backendId}:${model.id}`)) {
          managedItems.push({ model, backendId });
        }
      }
    }

    // Show what we found
    if (profiles.length > 0) {
      console.log(pc.bold("\nSaved profiles"));
      for (const profile of profiles) {
        const backend = backendFor(profile.backend);
        const running = await isProfileRunning(profile);
        const idx = items.length;
        const colorMap = { "llama-cpp": pc.yellow, "llama-cpp-mtp": pc.blue, "ollama": pc.magenta, "omlx": pc.cyan };
        const c = colorMap[profile.backend] ?? pc.magenta;
        console.log(`  ${running ? pc.green("●") : pc.dim("○")} ${pc.bold(profile.label)} ${c(`[${backend.label}]`)} · ${pc.cyan(profile.modelAlias)}`);
      }
    }
    if (newModels.length > 0) {
      console.log(pc.bold("\nNew models"));
      for (const model of newModels.slice(0, 10)) {
        console.log(`  ${pc.cyan(model.label)} ${pc.dim(model.quant ?? "")} · ${pc.dim(formatBytes(model.sizeBytes))}`);
      }
      if (newModels.length > 10) console.log(pc.dim(`  ... and ${newModels.length - 10} more`));
    }
    for (const { backendId, models } of managedModels) {
      if (models.length > 0) {
        const be = BACKENDS[backendId];
        console.log(pc.bold(`\n${be.label} models`));
        for (const model of models.slice(0, 5)) {
          console.log(`  ${pc.cyan(model.label)}`);
        }
        if (models.length > 5) console.log(pc.dim(`  ... and ${models.length - 5} more`));
      }
    }

    // Pick what to do
    const action = await prompt.choice("What next?", [
      { value: "run", label: "Run a model", hint: "Start server and launch Pi" },
      ...(profiles.length > 0 ? [{ value: "manage", label: "Manage profiles", hint: "Sync, remove, or inspect" }] : []),
      { value: "benchmark", label: "Benchmark", hint: "Run a benchmark prompt" },
    ], "run");

    if (action === "run") return await pickAndRun(prompt, profiles, newModels, managedItems);
    if (action === "manage") return await manageProfiles(prompt, profiles);
    if (action === "benchmark") return await benchmarkFlow(prompt, profiles);
  } finally {
    prompt.close();
  }
}

// ── Pick and run ────────────────────────────────────────────────────────────

async function pickAndRun(prompt, profiles, newModels, managedItems) {
  // If there's exactly one profile and it's already running, offer to connect or start fresh
  const choices = [];

  // Existing profiles
  for (const profile of profiles) {
    const running = await isProfileRunning(profile);
    const backend = backendFor(profile.backend);
    const colorMap = { "llama-cpp": pc.yellow, "llama-cpp-mtp": pc.blue, "ollama": pc.magenta, "omlx": pc.cyan };
    const c = colorMap[profile.backend] ?? pc.magenta;
    choices.push({
      value: `profile:${profile.id}`,
      label: `${running ? pc.green("● ") : ""}${profile.label}`,
      hint: `${c(backend.label)} · ${profile.modelAlias} · ${profile.baseUrl}`,
    });
  }

  // New GGUF models
  for (const model of newModels.slice(0, 20)) {
    choices.push({
      value: `new:${model.path}`,
      label: model.label,
      hint: `${model.quant ?? "GGUF"} · ${formatBytes(model.sizeBytes)}`,
    });
  }

  // Managed models
  for (const { model, backendId } of managedItems) {
    const be = BACKENDS[backendId];
    choices.push({
      value: `managed:${backendId}:${model.id}`,
      label: model.label,
      hint: `${be.label}`,
    });
  }

  if (choices.length === 0) {
    console.log(pc.yellow("No models available."));
    return;
  }

  const selected = await prompt.choice("Pick a model", choices, choices[0].value);

  if (selected.startsWith("profile:")) {
    const id = selected.slice("profile:".length);
    const profile = await readProfile(id);
    return await runProfile(profile);
  }

  if (selected.startsWith("new:")) {
    const modelPath = selected.slice("new:".length);
    const model = newModels.find((m) => m.path === modelPath);
    if (!model) throw new Error("Model not found.");
    const profile = await createProfileFromModel(model);
    await saveProfile(profile);
    console.log(pc.green(`Auto-configured: ${profile.label}`));
    await syncPiConfig(profile);
    return await runProfile(profile);
  }

  if (selected.startsWith("managed:")) {
    const [, backendId, modelId] = selected.split(":");
    const model = managedItems.find((m) => m.model.id === modelId && m.backendId === backendId)?.model;
    if (!model) throw new Error("Model not found.");
    const profile = normalizeProfile({
      id: model.id.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase(),
      label: model.label,
      backend: backendId,
      modelAlias: model.aliasSuggestion,
      ...(backendId === "ollama" ? { ollamaModel: model.id } : {}),
      ...(backendId === "omlx" ? { omlxModel: model.id } : {}),
    });
    await saveProfile(profile);
    await syncPiConfig(profile);
    return await runProfile(profile);
  }
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
    if (ready && !options["reuse-existing"]) {
      console.log(pc.green(`[ready] Server already running at ${profile.baseUrl}`));
      console.log(pc.dim("Use --reuse-existing to reuse this server."));
    } else if (!ready) {
      console.log(pc.dim(`Starting ${backend.label} for ${profile.label}...`));
      const state = await startServer(profile);
      const tail = state?.rawLogPath ? tailFriendly(state.rawLogPath, state.friendlyLogPath) : { stop() {} };
      try {
        await waitForReady(profile, state?.pid, state?.rawLogPath);
        console.log(pc.green(`[ready] ${profile.baseUrl}/models`));
      } finally {
        tail.stop();
      }
    }
  }

  // Show memory estimate for local models
  if (!isManaged && profile.modelPath && existsSync(profile.modelPath)) {
    try {
      const est = estimateMemory(profile.modelPath, profile.mmprojPath, null, profile.flags);
      console.log(renderSection("Memory", renderRows([
        ["Estimated total", pc.bold(`~${formatBytes(est.totalBytes)}`)],
        ["Model", formatBytes(est.modelBytes)],
        ["KV cache", est.kvBytes ? `~${formatBytes(est.kvBytes)}` : "unknown"],
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

// ── Manage profiles ─────────────────────────────────────────────────────────

async function manageProfiles(prompt, profiles) {
  const choices = profiles.map((p) => ({
    value: p.id,
    label: p.label,
    hint: `${p.modelAlias} · ${p.baseUrl}`,
  }));
  choices.push({ value: "__back", label: "← Back" });

  const selected = await prompt.choice("Which profile?", choices, choices[0].value);
  if (selected === "__back") return;

  const profile = await readProfile(selected);
  const backend = backendFor(profile.backend);
  const isManaged = backend.type === "managed-server";

  // Show profile details
  console.log("");
  console.log(renderSection("Profile", renderRows([
    ["ID", pc.cyan(profile.id)],
    ["Label", pc.bold(profile.label)],
    ["Backend", backend.label],
    ["Endpoint", pc.green(profile.baseUrl)],
    ...(!isManaged ? [
      ["Model", profile.modelPath ?? "unknown"],
      ["MMProj", profile.mmprojPath ?? "none"],
      ["Memory", existsSync(profile.modelPath) ? formatBytes(statSync(profile.modelPath).size) : "unknown"],
    ] : []),
    ["Alias", pc.cyan(profile.modelAlias)],
    ["Pi", (await hasPiModel(profile)) ? pc.green("configured") : pc.yellow("not synced")],
  ])));

  if (!isManaged && profile.commandArgv) {
    console.log("");
    console.log(pc.bold("Auto-detected flags"));
    console.log(pc.dim(profile.commandArgv.join(" ")));
  }

  const action = await prompt.choice("Action", [
    { value: "sync", label: "Sync Pi config", hint: "Update ~/.pi/agent/models.json" },
    { value: "run", label: "Run", hint: "Start server + Pi" },
    ...(isManaged ? [] : [{ value: "server", label: "Server only", hint: "Start server, no harness" }]),
    { value: "remove", label: "Remove", hint: "Delete profile + Pi config" },
    { value: "__back", label: "← Back" },
  ], "sync");

  if (action === "sync") {
    await syncPiConfig(profile);
  } else if (action === "run") {
    return await runProfile(profile);
  } else if (action === "server") {
    return await runProfile(profile, { with: "server" });
  } else if (action === "remove") {
    await removeProfileInteractive(profile.id);
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

async function benchmarkFlow(prompt, profiles) {
  console.log(pc.yellow("Benchmark support coming soon."));
  console.log(pc.dim("This will require the local-llm-visual-benchmark repo."));
  console.log(pc.dim("For now, start a model with offgrid-ai and run benchmarks manually."));
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
    console.log(pc.dim("No offgrid-ai servers are running."));
    if (profiles.length > 0) {
      console.log(pc.dim(`\n${profiles.length} profile(s) available. Run offgrid-ai to start one.`));
    }
    return;
  }

  console.log(pc.bold(`${running.length} server${running.length === 1 ? "" : "s"} running`));
  for (const { profile, status } of running) {
    const backend = backendFor(profile.backend);
    console.log(`  ${pc.green("●")} ${pc.bold(profile.label)} ${pc.dim(`[${backend.label}]`)}`);
    console.log(`    id: ${pc.cyan(profile.id)} · pid: ${status.pid} · ${status.ready ? pc.green("ready") : pc.yellow("loading")}`);
    console.log(`    ${profile.baseUrl}`);
  }
  console.log(pc.dim("\nStop with: offgrid-ai stop"));
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

async function onboardFlow() {
  startInteractive("offgrid-ai setup");
  const prompt = createPrompt();
  try {
    console.log(pc.bold("Welcome to offgrid-ai!"));
    console.log(pc.dim("Let's make sure you have everything you need to run local models.\n"));

    // 1. Homebrew
    const hasBrew = await hasHomebrew();
    if (!hasBrew) {
      const install = await prompt.yesNo("Homebrew is required. Install it?", true);
      if (!install) { console.log(pc.red("offgrid-ai needs Homebrew. Install it from https://brew.sh")); return; }
      console.log(pc.dim("Install Homebrew from https://brew.sh, then run offgrid-ai again."));
      return;
    }
    console.log(pc.green("✓ Homebrew found"));

    // 2. llama-server
    let llamaBinary = await findLlamaServer();
    if (!llamaBinary) {
      const install = await prompt.yesNo("llama-server is required. Install via Homebrew?", true);
      if (!install) { console.log(pc.red("offgrid-ai needs llama-server to run local models.")); return; }
      console.log(pc.cyan("Installing llama.cpp..."));
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      try {
        await promisify(execFile)("brew", ["install", "llama.cpp"], { stdio: "inherit" });
        llamaBinary = await findLlamaServer();
      } catch (err) {
        console.log(pc.red(`Failed: ${err.message}`));
        return;
      }
    }
    console.log(pc.green(`✓ llama-server: ${llamaBinary}`));

    // 3. Check for models
    const ggufModels = await scanGgufModels();
    const managedModels = await scanManagedModels();
    const totalManaged = managedModels.reduce((sum, m) => sum + m.models.length, 0);

    if (ggufModels.length > 0) {
      console.log(pc.green(`✓ Found ${ggufModels.length} GGUF model${ggufModels.length === 1 ? "" : "s"} in LM Studio`));
    }
    for (const { backendId, models } of managedModels) {
      if (models.length > 0) {
        console.log(pc.green(`✓ ${BACKENDS[backendId].label}: ${models.length} model${models.length === 1 ? "" : "s"}`));
      }
    }

    if (ggufModels.length === 0 && totalManaged === 0) {
      console.log(pc.yellow("\nNo models found. Download one in LM Studio, start Ollama, or install oMLX."));
      console.log(pc.dim("  LM Studio: https://lmstudio.ai"));
      console.log(pc.dim("  Then run offgrid-ai again."));
      return;
    }

    console.log(pc.green("\nSetup complete! Run offgrid-ai to pick and run a model."));
  } finally {
    prompt.close();
  }
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

function printHelp() {
  console.log(`${pc.bold("offgrid-ai")} — privacy-first local LLM runner

Usage:
  offgrid-ai          Pick a model and run it
  offgrid-ai status   Show running local models
  offgrid-ai stop     Stop a running server (or: offgrid-ai stop <id>)
  offgrid-ai help     Show this help

First run? offgrid-ai walks you through installing everything you need.
After that, just run it — it finds your models, auto-configures, and launches Pi.`);
}
