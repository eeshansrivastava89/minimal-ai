import { existsSync } from "node:fs";
import { ensureDirs } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { normalizeProfile, readProfile, saveProfile } from "../profiles.mjs";
import { startServer, stopProfile, waitForReady, serverReady, serverMatchesProfile, modelAvailableOnServer, unloadModelFromServer } from "../process.mjs";
import { syncPiConfig, hasPiModel, launchPi, hasPi } from "../harness-pi.mjs";
import { tailFriendly } from "../logs.mjs";
import { estimateMemory } from "../estimate.mjs";
import { pc, formatBytes, renderRows, renderSection, parseOptions } from "../ui.mjs";

export async function runCommand(argv) {
  await ensureDirs();
  const { positional, options } = parseOptions(argv);
  if (!positional[0]) {
    const { mainFlow } = await import("./main.mjs");
    return await mainFlow();
  }
  return await runProfile(await readProfile(positional[0]), options);
}

export async function runProfile(profile, options = {}) {
  const backend = backendFor(profile.backend);
  const withHarness = options.with ?? "pi";

  if (withHarness === "pi" && !(await hasPi())) {
    console.log(pc.yellow("Pi is not installed. Run with --with server, or install Pi from https://pi.app"));
    console.log(pc.dim("Starting server only..."));
    return await runProfile(profile, { ...options, with: "server" });
  }

  const isManaged = backend.type === "managed-server";
  if (isManaged) {
    if (!(await serverReady(profile.baseUrl))) {
      throw new Error(`${backend.label} is not running at ${profile.baseUrl}. Start it and try again.`);
    }
    const available = await modelAvailableOnServer(profile);
    if (!available) {
      const modelId = profile.omlxModel ?? profile.ollamaModel ?? profile.modelAlias ?? profile.label;
      throw new Error(`${modelId} is not available on ${backend.label} at ${profile.baseUrl}.`);
    }
    console.log(pc.green(`[ready] ${backend.label} at ${profile.baseUrl}`));
  } else {
    const startup = await ensureLocalServer(profile, backend, options);
    if (startup?.handled) return startup.result;
  }

  printMemoryEstimate(profile, isManaged);
  await launchHarness(profile, options, isManaged, withHarness, backend);
}

async function ensureLocalServer(profile, backend, options) {
  if (await serverReady(profile.baseUrl)) {
    const match = await serverMatchesProfile(profile);
    if (!match.matches) {
      throw new Error(`A different server is already responding at ${profile.baseUrl}. ${match.reason}. Stop it with offgrid-ai stop --all, or choose a different port.`);
    }
    console.log(pc.green(`[ready] Reusing server at ${profile.baseUrl}`));
    return;
  }

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
    if (state?.pid) {
      try { await stopProfile(profile); } catch { /* best effort */ }
    }
    if (!options.textOnlyRetry && isUnsupportedMmprojError(err, profile)) {
      console.log(pc.yellow("Vision projector is not supported by this llama.cpp build. Retrying text-only."));
      console.log(pc.dim("Update llama.cpp later to re-enable vision for this model."));
      const textOnly = textOnlyProfile(profile);
      await saveProfile(textOnly, { writeCommand: true });
      return { handled: true, result: await runProfile(textOnly, { ...options, textOnlyRetry: true }) };
    }
    throw err;
  }
}

function printMemoryEstimate(profile, isManaged) {
  if (isManaged || !profile.modelPath || !existsSync(profile.modelPath)) return;
  try {
    const est = estimateMemory(profile.modelPath, profile.mmprojPath, profile.drafterPath, profile.flags);
    const rows = [
      ["Estimated total", pc.bold(`~${formatBytes(est.totalBytes)}`)],
      ["Model file", formatBytes(est.modelBytes)],
    ];
    if (est.draftBytes) rows.push(["Drafter", formatBytes(est.draftBytes)]);
    if (est.mmprojBytes) rows.push(["Vision projector", formatBytes(est.mmprojBytes)]);
    rows.push(["Conversation memory", est.kvBytes ? `~${formatBytes(est.kvBytes)}` : "unknown"]);
    console.log(renderSection("Memory estimate", renderRows(rows)));
  } catch {
    // Memory estimates are informational only.
  }
}

async function launchHarness(profile, options, isManaged, withHarness, backend) {
  if (withHarness !== "pi") {
    if (!isManaged) {
      console.log(pc.dim(`Server running at ${profile.baseUrl}`));
      console.log(pc.dim(`Stop with: offgrid-ai stop ${profile.id}`));
    } else {
      console.log(pc.dim(`${backend.label} is a managed service — offgrid-ai does not stop it.`));
    }
    return;
  }

  if (!(await hasPiModel(profile))) await syncPiConfig(profile);
  try {
    await launchPi(profile);
  } finally {
    if (!options["keep-server"]) {
      if (!isManaged) {
        const result = await stopProfile(profile);
        console.log(result.stopped ? pc.green(`[stop] ${result.message}`) : pc.dim(`[stop] ${result.message}`));
      } else {
        // Managed-server backends (oMLX, Ollama): unload the model from the
        // server's memory via its HTTP API. The server itself stays running
        // (offgrid-ai doesn't manage it), but the model is released — same UX
        // as local-server backends where stopProfile kills the process.
        const result = await unloadModelFromServer(profile);
        if (result.unloaded) {
          console.log(pc.green(`[unload] ${backend.label}: model unloaded`));
        } else if (result.reason) {
          console.log(pc.dim(`[unload] ${backend.label}: ${result.reason}`));
        } else if (result.error) {
          console.log(pc.yellow(`[unload] ${backend.label}: ${result.error}`));
        }
      }
    }
  }
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
