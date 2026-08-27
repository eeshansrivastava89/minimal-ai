import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { readState, loadProfiles } from "./profiles.mjs";
import { backendFor } from "./backends.mjs";
import { execFileAsync, sleep } from "./exec.mjs";
import { serverReady, stripTrailingSlash } from "./server-check.mjs";
import { GB } from "./hardware.mjs";
import { managedActions } from "./managed-backends.mjs";
// HTTP + id helpers live in the leaf server-http.mjs; re-exported here so
// the process.mjs barrel and older importers keep one stable home.
export { serverModelIds, apiRootUrl, responseErrorDetail } from "./server-http.mjs";
import { serverModelIds, expectedModelIds, modelIdsMatch, responseErrorDetail } from "./server-http.mjs";

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
  const action = managedActions(backendFor(profile.backend));
  if (action?.modelLoaded) return await action.modelLoaded(profile);
  const { matches, reachable } = await serverMatchesProfile(profile);
  if (!reachable) return null;
  return matches;
}

export async function modelAvailableOnServer(profile) {
  const backend = backendFor(profile.backend);
  if (backend.type === "managed-server") {
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


