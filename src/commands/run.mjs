import { existsSync } from "node:fs";
import { ensureDirs } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { normalizeProfile, readProfile, saveProfile, effectiveModelId } from "../profiles.mjs";
import { startServer, stopProfile, waitForReady, serverMatchesProfile, modelAvailableOnServer, unloadModelFromServer, preflightInference } from "../process.mjs";
import { serverReady } from "../server-check.mjs";
import { syncPiConfig, hasPiModel, launchPi, hasPi } from "../harness-pi.mjs";
import { tailFriendly } from "../logs.mjs";
import { estimateMemory } from "../estimate.mjs";
import { renderMemoryEstimate, parseOptions, status, theme } from "../ui.mjs";

export async function runCommand(argv) {
  await ensureDirs();
  const { positional, options } = parseOptions(argv);
  if (!positional[0]) throw new Error("Specify a model name: offgrid-ai run <model>");
  return await runProfile(await readProfile(positional[0]), options);
}

export async function runProfile(profile, options = {}) {
  const backend = backendFor(profile.backend);
  const withHarness = options.with ?? "pi";
  const validHarnesses = ["pi", "server"];
  if (!validHarnesses.includes(withHarness)) {
    throw new Error(`Invalid --with value: "${withHarness}". Supported: ${validHarnesses.join(", ")}`);
  }
  if (withHarness === "pi" && !(await hasPi())) {
    console.log(status({ kind: "warning", message: "Pi is not installed. Run with --with server, or install Pi from https://pi.app" }));
    console.log(theme.subtle("Starting server only..."));
    return await runProfile(profile, { ...options, with: "server" });
  }

  const isManaged = backend.type === "managed-server";
  if (isManaged) {
    if (!(await serverReady(profile.baseUrl))) {
      console.log(theme.subtle(`Starting ${backend.label}...`));
      try {
        await startServer(profile);
      } catch (err) {
        throw new Error(`${backend.label} could not be started: ${err.message}`, { cause: err });
      }
    }
    const available = await modelAvailableOnServer(profile);
    if (!available) {
      const modelId = effectiveModelId(profile);
      throw new Error(`${modelId} is not available on ${backend.label} at ${profile.baseUrl}.`);
    }
    console.log(status({ kind: "success", message: `[ready] ${backend.label} at ${profile.baseUrl}` }));
  } else {
    const startup = await ensureLocalServer(profile, backend, options);
    if (startup?.handled) return startup.result;
  }

  printMemoryEstimate(profile, isManaged);

  console.log(theme.subtle("Verifying model loads (pre-flight inference test)..."));
  const preflight = await preflightInference(profile);
  if (!preflight.ok) {
    if (!isManaged) {
      try { await stopProfile(profile); } catch { /* best effort */ }
    } else {
      try { await unloadModelFromServer(profile); } catch { /* best effort */ }
    }
    const modelId = effectiveModelId(profile);
    throw new Error(`Model "${modelId}" failed to generate a test token: ${preflight.error}. The server was ready but the model could not load or infer. Check the model format and backend compatibility.`);
  }
  console.log(status({ kind: "success", message: "[preflight] Model loaded and generated a test token." }));

  await launchHarness(profile, options, isManaged, withHarness, backend);
  console.log("");
}

async function ensureLocalServer(profile, backend, options) {
  if (await serverReady(profile.baseUrl)) {
    const match = await serverMatchesProfile(profile);
    if (!match.matches) {
      throw new Error(`A different server is already responding at ${profile.baseUrl}. ${match.reason}. Stop it with offgrid-ai stop --all, or choose a different port.`);
    }
    console.log(status({ kind: "success", message: `[ready] Reusing server at ${profile.baseUrl}` }));
    return;
  }

  console.log(theme.subtle(`Starting ${backend.label} for ${profile.label}...`));
  let state;
  try {
    state = await startServer(profile);
    const tail = state?.rawLogPath ? tailFriendly(state.rawLogPath, state.friendlyLogPath) : { stop() {} };
    try {
      await waitForReady(profile, state?.pid, state?.rawLogPath);
      console.log(status({ kind: "success", message: `[ready] ${profile.baseUrl}/models` }));
    } finally {
      tail.stop();
    }
  } catch (err) {
    if (state?.pid) {
      try { await stopProfile(profile); } catch { /* best effort */ }
    }
    if (!options.textOnlyRetry && isUnsupportedMmprojError(err, profile)) {
      console.log(status({ kind: "warning", message: "Vision projector is not supported by this llama.cpp build. Retrying text-only." }));
      console.log(theme.subtle("Update llama.cpp later to re-enable vision for this model."));
      const textOnly = textOnlyProfile(profile);
      await saveProfile(textOnly);
      return { handled: true, result: await runProfile(textOnly, { ...options, textOnlyRetry: true }) };
    }
    throw err;
  }
}

function printMemoryEstimate(profile, isManaged) {
  if (isManaged || !profile.modelPath || !existsSync(profile.modelPath)) return;
  try {
    const est = estimateMemory(profile.modelPath, profile.mmprojPath, profile.drafterPath, profile.flags);
    console.log(renderMemoryEstimate(est, profile.flags));
  } catch {
    // Memory estimates are informational only.
  }
}

async function launchHarness(profile, options, isManaged, withHarness, backend) {
  if (withHarness !== "pi") {
    if (!isManaged) {
      console.log(theme.subtle(`Server running at ${profile.baseUrl}`));
      console.log(theme.subtle(`Stop with: offgrid-ai stop ${profile.id}`));
    } else {
      console.log(theme.subtle(`${backend.label} is a managed service — offgrid-ai does not stop it.`));
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
        console.log(result.stopped ? status({ kind: "success", message: `[stop] ${result.message}` }) : theme.subtle(`[stop] ${result.message}`));
      } else {
        const result = await unloadModelFromServer(profile);
        if (result.unloaded) {
          console.log(status({ kind: "success", message: `[unload] ${backend.label}: model unloaded` }));
        } else if (result.reason) {
          console.log(theme.subtle(`[unload] ${backend.label}: ${result.reason}`));
        } else if (result.error) {
          console.log(status({ kind: "warning", message: `[unload] ${backend.label}: ${result.error}` }));
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
  });
}
