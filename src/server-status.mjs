import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { readState, loadProfiles } from "./profiles.mjs";
import { backendFor } from "./backends.mjs";
import { ollamaLoadedModels } from "./ollama-runtime.mjs";
import { execFileAsync, sleep } from "./exec.mjs";
import { serverReady, stripTrailingSlash } from "./server-check.mjs";
import { GB } from "./hardware.mjs";

// ── Status checks ──────────────────────────────────────────────────────────

export async function isProfileRunning(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") {
    if (!(await serverReady(profile.baseUrl))) return false;
    // null = couldn't confirm (transient /models failure). The server is up
    // (serverReady passed), so assume running rather than flashing "not
    // running" on a network blip (H2).
    return (await modelLoadedOnServer(profile)) !== false;
  }
  const state = await readState(profile.id);
  return Boolean(state?.pid && pidAlive(state.pid));
}

export async function modelLoadedOnServer(profile) {
  const backend = backendFor(profile.backend);
  if (backend.id === "omlx") {
    const { ok, ids } = await omlxLoadedModelIds(profile);
    if (!ok) return null;
    return modelIdsMatch(ids, expectedModelIds(profile));
  }
  if (backend.id === "ollama") {
    const { ok, ids } = await ollamaLoadedModels();
    if (!ok) return null;
    const expected = expectedModelIds(profile);
    return ids.some((name) => expected.some((e) => e.toLowerCase() === name.toLowerCase()));
  }
  const { matches, reachable } = await serverMatchesProfile(profile);
  if (!reachable) return null;
  return matches;
}

export async function modelAvailableOnServer(profile) {
  const backend = backendFor(profile.backend);
  if (backend.id === "omlx" || backend.id === "ollama") {
    const { ok, ids } = await serverModelIds(profile.baseUrl);
    if (!ok) return null;
    return modelIdsMatch(ids, expectedModelIds(profile));
  }
  // Local servers are tied to a specific model file via their command argv.
  return true;
}

export async function runningProfiles() {
  const profiles = await loadProfiles();
  const statuses = await Promise.all(profiles.map(async (profile) => ({ profile, status: await profileRuntimeStatus(profile) })));
  return statuses.filter((item) => item.status.running);
}

export async function profileRuntimeStatus(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") {
    const ready = await serverReady(profile.baseUrl);
    if (!ready) {
      return { state: null, pid: null, running: false, ready, reachable: false, serverUp: false, modelLoaded: null, modelAvailable: null, rssBytes: null, startedAt: null };
    }
    const [modelLoaded, modelAvailable] = await Promise.all([modelLoadedOnServer(profile), modelAvailableOnServer(profile)]);
    return { state: null, pid: null, running: modelLoaded !== false, ready, reachable: true, serverUp: true, modelLoaded, modelAvailable, rssBytes: null, startedAt: null };
  }
  const state = await readState(profile.id);
  const running = Boolean(state?.pid && pidAlive(state.pid));
  const [ready, rssBytes] = await Promise.all([
    serverReady(profile.baseUrl),
    running ? pidRssBytes(state.pid) : Promise.resolve(null),
  ]);
  return { state, pid: state?.pid ?? null, running, ready, reachable: ready, rssBytes, startedAt: state?.startedAt ? new Date(state.startedAt) : null };
}

export async function serverMatchesProfile(profile) {
  const state = await readState(profile.id);
  if (state?.pid && pidAlive(state.pid) && state.baseUrl === profile.baseUrl) {
    return { matches: true, reason: "tracked minimal-ai server", reachable: true };
  }

  const { ok, ids } = await serverModelIds(profile.baseUrl);
  if (!ok) {
    return { matches: false, reachable: false, reason: `couldn't reach ${profile.baseUrl}/models to confirm the server (it may be starting up)` };
  }
  const expected = expectedModelIds(profile);
  const normalizedIds = new Set(ids.map((id) => id.toLowerCase()));
  if (ids.length > 0 && expected.some((id) => normalizedIds.has(id.toLowerCase()))) {
    return { matches: true, reason: `server reports ${ids.join(", ")}`, reachable: true };
  }

  return {
    matches: false,
    reachable: true,
    reason: ids.length > 0
      ? `server reports ${ids.join(", ")}; expected ${expected.join(" or ")}`
      : "server is untracked and did not report a recognizable model id",
  };
}

export async function waitForReady(profile, pid, rawLogPath) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") return;
  // Scale timeout by model size: large models take longer to load from disk.
  // Base 180s + 10s per GB, capped at 600s (10min).
  const timeoutSec = scaledTimeoutSec(profile, { baseSec: 180, perGbSec: 10, capSec: 600 });
  for (let i = 0; i < timeoutSec; i++) {
    if (await serverReady(profile.baseUrl)) return;
    if (pid && !pidAlive(pid)) {
      const tail = await readFile(rawLogPath, "utf8").catch(() => "");
      throw new Error(`llama-server exited early. Last log lines:\n${tail.split(/\r?\n/).slice(-20).join("\n")}`);
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${profile.baseUrl}/models after ${timeoutSec}s`);
}

// ── Pre-flight inference test ──────────────────────────────────────────────

/** Scale a timeout by model size (large models load slower from disk).
 *  Shared by waitForReady and preflightInference so the two don't drift
 *  apart (M5). Returns seconds. */
function scaledTimeoutSec(profile, { baseSec, perGbSec, capSec }) {
  let modelBytes = 0;
  try { modelBytes = statSync(profile.modelPath).size; } catch { /* file not found */ }
  return Math.min(capSec, baseSec + Math.floor(modelBytes / GB) * perGbSec);
}

/**
 * Send a minimal 1-token chat completion request to verify the model can
 * actually generate — not just that the server is listening.  Catches
 * model-load failures (Metal kernel errors, unsupported architectures,
 * corrupted weights) before handing off to Pi.
 *
 * For managed servers (oMLX, Ollama), this request may trigger lazy model
 * loading, so the timeout is generous (120s).
 */
export async function preflightInference(profile) {
  const baseUrl = stripTrailingSlash(profile.baseUrl);
  const modelId = profile.modelAlias ?? profile.id;
  // Scale timeout by model size: lazy-loaded managed models may need to
  // load from disk. Base 120s + 10s per GB, capped at 300s (5min).
  const timeoutSec = scaledTimeoutSec(profile, { baseSec: 120, perGbSec: 10, capSec: 300 });
  const timeoutMs = timeoutSec * 1000;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.ok) return { ok: true };

    const detail = await responseErrorDetail(response);
    return { ok: false, status: response.status, error: detail || `HTTP ${response.status}` };
  } catch (err) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      return { ok: false, error: `model did not respond within ${timeoutSec}s (it may still be loading)` };
    }
    return { ok: false, error: err.message };
  }
}

// ── Internals: HTTP + model-id + process + shell + timestamp ──────────────

export async function serverModelIds(baseUrl) {
  const result = await fetchJson(`${stripTrailingSlash(baseUrl)}/models`);
  if (!result.ok) return { ok: false, ids: [] };
  const ids = (Array.isArray(result.data?.data) ? result.data.data : [])
    .map((model) => String(model?.id ?? "").trim())
    .filter(Boolean);
  return { ok: true, ids };
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

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/** Read stable process attributes used to avoid signalling a reused PID. */
export async function readProcessIdentity(pid, exec = execFileAsync) {
  const read = async (format) => {
    const { stdout } = await exec("ps", ["-o", `${format}=`, "-p", String(pid)]);
    return stdout.trim();
  };
  const [startToken, pgid, executable, command] = await Promise.all([
    read("lstart"),
    read("pgid"),
    read("comm"),
    read("args"),
  ]);
  const commandToken = command.trim().split(/\s+/u)[0] ?? "";
  if (!startToken || !pgid || !executable || !commandToken) throw new Error("process identity is unavailable");
  return { pid: Number(pid), pgid, startToken, executable, commandToken };
}

/** Pure comparison helper; legacy states without identity never match. */
export function processIdentityMatches(expected, actual) {
  if (!expected || !actual || !Number.isInteger(expected.pid) || expected.pid !== actual.pid) return false;
  for (const field of ["startToken", "pgid", "executable", "commandToken"]) {
    if (typeof expected[field] !== "string" || !expected[field] || expected[field] !== actual[field]) return false;
  }
  return true;
}

async function pidRssBytes(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const rssKb = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(rssKb) ? rssKb * 1024 : null;
  } catch { return null; }
}

export async function responseErrorDetail(response) {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    const body = JSON.parse(text);
    return body?.detail ?? body?.message ?? text;
  } catch {
    return text;
  }
}

async function omlxLoadedModelIds(profile) {
  const statusResult = await fetchJson(`${stripTrailingSlash(profile.baseUrl)}/models/status`);
  if (!statusResult.ok) return { ok: false, ids: [] };
  const statusData = statusResult.data;
  const fromStatus = (Array.isArray(statusData?.models) ? statusData.models : [])
    .filter((model) => model?.loaded === true)
    .flatMap((model) => [model?.id, model?.name, model?.model, model?.alias])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);
  if (Number(statusData?.loaded_count) === 0) return { ok: true, ids: fromStatus };

  const summaryResult = await fetchJson(`${stripTrailingSlash(apiRootUrl(profile.baseUrl))}/api/status`);
  if (!summaryResult.ok) return { ok: true, ids: fromStatus };
  const summaryData = summaryResult.data;
  const fromSummary = (Array.isArray(summaryData?.loaded_models) ? summaryData.loaded_models : [])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);
  return { ok: true, ids: [...fromStatus, ...fromSummary] };
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, data: await response.json() };
  } catch (err) {
    return { ok: false, error: err?.message };
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
    profile.ollamaModel,
    profile.modelAlias,
    profile.label,
    profile.omlxModel,
    profile.modelPath,
    fileName,
    fileName ? fileName.replace(/\.gguf$/iu, "") : null,
  ].filter(Boolean).map(String);
}