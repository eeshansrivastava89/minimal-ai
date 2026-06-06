import { ensureDirs, findLlamaServer, hasHomebrew } from "./config.mjs";
import { scanGgufModels } from "./scan.mjs";
import { detectCapabilities, computeFlags } from "./autodetect.mjs";
import { loadProfiles, readProfile, saveProfile, deleteProfile, profileExists, createProfileFromModel, normalizeProfile } from "./profiles.mjs";
import { backendFor, BACKENDS } from "./backends.mjs";
import { startServer, stopProfile, isProfileRunning, profileRuntimeStatus, waitForReady, serverReady } from "./process.mjs";
import { syncPiConfig, removeFromPiConfig, hasPiModel, launchPi, hasPi } from "./harness-pi.mjs";
import { tailFriendly } from "./logs.mjs";
import { estimateMemory } from "./estimate.mjs";
import { pc, printHelp, formatBytes, renderRows, renderSection, startInteractive, createPrompt, parseOptions } from "./ui.mjs";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Command router ─────────────────────────────────────────────────────────

export async function run(argv) {
  const [command = "help", ...args] = argv;

  if (["help", "--help", "-h"].includes(command)) return printHelp();
  if (command === "models") return modelsCommand(args);
  if (command === "run") return runCommand(args);
  if (command === "stop") return stopCommand(args);
  if (command === "benchmark") return benchmarkCommand(args);
  if (command === "onboard") return onboardCommand();

  throw new Error(`Unknown command: ${command}. Run offgrid-ai help`);
}

// ── Onboarding ──────────────────────────────────────────────────────────────

async function onboardCommand() {
  if (!process.stdin.isTTY) throw new Error("Onboarding requires an interactive terminal.");
  startInteractive("offgrid-ai setup");
  const prompt = createPrompt();
  try {
    // 1. Homebrew
    const hasBrew = await hasHomebrew();
    if (!hasBrew) {
      const install = await prompt.yesNo("Homebrew is required. Install it?", true);
      if (!install) { console.log(pc.red("offgrid-ai cannot continue without Homebrew.")); return; }
      console.log(pc.dim("Install Homebrew from https://brew.sh and rerun offgrid-ai."));
      return;
    }

    // 2. llama-server
    let llamaBinary = await findLlamaServer();
    if (!llamaBinary) {
      const install = await prompt.yesNo("llama-server is required. Install via Homebrew?", true);
      if (!install) { console.log(pc.red("offgrid-ai cannot start models without llama-server.")); return; }
      console.log(pc.cyan("Running: brew install llama.cpp"));
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      try {
        await promisify(execFile)("brew", ["install", "llama.cpp"]);
        llamaBinary = await findLlamaServer();
      } catch (err) {
        console.log(pc.red(`Failed to install llama.cpp: ${err.message}`));
        return;
      }
    }
    console.log(pc.green(`llama-server: ${llamaBinary}`));

    // 3. Model backend — check what's available
    console.log(pc.dim("Checking for model backends..."));
    const availableBackends = [];
    const lmstudioDir = join(homedir(), ".lmstudio", "models");
    if (existsSync(lmstudioDir)) {
      availableBackends.push({ value: "llama-cpp", label: "LM Studio", hint: "Models found in ~/.lmstudio/models" });
    }
    // Check if Ollama is running
    try {
      const resp = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
      if (resp.ok) availableBackends.push({ value: "ollama", label: "Ollama", hint: "Ollama is running" });
    } catch { /* not running */ }
    // Check if oMLX is running
    try {
      const resp = await fetch("http://127.0.0.1:8000/v1/models", { signal: AbortSignal.timeout(2000) });
      if (resp.ok) availableBackends.push({ value: "omlx", label: "oMLX", hint: "oMLX is running" });
    } catch { /* not running */ }

    if (availableBackends.length > 0) {
      console.log(pc.green("Model backends detected:"));
      for (const b of availableBackends) console.log(pc.dim(`  - ${b.label}`));
    } else {
      console.log(pc.yellow("No model backends detected. Install LM Studio to download models."));
      console.log(pc.dim("  https://lmstudio.ai"));
      return;
    }

    // 4. Check for models
    const ggufModels = await scanGgufModels();
    if (ggufModels.length === 0) {
      console.log(pc.yellow("No models found. Download a model in LM Studio, then run offgrid-ai again."));
      return;
    }

    console.log(pc.green(`\nFound ${ggufModels.length} model(s). Setup complete!`));
    console.log(pc.dim("Run offgrid-ai to pick and run a model."));
  } finally {
    prompt.close();
  }
}

// ── Models ─────────────────────────────────────────────────────────────────

async function modelsCommand(argv) {
  await ensureDirs();

  if (!process.stdin.isTTY) {
    // Non-interactive: just list
    console.log(pc.bold("Saved profiles"));
    const profiles = await loadProfiles();
    for (const p of profiles) {
      console.log(`  ${pc.cyan(p.id)} · ${p.label} · ${p.baseUrl}`);
    }
    return;
  }

  startInteractive("offgrid-ai models");
  const prompt = createPrompt();
  try {
    const profiles = await loadProfiles();
    const ggufModels = await scanGgufModels();
    const profiledPaths = new Set(profiles.map((p) => p.modelPath).filter(Boolean));
    const unprofiledGguf = ggufModels.filter((m) => !profiledPaths.has(m.path));

    // Build items list for selection
    const items = [];

    // 1. Existing profiles
    if (profiles.length > 0) {
      console.log(pc.bold("Saved profiles"));
      const backendColors = { "llama-cpp": pc.yellow, "llama-cpp-mtp": pc.blue, "ollama": pc.magenta, "omlx": pc.cyan };
      for (const profile of profiles) {
        const backend = backendFor(profile.backend);
        const colorFn = backendColors[profile.backend] ?? pc.magenta;
        const running = await isProfileRunning(profile);
        const index = items.push({ type: "profile", profile }) - 1;
        console.log(`${String(index + 1).padStart(2)} ${running ? pc.green("●") : pc.dim("○")} ${pc.bold(profile.label)} ${colorFn(`[${backend.label}]`)} · ${pc.cyan(profile.modelAlias)}`);
      }
      console.log("");
    }

    // 2. Unprofiled GGUF models (auto-detect candidates)
    if (unprofiledGguf.length > 0) {
      console.log(pc.bold("New models (auto-setup)"));
      for (const model of unprofiledGguf) {
        const index = items.push({ type: "model", model }) - 1;
        console.log(`${String(index + 1).padStart(2)} ${pc.cyan(model.label)} ${pc.dim(model.quant ?? "")} · ${pc.dim(formatBytes(model.sizeBytes))}`);
      }
      console.log("");
    }

    // 3. Managed backend models
    for (const beId of ["ollama", "omlx"]) {
      const be = BACKENDS[beId];
      const models = await be.scanModels();
      if (models.length === 0) continue;
      const badgeColor = { ollama: pc.magenta, omlx: pc.cyan }[beId] ?? pc.magenta;
      console.log(pc.bold(`${be.label} models`));
      for (const model of models) {
        const index = items.push({ type: "managed", model, backendId: beId }) - 1;
        console.log(`${String(index + 1).padStart(2)} ${pc.cyan(model.label)} ${badgeColor(`[${be.label}]`)}`);
      }
      console.log("");
    }

    if (items.length === 0) {
      console.log(pc.yellow("No models found. Run `offgrid-ai onboard` to set up."));
      return;
    }

    const action = await prompt.choice("Action", [
      { value: "run", label: "Run", hint: "Start server + launch Pi" },
      { value: "setup", label: "Set up", hint: "Create or re-sync a profile" },
      { value: "remove", label: "Remove", hint: "Delete a profile" },
    ], "run");
    const input = await prompt.text("Select a number", "");
    const index = Number(input) - 1;
    if (Number.isNaN(index) || index < 0 || index >= items.length) {
      console.log(pc.yellow(`No item ${input}.`));
      return;
    }
    const item = items[index];

    if (action === "run") {
      if (item.type === "profile") return await runFromProfile(item.profile);
      if (item.type === "model") return await runFromNewModel(item.model);
      if (item.type === "managed") return await runFromManagedModel(item.model, item.backendId);
    } else if (action === "setup") {
      if (item.type === "profile") await syncProfile(item.profile);
      else if (item.type === "model") await setupNewModel(item.model);
      else if (item.type === "managed") await setupManagedModel(item.model, item.backendId);
    } else if (action === "remove") {
      if (item.type === "profile") await removeProfileInteractive(item.profile.id);
      else console.log(pc.yellow("Only saved profiles can be removed."));
    }
  } finally {
    prompt.close();
  }
}

// ── Auto-setup and run ──────────────────────────────────────────────────────

async function runFromNewModel(model) {
  const profile = await createProfileFromModel(model);
  const saved = await saveProfile(profile);
  console.log(pc.green(`Auto-created profile: ${saved.id}`));
  return await runFromProfile(saved);
}

async function runFromManagedModel(model, backendId) {
  const profile = normalizeProfile({
    id: model.id.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase(),
    label: model.label,
    backend: backendId,
    modelAlias: model.aliasSuggestion,
    ...(backendId === "ollama" ? { ollamaModel: model.id } : {}),
    ...(backendId === "omlx" ? { omlxModel: model.id } : {}),
  });
  await saveProfile(profile);
  return await runFromProfile(profile);
}

async function setupNewModel(model) {
  const profile = await createProfileFromModel(model);
  const saved = await saveProfile(profile);
  await syncProfile(saved);
}

async function setupManagedModel(model, backendId) {
  const profile = normalizeProfile({
    id: model.id.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase(),
    label: model.label,
    backend: backendId,
    modelAlias: model.aliasSuggestion,
    ...(backendId === "ollama" ? { ollamaModel: model.id } : {}),
    ...(backendId === "omlx" ? { omlxModel: model.id } : {}),
  });
  await saveProfile(profile);
  await syncProfile(profile);
}

async function syncProfile(profile) {
  await syncPiConfig(profile);
}

// ── Run command ─────────────────────────────────────────────────────────────

async function runCommand(argv) {
  await ensureDirs();
  const { positional, options } = parseOptions(argv);

  let profile;
  if (positional.length > 0) {
    profile = await readProfile(positional[0]);
  } else {
    // Interactive selection
    if (!process.stdin.isTTY) throw new Error("Profile id is required when not running interactively.");
    const profiles = await loadProfiles();
    if (profiles.length === 0) throw new Error("No profiles yet. Run: offgrid-ai models");
    startInteractive("offgrid-ai run");
    const prompt = createPrompt();
    try {
      const profileId = await prompt.choice("Profile", profiles.map((p) => ({
        value: p.id, label: p.label, hint: `${p.modelAlias} · ${p.baseUrl}`,
      })), profiles[0].id);
      profile = profiles.find((p) => p.id === profileId);
      if (!profile) throw new Error(`Profile "${profileId}" not found.`);
      const withHarness = options.with ?? await prompt.choice("Harness", [
        { value: "pi", label: "Pi" },
        { value: "server", label: "Server only" },
      ], "pi");
      options.with = withHarness;
    } finally {
      prompt.close();
    }
  }

  return await runFromProfile(profile, options);
}

async function runFromProfile(profile, options = {}) {
  const withHarness = options.with ?? "pi";
  const backend = backendFor(profile.backend);

  // Check harness availability
  if (withHarness === "pi") {
    const piInstalled = await hasPi();
    if (!piInstalled) {
      console.log(pc.yellow("Pi is not installed. Install it from https://pi.app or run with --with server."));
      return;
    }
  }

  // Start or verify server
  const isManaged = backend.type === "managed-server";
  let state;

  if (isManaged) {
    if (!(await serverReady(profile.baseUrl))) {
      throw new Error(`${backend.label} is not running at ${profile.baseUrl}. Start it and try again.`);
    }
    console.log(pc.green(`[ready] ${backend.label} responding at ${profile.baseUrl}`));
    if (withHarness !== "pi") {
      console.log(pc.dim(`${backend.label} is a managed service — offgrid-ai does not stop it.`));
      return;
    }
  } else {
    const ready = await serverReady(profile.baseUrl);
    if (ready && !options["reuse-existing"]) {
      throw new Error(`${profile.baseUrl}/models already responds. Rerun with --reuse-existing.`);
    }
    state = await startServer(profile);
  }

  // Wait for readiness
  if (!isManaged) {
    const tail = state?.rawLogPath ? tailFriendly(state.rawLogPath, state.friendlyLogPath) : { stop() {} };
    try {
      await waitForReady(profile, state?.pid, state?.rawLogPath);
      console.log(pc.green(`[ready] ${profile.baseUrl}/models responded`));
    } finally {
      tail.stop();
    }
  }

  // Launch harness
  if (withHarness === "pi") {
    if (!(await hasPiModel(profile))) await syncPiConfig(profile);
    try {
      await launchPi(profile);
    } finally {
      if (!isManaged && !options["keep-server"]) {
        const result = await stopProfile(profile);
        console.log(result.stopped ? pc.green(`[stop] ${result.message}`) : pc.yellow(`[stop] ${result.message}`));
      }
    }
  } else {
    if (!isManaged) {
      console.log(pc.dim(`Server running at ${profile.baseUrl}`));
      console.log(pc.dim(`Stop with: offgrid-ai stop ${profile.id}`));
    }
  }
}

// ── Stop command ─────────────────────────────────────────────────────────────

async function stopCommand(argv) {
  await ensureDirs();
  const { positional, options } = parseOptions(argv);
  if (options.all) return stopAllRunningProfiles();
  if (positional[0]) return stopOneProfile(positional[0]);
  return stopInteractive();
}

async function stopOneProfile(id) {
  const profile = await readProfile(id);
  const result = await stopProfile(profile);
  console.log(result.stopped ? pc.green(result.message) : pc.yellow(result.message));
}

async function stopAllRunningProfiles() {
  const running = await runningProfileStatuses();
  if (running.length === 0) {
    console.log(pc.dim("No tracked offgrid-ai servers are running."));
    return;
  }
  for (const { profile, status } of running) {
    const result = await stopProfile(profile);
    console.log(result.stopped ? pc.green(result.message) : pc.yellow(result.message));
  }
}

async function stopInteractive() {
  const statuses = await allProfileStatuses();
  const running = statuses.filter((s) => s.status.running);
  if (running.length === 0) {
    console.log(pc.dim("No tracked offgrid-ai servers are running."));
    return;
  }

  if (!process.stdin.isTTY) {
    for (const { profile, status } of running) {
      console.log(`  ${pc.green("●")} ${pc.bold(profile.label)} · pid ${status.pid} · ${profile.baseUrl}`);
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

async function allProfileStatuses() {
  const profiles = await loadProfiles();
  return Promise.all(profiles.map(async (profile) => ({ profile, status: await profileRuntimeStatus(profile) })));
}

async function runningProfileStatuses() {
  return (await allProfileStatuses()).filter((i) => i.status.running);
}

// ── Remove command ──────────────────────────────────────────────────────────

async function removeProfileInteractive(id) {
  const profile = await readProfile(id);
  const prompt = createPrompt();
  try {
    const confirmed = await prompt.yesNo(`Remove ${profile.label} (${profile.id}) and its Pi config?`, false);
    if (!confirmed) { console.log(pc.dim("Cancelled.")); return; }
  } finally {
    prompt.close();
  }
  if (await isProfileRunning(profile)) {
    console.log(pc.yellow(`Stopping running server for ${profile.label}...`));
    await stopProfile(profile);
  }
  await removeFromPiConfig(profile);
  const deleted = await deleteProfile(id);
  console.log(pc.green(`Removed ${profile.label} (${profile.id})`));
}

// ── Benchmark (stub for milestone 1) ────────────────────────────────────────

async function benchmarkCommand(argv) {
  console.log(pc.yellow("Benchmark support coming soon. This requires the local-llm-visual-benchmark repo."));
  console.log(pc.dim("For now, use offgrid-ai run to start a model, then run benchmarks manually."));
}