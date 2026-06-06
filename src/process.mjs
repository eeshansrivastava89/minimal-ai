import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOG_DIR } from "./config.mjs";
import { writeState, readState } from "./profiles.mjs";
import { backendFor, backendBinaryFor } from "./backends.mjs";

const execFileAsync = promisify(execFile);

// ── Start server ───────────────────────────────────────────────────────────

export async function startServer(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") {
    return startManagedServer(profile, backend);
  }
  return startLocalServer(profile);
}

async function startLocalServer(profile) {
  const binary = await backendBinaryFor(profile.backend);
  if (!binary) {
    throw new Error("llama-server not found. Install it via Homebrew: brew install llama.cpp");
  }

  const timestamp = timestampForFile();
  const rawLogPath = join(LOG_DIR, `${profile.id}-${timestamp}.raw.log`);
  const friendlyLogPath = join(LOG_DIR, `${profile.id}-${timestamp}.friendly.log`);
  const commandJson = profile.commandArgv ?? [];

  await writeFile(rawLogPath, `[offgrid-ai] ${new Date().toISOString()}\n[binary] ${binary}\n[argv]\n${commandJson.join(" ")}\n`, "utf8");
  await writeFile(friendlyLogPath, `[launch] starting llama-server for ${profile.label}\n`, "utf8");

  // Build argv: binary + command.json args
  const argv = [...commandJson];

  const rawFd = openSync(rawLogPath, "a");
  const child = spawn(binary, argv, { detached: true, stdio: ["ignore", rawFd, rawFd] });
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
  const ready = await serverReady(profile.baseUrl);
  if (ready) {
    // Already running
  } else {
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (await serverReady(profile.baseUrl)) break;
      process.stdout.write(".");
    }
    if (!(await serverReady(profile.baseUrl))) {
      throw new Error(`${backend.label} is not responding at ${profile.baseUrl}. Start it and try again.`);
    }
  }
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
  try {
    try {
      process.kill(-state.pid, "SIGTERM");
    } catch {
      process.kill(state.pid, "SIGTERM");
    }
    await writeState(profile.id, { ...state, pid: null, stoppedAt: new Date().toISOString(), stopSignal: "SIGTERM" });
    return { stopped: true, message: `Stopped ${profile.id} pid ${state.pid}` };
  } catch (error) {
    return { stopped: false, message: `Could not stop pid ${state.pid}: ${error.message}` };
  }
}

// ── Status checks ──────────────────────────────────────────────────────────

export async function isProfileRunning(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") return await serverReady(profile.baseUrl);
  const state = await readState(profile.id);
  return Boolean(state?.pid && pidAlive(state.pid));
}

export async function profileRuntimeStatus(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") {
    const ready = await serverReady(profile.baseUrl);
    return { state: null, pid: null, running: ready, ready, rssBytes: null, startedAt: null };
  }
  const state = await readState(profile.id);
  const running = Boolean(state?.pid && pidAlive(state.pid));
  const [ready, rssBytes] = await Promise.all([
    serverReady(profile.baseUrl),
    running ? pidRssBytes(state.pid) : Promise.resolve(null),
  ]);
  return { state, pid: state?.pid ?? null, running, ready, rssBytes, startedAt: state?.startedAt ? new Date(state.startedAt) : null };
}

export async function serverReady(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForReady(profile, pid, rawLogPath) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") return;
  for (let i = 0; i < 180; i++) {
    if (await serverReady(profile.baseUrl)) return;
    if (pid && !pidAlive(pid)) {
      const tail = await readFile(rawLogPath, "utf8").catch(() => "");
      throw new Error(`llama-server exited early. Last log lines:\n${tail.split(/\r?\n/).slice(-20).join("\n")}`);
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${profile.baseUrl}/models`);
}

// ── Internals ──────────────────────────────────────────────────────────────

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function pidRssBytes(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const rssKb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(rssKb) ? rssKb * 1024 : null;
  } catch { return null; }
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}