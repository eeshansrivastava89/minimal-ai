import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { LOG_DIR } from "./config.mjs";
import { writeState, readState, profileDir, effectiveModelId } from "./profiles.mjs";
import { backendFor } from "./backends.mjs";
import { startOmlxServer, putOmlxModelSettings, omlxSettingsFailureHint } from "./omlx-runtime.mjs";
import { startOllamaServer, unloadOllamaModel } from "./ollama-runtime.mjs";
import { sleep, execFileAsync } from "./exec.mjs";
import { serverReady } from "./server-check.mjs";
import { status, theme } from "./ui.mjs";
import { computeServerCommand, buildStartScript, timestampForFile } from "./server-command.mjs";
import { mtpEnabledFor } from "./capabilities.mjs";
import { pidAlive, readProcessIdentity, processIdentityMatches, serverModelIds, apiRootUrl, responseErrorDetail } from "./server-status.mjs";

// ── Start server ───────────────────────────────────────────────────────────

export async function startServer(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") {
    return startManagedServer(profile, backend);
  }
  return startLocalServer(profile);
}

async function startLocalServer(profile) {
  const command = await computeServerCommand(profile);
  if (!command) throw new Error("No server command for this backend.");

  const { binary, argv, extraEnv } = command;

  const timestamp = timestampForFile();
  const rawLogPath = join(LOG_DIR, `${profile.id}-${timestamp}.raw.log`);
  const friendlyLogPath = join(LOG_DIR, `${profile.id}-${timestamp}.friendly.log`);

  // Write start.sh so the user can run the model manually
  const scriptPath = join(profileDir(profile.id), "start.sh");
  await writeFile(scriptPath, buildStartScript(profile, command), "utf8");
  await chmod(scriptPath, 0o755);

  await writeFile(rawLogPath, `[minimal-ai] ${new Date().toISOString()}\n[binary] ${binary}\n[argv]\n${argv.join(" ")}\n`, "utf8");
  await writeFile(friendlyLogPath, `[launch] starting ${backendFor(profile.backend).label} for ${profile.label}\n`, "utf8");

  const env = { ...process.env, ...extraEnv };

  const rawFd = openSync(rawLogPath, "a");
  let child;
  try {
    child = spawn(binary, argv, { detached: true, stdio: ["ignore", rawFd, rawFd], env });
    // Do not persist a state file until the child has reported a successful
    // exec. A spawn error otherwise leaves a stale PID users cannot stop.
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    closeSync(rawFd);
  }
  child.unref();
  let identity;
  try {
    identity = await readProcessIdentity(child.pid);
  } catch (error) {
    // Never signal a PID whose identity could not be verified. The process was
    // not persisted, so the user must clean up this exceptional orphan manually.
    throw new Error(`Could not verify llama-server process identity (pid ${child.pid}): ${error.message}. If the process is still running, stop it manually: kill ${child.pid}`, { cause: error });
  }

  const state = {
    pid: child.pid,
    pgid: identity.pgid,
    processIdentity: identity,
    profileId: profile.id,
    baseUrl: profile.baseUrl,
    binary,
    rawLogPath,
    friendlyLogPath,
    startedAt: new Date().toISOString(),
  };
  await writeState(profile.id, state);
  return state;
}

async function startManagedServer(profile, backend) {
  if (await serverReady(profile.baseUrl)) {
    // Apply per-model settings (MTP, thinking budget) even when the server
    // is already running.
    if (backend.id === "omlx") {
      await ensureOmlxModelSettings(profile);
    }
    return writeManagedState(profile, backend);
  }

  // Try to start the managed server via CLI
  if (backend.id === "omlx") {
    try {
      await startOmlxServer();
    } catch (err) {
      if (err.message.includes("not installed")) throw new Error(`${backend.label} is not installed. Run minimal-ai to install it, or download oMLX from https://github.com/jundot/omlx/releases`, { cause: err });
      throw new Error(`${backend.label} could not be auto-started: ${err.message}. Run \`omlx start\` manually.`, { cause: err });
    }
  }
  if (backend.id === "ollama") {
    try {
      await startOllamaServer();
    } catch (err) {
      throw new Error(`${backend.label} could not be auto-started: ${err.message}. Run \`ollama serve\` manually.`, { cause: err });
    }
  }

  // Wait for it to come up
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    if (await serverReady(profile.baseUrl)) break;
    process.stdout.write(".");
  }
  if (!(await serverReady(profile.baseUrl))) {
    throw new Error(`${backend.label} is not responding at ${profile.baseUrl}. Start it and try again.`);
  }

  // Apply per-model settings (MTP, thinking budget) before the model is
  // loaded. oMLX applies MTP patches at load time, so mtp_enabled must be
  // in model_settings.json before any request triggers a load; the
  // thinking budget is generation-time but applied here so the profile
  // stays the source of truth.
  if (backend.id === "omlx") {
    await ensureOmlxModelSettings(profile);
  }

  return writeManagedState(profile, backend);
}

/**
 * Push profile-owned oMLX model settings (MTP toggle, thinking budget) to
 * the server via the admin API before loading. oMLX applies MTP patches at
 * model load time, so the setting must be persisted to model_settings.json
 * before any request triggers a load. If the model is already loaded, oMLX
 * uses MTP on next reload; thinking budget takes effect immediately.
 */
async function ensureOmlxModelSettings(profile) {
  const settings = {};
  if (mtpEnabledFor(profile)) settings.mtp_enabled = true;
  if (profile.thinkingOff === true) settings.enable_thinking = false;
  if (Number.isFinite(profile.thinkingBudget)) {
    settings.thinking_budget_enabled = true;
    settings.thinking_budget_tokens = profile.thinkingBudget;
  }
  if (Object.keys(settings).length === 0) return;

  const result = await putOmlxModelSettings(apiRootUrl(profile.baseUrl), effectiveModelId(profile), settings);
  if (result.ok) {
    const applied = [
      settings.mtp_enabled ? "MTP enabled" : null,
      settings.enable_thinking === false ? "thinking off" : null,
      settings.thinking_budget_tokens ? `thinking budget ${settings.thinking_budget_tokens}` : null,
    ].filter(Boolean).join(" + ");
    const verb = result.verified === false ? "Applied (not independently verified)" : "Verified";
    console.log(status({ kind: "success", message: `[omlx] ${verb}: ${applied} for ${effectiveModelId(profile)}` }));
  } else {
    console.log(status({ kind: "warning", message: `[omlx] Could not apply model settings: ${omlxSettingsFailureHint(result)}` }));
  }
}

async function writeManagedState(profile, backend) {
  const state = {
    pid: null,
    profileId: profile.id,
    baseUrl: profile.baseUrl,
    managedBy: backend.id,
    startedAt: new Date().toISOString(),
  };
  await writeState(profile.id, state);
  return state;
}

// ── Stop server ────────────────────────────────────────────────────────────

export async function stopProfile(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") {
    return { stopped: false, message: `${backend.label} is a managed service — minimal-ai does not stop it.` };
  }
  const state = await readState(profile.id);
  if (!state?.pid) return { stopped: false, message: `No tracked pid for ${profile.id}.` };
  if (!pidAlive(state.pid)) {
    await writeState(profile.id, { ...state, pid: null, stoppedAt: new Date().toISOString(), stopReason: "pid-not-running" });
    return { stopped: false, message: `${profile.id} pid ${state.pid} is no longer running.` };
  }
  if (!state.processIdentity || !processIdentityMatches(state.processIdentity, await readProcessIdentity(state.pid).catch(() => null))) {
    return { stopped: false, unsafe: true, message: `Refusing to signal pid ${state.pid}: process identity is missing or does not match. Clean it up manually.` };
  }
  const pid = state.pid;
  try {
    const signal = await terminateProcess(pid, state.processIdentity);
    await writeState(profile.id, { ...state, pid: null, stoppedAt: new Date().toISOString(), stopSignal: signal });
    return { stopped: true, message: `Stopped ${profile.id} pid ${pid}` };
  } catch (error) {
    return { stopped: false, message: `Could not stop pid ${pid}: ${error.message}` };
  }
}

// Reliably terminate a detached local-server process group: SIGTERM with a
// grace period for graceful shutdown, then SIGKILL if still alive.
async function terminateProcess(pid, expectedIdentity) {
  const verifyIdentity = async () => processIdentityMatches(expectedIdentity, await readProcessIdentity(pid).catch(() => null));
  const signalTarget = expectedIdentity.pgid === String(pid) ? -pid : pid;
  const signalGroup = async (sig) => {
    if (!await verifyIdentity()) throw new Error("process identity changed or is unavailable; clean it up manually");
    process.kill(signalTarget, sig);
  };
  await signalGroup("SIGTERM");
  for (let i = 0; i < 50; i++) { // 5s grace for graceful shutdown
    if (await processGone(pid, expectedIdentity)) return "SIGTERM";
    await sleep(100);
  }
  await signalGroup("SIGKILL");
  for (let i = 0; i < 30; i++) { // 3s for SIGKILL to take effect
    if (await processGone(pid, expectedIdentity)) return "SIGKILL";
    await sleep(100);
  }
  throw new Error(`pid ${pid} did not exit after SIGKILL`);
}

// True if the process is dead (or a zombie about to be reaped).
async function processGone(pid, identity) {
  // Detached llama.cpp launches are process-group leaders. Checking the group
  // keeps us from reporting success while a child survives its leader.
  const target = identity?.pgid === String(pid) ? -pid : pid;
  try { process.kill(target, 0); }
  catch { return true; } // no such process/group
  // Alive to signal(0) — but a detached setsid child can briefly appear as a
  // zombie before launchd reaps it. Treat zombie as gone.
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)]);
    return target === pid && /^Z/.test(stdout.trim());
  } catch {
    return false;
  }
}

// ── Unload model from a managed server (oMLX, Ollama) ──────────────────────

/** Ask a managed server to release the model; local servers return a reason. */
export async function unloadModelFromServer(profile) {
  const backend = backendFor(profile.backend);
  if (backend.id === "omlx") return await unloadOmlxModel(profile);
  if (backend.id === "ollama") return await unloadOllamaModelFromServer(profile);
  return { unloaded: false, backend: backend.id, reason: "stop server to unload" };
}

/**
 * The single "stop this model" UX: local servers are killed (which unloads
 * the model); managed servers keep running and just release the model from
 * memory via their HTTP API. Prints the outcome either way.
 */
export async function stopOrUnload(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") {
    const result = await unloadModelFromServer(profile);
    if (result.unloaded) {
      console.log(status({ kind: "success", message: `[unload] ${profile.label}: model unloaded` }));
    } else if (result.reason) {
      console.log(theme.subtle(`[unload] ${profile.label}: ${result.reason}`));
    } else if (result.error) {
      console.log(status({ kind: "warning", message: `[unload] ${profile.label}: ${result.error}` }));
    }
    return result;
  }
  const result = await stopProfile(profile);
  console.log(result.stopped ? status({ kind: "success", message: `[stop] ${result.message}` }) : theme.subtle(`[stop] ${result.message}`));
  return result;
}

async function unloadOllamaModelFromServer(profile) {
  const modelId = effectiveModelId(profile);
  try {
    const ok = await unloadOllamaModel(modelId);
    if (ok) return { unloaded: true, backend: "ollama", modelId };
    return { unloaded: false, backend: "ollama", modelId, error: "Ollama did not confirm unload" };
  } catch (err) {
    return { unloaded: false, backend: "ollama", modelId, error: err.message };
  }
}

async function unloadOmlxModel(profile) {
  const adminUrl = `${apiRootUrl(profile.baseUrl)}/admin/api/models`;
  const modelId = effectiveModelId(profile);

  try {
    const result = await serverModelIds(profile.baseUrl);
    if (!result.ok) {
      return { unloaded: false, backend: "omlx", modelId, error: `couldn't reach ${profile.baseUrl} to list loaded models for unload` };
    }
    const match = result.ids.find((id) => id.toLowerCase() === modelId.toLowerCase());
    const targetId = match ?? modelId;

    const response = await fetch(`${adminUrl}/${encodeURIComponent(targetId)}/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30000),
    });

    if (response.ok) {
      return { unloaded: true, backend: "omlx", modelId: targetId };
    }

    const detail = await responseErrorDetail(response);

    if (response.status === 400 && /not loaded/i.test(detail)) {
      return { unloaded: true, backend: "omlx", modelId: targetId, reason: "model was not loaded" };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        unloaded: false,
        backend: "omlx",
        modelId: targetId,
        error: "oMLX admin authentication required. Enable skip_api_key_verification in oMLX settings, or unload manually from the admin panel.",
      };
    }

    return { unloaded: false, backend: "omlx", modelId: targetId, error: `HTTP ${response.status}: ${detail}` };
  } catch (err) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      return { unloaded: false, backend: "omlx", modelId, error: "Unload request timed out. The model may still be unloading in the background." };
    }
    return { unloaded: false, backend: "omlx", modelId, error: err.message };
  }
}