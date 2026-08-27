import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { LOG_DIR } from "./config.mjs";
import { writeState, readState, profileDir } from "./profiles.mjs";
import { backendFor } from "./backends.mjs";
import { sleep, execFileAsync } from "./exec.mjs";
import { serverReady } from "./server-check.mjs";
import { status, theme } from "./ui.mjs";
import { computeServerCommand, buildStartScript, timestampForFile } from "./server-command.mjs";
import { pidAlive, readProcessIdentity, processIdentityMatches } from "./server-status.mjs";
import { managedActions } from "./managed-backends.mjs";export async function startServer(profile) {
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
  const actions = managedActions(backend);
  if (!(await serverReady(profile.baseUrl))) {
    // Adapter owns the CLI start + its failure wording (A2).
    await actions.startManaged();

    // Wait for it to come up
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (await serverReady(profile.baseUrl)) break;
      process.stdout.write(".");
    }
    if (!(await serverReady(profile.baseUrl))) {
      throw new Error(`${backend.label} is not responding at ${profile.baseUrl}. Start it and try again.`);
    }
  }

  // Push profile-owned settings to the server (MTP, thinking on/off, budget)
  // whether the server was already up or just started. oMLX applies MTP
  // patches at model load time, so mtp_enabled must be in
  // model_settings.json before any request triggers a load; and because the
  // writer diffs full desired state, it also fires when an already-running
  // server drifted. ollama has no per-model settings adapter — skipped.
  await actions.applyModelSettings?.(profile);

  return writeManagedState(profile, backend);
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
  const action = managedActions(backendFor(profile.backend));
  if (action.unloadModel) return await action.unloadModel(profile);
  return { unloaded: false, backend: backendFor(profile.backend).id, reason: "stop server to unload" };
}

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

