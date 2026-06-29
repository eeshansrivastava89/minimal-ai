import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { LOG_DIR } from "./config.mjs";
import { writeState, readState, readCommandArgv } from "./profiles.mjs";
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
    throw new Error("llama-server not found. Install the managed llama.cpp runtime by running offgrid-ai interactively.");
  }

  const timestamp = timestampForFile();
  const rawLogPath = join(LOG_DIR, `${profile.id}-${timestamp}.raw.log`);
  const friendlyLogPath = join(LOG_DIR, `${profile.id}-${timestamp}.friendly.log`);
  const commandArgv = await readCommandArgv(profile);

  await writeFile(rawLogPath, `[offgrid-ai] ${new Date().toISOString()}\n[binary] ${binary}\n[argv]\n${commandArgv.join(" ")}\n`, "utf8");
  await writeFile(friendlyLogPath, `[launch] starting llama-server for ${profile.label}\n`, "utf8");

  // Build argv: binary + command.json args
  const argv = [...commandArgv];
  // mlx-vlm requires APC_ENABLED=1 (86x TTFT improvement; fixes Metal cache clearing).
  const env = profile.backend === "mlx-vlm" ? { ...process.env, APC_ENABLED: "1" } : process.env;

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
  if (backend.type === "managed-server") {
    return await serverReady(profile.baseUrl) && (await modelLoadedOnServer(profile));
  }
  const state = await readState(profile.id);
  return Boolean(state?.pid && pidAlive(state.pid));
}

export async function isProfileServerUp(profile) {
  return await serverReady(profile.baseUrl);
}

export async function modelLoadedOnServer(profile) {
  const backend = backendFor(profile.backend);
  if (backend.id === "ollama") return modelIdsMatch(await ollamaLoadedModelIds(profile), expectedModelIds(profile));
  if (backend.id === "omlx") return modelIdsMatch(await omlxLoadedModelIds(profile), expectedModelIds(profile));
  const { matches } = await serverMatchesProfile(profile);
  return matches;
}

export async function modelAvailableOnServer(profile) {
  const backend = backendFor(profile.backend);
  if (backend.id === "ollama") {
    return modelIdsMatch(await ollamaAvailableModelIds(profile), expectedModelIds(profile));
  }
  if (backend.id === "omlx") {
    // /v1/models lists discovered models; an ID must exist there to be usable.
    return modelIdsMatch(await serverModelIds(profile.baseUrl), expectedModelIds(profile));
  }
  // Local servers are tied to a specific model file via their command argv.
  return true;
}

export async function profileRuntimeStatus(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") {
    const ready = await serverReady(profile.baseUrl);
    const [modelLoaded, modelAvailable] = ready
      ? await Promise.all([modelLoadedOnServer(profile), modelAvailableOnServer(profile)])
      : [false, false];
    return { state: null, pid: null, running: ready && modelLoaded, ready, serverUp: ready, modelLoaded, modelAvailable, rssBytes: null, startedAt: null };
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

export async function serverMatchesProfile(profile) {
  const state = await readState(profile.id);
  if (state?.pid && pidAlive(state.pid) && state.baseUrl === profile.baseUrl) {
    return { matches: true, reason: "tracked offgrid-ai server" };
  }

  const ids = await serverModelIds(profile.baseUrl);
  const expected = expectedModelIds(profile);
  const normalizedIds = new Set(ids.map((id) => id.toLowerCase()));
  if (ids.length > 0 && expected.some((id) => normalizedIds.has(id.toLowerCase()))) {
    return { matches: true, reason: `server reports ${ids.join(", ")}` };
  }

  return {
    matches: false,
    reason: ids.length > 0
      ? `server reports ${ids.join(", ")}; expected ${expected.join(" or ")}`
      : "server is untracked and did not report a recognizable model id",
  };
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

export async function serverModelIds(baseUrl) {
  const result = await fetchJson(`${baseUrl.replace(/\/+$/u, "")}/models`);
  if (!result.ok) return [];
  return (Array.isArray(result.data?.data) ? result.data.data : [])
    .map((model) => String(model?.id ?? "").trim())
    .filter(Boolean);
}

async function ollamaLoadedModelIds(profile) {
  const result = await fetchJson(`${apiRootUrl(profile.baseUrl)}/api/ps`);
  if (!result.ok) return [];
  return (Array.isArray(result.data?.models) ? result.data.models : [])
    .flatMap((model) => [model?.name, model?.model])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);
}

async function ollamaAvailableModelIds(profile) {
  const result = await fetchJson(`${apiRootUrl(profile.baseUrl)}/api/tags`);
  if (!result.ok) return [];
  return (Array.isArray(result.data?.models) ? result.data.models : [])
    .flatMap((model) => [model?.name, model?.model])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);
}

async function omlxLoadedModelIds(profile) {
  const statusResult = await fetchJson(`${profile.baseUrl.replace(/\/+$/u, "")}/models/status`);
  const fromStatus = statusResult.ok
    ? (Array.isArray(statusResult.data?.models) ? statusResult.data.models : [])
        .filter((model) => model?.loaded === true)
        .flatMap((model) => [model?.id, model?.name, model?.model, model?.alias])
        .map((id) => String(id ?? "").trim())
        .filter(Boolean)
    : [];
  if (!statusResult.ok || Number(statusResult.data?.loaded_count) === 0) return fromStatus;

  const summaryResult = await fetchJson(`${apiRootUrl(profile.baseUrl)}/api/status`);
  const fromSummary = summaryResult.ok
    ? (Array.isArray(summaryResult.data?.loaded_models) ? summaryResult.data.loaded_models : [])
        .map((id) => String(id ?? "").trim())
        .filter(Boolean)
    : [];
  return [...fromStatus, ...fromSummary];
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return { ok: false, reason: "http", status: response.status, data: null };
    const data = await response.json();
    return { ok: true, data };
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") return { ok: false, reason: "timeout", data: null };
    return { ok: false, reason: "network", data: null };
  }
}

export function apiRootUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/v1\/?$/u, "") || "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return String(baseUrl).replace(/\/v1\/?$/u, "").replace(/\/$/u, "");
  }
}

function modelIdsMatch(actualIds, expectedIds) {
  const actual = normalizedModelIds(actualIds);
  const expected = normalizedModelIds(expectedIds);
  return [...expected].some((id) => actual.has(id));
}

function normalizedModelIds(ids) {
  const normalized = new Set();
  for (const id of ids) {
    const value = normalizeModelId(id);
    if (!value) continue;
    normalized.add(value);
    if (value.endsWith(":latest")) normalized.add(value.slice(0, -":latest".length));
  }
  return normalized;
}

function normalizeModelId(id) {
  return String(id ?? "").trim().toLowerCase();
}

function expectedModelIds(profile) {
  const fileName = profile.modelPath ? basename(profile.modelPath) : null;
  return [
    profile.modelAlias,
    profile.label,
    profile.ollamaModel,
    profile.omlxModel,
    profile.modelPath,
    fileName,
    fileName ? fileName.replace(/\.gguf$/iu, "") : null,
  ].filter(Boolean).map(String);
}

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