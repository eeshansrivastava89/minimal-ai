import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { LOG_DIR } from "./config.mjs";
import { writeState, readState, profileDir } from "./profiles.mjs";
import { backendFor } from "./backends.mjs";
import { startOmlxServer } from "./omlx-runtime.mjs";
import { startOllamaServer, unloadOllamaModel } from "./ollama-runtime.mjs";
import { sleep, execFileAsync } from "./exec.mjs";
import { serverReady } from "./server-check.mjs";
import { pc } from "./ui.mjs";
import { computeServerCommand, buildStartScript, timestampForFile } from "./server-command.mjs";
import { pidAlive, serverModelIds, apiRootUrl, responseErrorDetail } from "./server-status.mjs";

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

  await writeFile(rawLogPath, `[offgrid-ai] ${new Date().toISOString()}\n[binary] ${binary}\n[argv]\n${argv.join(" ")}\n`, "utf8");
  await writeFile(friendlyLogPath, `[launch] starting ${backendFor(profile.backend).label} for ${profile.label}\n`, "utf8");

  const env = { ...process.env, ...extraEnv };

  const rawFd = openSync(rawLogPath, "a");
  let child;
  try {
    child = spawn(binary, argv, { detached: true, stdio: ["ignore", rawFd, rawFd], env });
  } finally {
    closeSync(rawFd);
  }
  child.unref();

  const state = {
    pid: child.pid,
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
    // Apply per-model settings (MTP) even when server is already running.
    if (backend.id === "omlx" && profile.capabilities?.mtp) {
      await ensureOmlxMtpSetting(profile);
    }
    return writeManagedState(profile, backend);
  }

  // Try to start the managed server via CLI
  if (backend.id === "omlx") {
    try {
      await startOmlxServer();
    } catch (err) {
      if (err.message.includes("not installed")) throw new Error(`${backend.label} is not installed. Run offgrid-ai to install it, or download oMLX from https://github.com/jundot/omlx/releases`, { cause: err });
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

  // Apply per-model settings (MTP) before the model is loaded.
  // oMLX applies MTP patches at load time, so the setting must be in
  // model_settings.json before any request triggers a load.
  if (backend.id === "omlx" && profile.capabilities?.mtp) {
    await ensureOmlxMtpSetting(profile);
  }

  return writeManagedState(profile, backend);
}

/**
 * Enable MTP on an oMLX model via the admin API before loading.
 * oMLX applies MTP patches at model load time, so the setting must be
 * persisted to model_settings.json before any request triggers a load.
 * If the model is already loaded, oMLX will use the setting on next reload.
 */
async function ensureOmlxMtpSetting(profile) {
  const baseUrl = apiRootUrl(profile.baseUrl);
  const modelId = profile.omlxModel ?? profile.modelAlias ?? profile.id;
  const settingsUrl = `${baseUrl}/admin/api/models/${encodeURIComponent(modelId)}/settings`;
  try {
    const response = await fetch(settingsUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mtp_enabled: true }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        console.log(pc.yellow(`[mtp] Could not enable MTP: oMLX admin authentication required. Enable skip_api_key_verification in oMLX settings, or enable MTP manually from the admin panel.`));
      } else if (response.status === 404) {
        console.log(pc.yellow(`[mtp] Model ${modelId} not found on oMLX server. MTP setting not applied.`));
      } else {
        const detail = await response.text().catch(() => "");
        console.log(pc.yellow(`[mtp] Could not enable MTP: HTTP ${response.status} ${detail}`));
      }
      return;
    }
    // PUT succeeded — verify the setting was actually persisted via GET
    const verifyResponse = await fetch(settingsUrl, { signal: AbortSignal.timeout(5000) });
    if (!verifyResponse.ok) {
      console.log(pc.yellow(`[mtp] MTP setting sent but could not verify (HTTP ${verifyResponse.status}). Check oMLX admin panel.`));
      return;
    }
    const settings = await verifyResponse.json();
    if (settings.mtp_enabled === true) {
      console.log(pc.green(`[mtp] Verified: MTP enabled for ${modelId}`));
    } else {
      console.log(pc.yellow(`[mtp] MTP setting was not persisted. Enable manually from oMLX admin panel.`));
    }
  } catch (err) {
    console.log(pc.yellow(`[mtp] Could not enable MTP: ${err.message}`));
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
    return { stopped: false, message: `${backend.label} is a managed service — offgrid-ai does not stop it.` };
  }
  const state = await readState(profile.id);
  if (!state?.pid) return { stopped: false, message: `No tracked pid for ${profile.id}.` };
  if (!pidAlive(state.pid)) {
    await writeState(profile.id, { ...state, pid: null, stoppedAt: new Date().toISOString(), stopReason: "pid-not-running" });
    return { stopped: false, message: `${profile.id} pid ${state.pid} is no longer running.` };
  }
  const pid = state.pid;
  try {
    const signal = await terminateProcess(pid);
    await writeState(profile.id, { ...state, pid: null, stoppedAt: new Date().toISOString(), stopSignal: signal });
    return { stopped: true, message: `Stopped ${profile.id} pid ${pid}` };
  } catch (error) {
    return { stopped: false, message: `Could not stop pid ${pid}: ${error.message}` };
  }
}

// Reliably terminate a detached local-server process group: SIGTERM with a
// grace period for graceful shutdown, then SIGKILL if still alive.
async function terminateProcess(pid) {
  const signalGroup = (sig) => {
    try { process.kill(-pid, sig); }
    catch { process.kill(pid, sig); } // not a group leader — kill the proc itself
  };
  signalGroup("SIGTERM");
  for (let i = 0; i < 50; i++) { // 5s grace for graceful shutdown
    if (await processGone(pid)) return "SIGTERM";
    await sleep(100);
  }
  signalGroup("SIGKILL");
  for (let i = 0; i < 30; i++) { // 3s for SIGKILL to take effect
    if (await processGone(pid)) return "SIGKILL";
    await sleep(100);
  }
  throw new Error(`pid ${pid} did not exit after SIGKILL`);
}

// True if the process is dead (or a zombie about to be reaped).
async function processGone(pid) {
  try { process.kill(pid, 0); }
  catch { return true; } // no such process
  // Alive to signal(0) — but a detached setsid child can briefly appear as a
  // zombie before launchd reaps it. Treat zombie as gone.
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)]);
    return /^Z/.test(stdout.trim());
  } catch {
    return false;
  }
}

// ── Unload model from a managed server (oMLX, Ollama) ──────────────────────
// Counterpart to stopProfile for local-server backends: stopProfile kills the
// server process (which unloads the model); unloadModelFromServer asks a
// managed server to release the model from memory via its HTTP API, leaving the
// server itself running. Together they give a consistent UX: quitting Pi
// unloads the model regardless of backend type.

export async function unloadModelFromServer(profile) {
  const backend = backendFor(profile.backend);

  if (backend.id === "llama-cpp") {
    return { unloaded: false, backend: backend.id, reason: "stop server to unload" };
  }

  if (backend.id === "omlx") {
    return await unloadOmlxModel(profile);
  }

  if (backend.id === "ollama") {
    return await unloadOllamaModelFromServer(profile);
  }

  return { unloaded: false, backend: backend.id, reason: "unsupported backend" };
}

async function unloadOllamaModelFromServer(profile) {
  const modelId = profile.ollamaModel || profile.modelAlias || profile.id;
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
  const modelId = profile.modelAlias || profile.omlxModel || profile.id;

  try {
    const ids = await serverModelIds(profile.baseUrl);
    const match = ids.find((id) => id.toLowerCase() === modelId.toLowerCase());
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