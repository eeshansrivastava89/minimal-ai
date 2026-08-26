// Autotune safety layer — every invariant of the sweep lives here as code,
// never as a prompt the caller is expected to honor:
//
//   • experiment lockfile — one sweep at a time per data dir
//   • RAM gate — refuse to proceed below a free-memory threshold
//   • one-model invariant — unload anything loaded, then VERIFY loaded=false
//   • settings snapshot/restore — Discard means "exactly as before"
//   • journal — append-only sweep.jsonl so a crash/Ctrl-C resumes cleanly
//
// All functions return result objects; none throw on expected failures.

import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.mjs";
import { availableRamBytes } from "../hardware.mjs";
import { pidAlive, apiRootUrl } from "../server-status.mjs";
import { readOmlxModelSettings } from "../mlx-discovery.mjs";
import { putOmlxModelSettings } from "../omlx-runtime.mjs";
import { sleep } from "../exec.mjs";
import { slugModelId } from "../benchmark.mjs";
import { fetchOmlxAdminModels, inferenceLoadedIds } from "./probe.mjs";
import { ALL_OFF_BASELINE } from "./grid.mjs";

const LOCK_FILE = "autotune.lock";
const JOURNAL_FILE = "sweep.jsonl";
const SNAPSHOT_FILE = "settings-snapshot.json";
const UNLOAD_TIMEOUT_MS = 30000;

// ── Run directories ────────────────────────────────────────────────────────

export function autotuneRunsRoot() {
  return join(DATA_DIR, "autotune");
}

/** runs root/<model-slug>/<timestamp>/ — timestamp is filesystem-safe. */
export async function createRunDir(modelId, date = new Date()) {
  const runDir = join(autotuneRunsRoot(), slugModelId(modelId), date.toISOString().replace(/:/gu, "-"));
  await mkdir(runDir, { recursive: true });
  return runDir;
}

// ── Experiment lockfile ────────────────────────────────────────────────────

/**
 * Acquire the single autotune lock. One sweep at a time — the oMLX server
 * has one GPU. A stale lock (dead pid) is reclaimed; pid reuse is accepted.
 * Returns { ok: true, release } or { ok: false, reason: "locked", holder }.
 */
export async function acquireAutotuneLock({ modelId }) {
  const root = autotuneRunsRoot();
  await mkdir(root, { recursive: true });
  const lockPath = join(root, LOCK_FILE);

  let existing = null;
  try {
    existing = JSON.parse(await readFile(lockPath, "utf8"));
  } catch { /* no lock or unreadable — either way not a live holder */ }

  if (existing?.pid && pidAlive(existing.pid) && existing.pid !== process.pid) {
    return { ok: false, reason: "locked", holder: existing };
  }

  const record = { pid: process.pid, modelId, startedAt: new Date().toISOString() };
  await writeFile(lockPath, JSON.stringify(record, null, 2) + "\n");

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await rm(lockPath, { force: true }).catch(() => {});
  };
  // Best-effort release on abnormal exit so Ctrl-C doesn't strand the lock.
  process.once("exit", () => { if (!released) try { unlinkSync(lockPath); } catch { /* already gone */ } });

  return { ok: true, release, record };
}

// ── RAM gate ───────────────────────────────────────────────────────────────

/** availableRamBytes ≥ minFreeBytes? Returns the numbers either way. */
export function ramGate(minFreeBytes) {
  const available = availableRamBytes();
  return { ok: available >= minFreeBytes, availableBytes: available, minFreeBytes };
}

/** Poll until RAM recovers to a threshold (post-unload) or timeout. */
export async function waitForRam(minFreeBytes, { timeoutMs = 20000, pollMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let available = availableRamBytes();
  while (available < minFreeBytes && Date.now() < deadline) {
    await sleep(pollMs);
    available = availableRamBytes();
  }
  return { ok: available >= minFreeBytes, availableBytes: available };
}

// ── One-model invariant ────────────────────────────────────────────────────

/**
 * Unload anything currently loaded on the oMLX server, then verify via a
 * fresh admin probe that loaded=false for everything. This is the sweep's
 * hard precondition AND its teardown step — callers never manage loads.
 * Returns { ok, unloadedIds } or { ok: false, reason, detail }.
 */
export async function ensureNothingLoaded(baseUrl, { timeoutMs = UNLOAD_TIMEOUT_MS } = {}) {
  const initial = await fetchOmlxAdminModels(baseUrl);
  if (!initial.ok) return initial;
  const toUnload = inferenceLoadedIds(initial.models);

  for (const id of toUnload) {
    try {
      const response = await fetch(`${apiRootUrl(baseUrl)}/admin/api/models/${encodeURIComponent(id)}/unload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 400 "not loaded" and 404 "not found" are both success — the goal is
      // unloaded, not the un-load. 404 means the model isn't in the engine pool
      // (e.g. a helper that surfaced as loaded but isn't GPU-resident).
      if (!response.ok && response.status !== 404 && !(response.status === 400 && /not loaded/i.test(await response.text().catch(() => "")))) {
        return { ok: false, reason: "http", detail: `unload ${id}: HTTP ${response.status}` };
      }
    } catch (err) {
      return { ok: false, reason: "unreachable", detail: `unload ${id}: ${err?.message}` };
    }
  }

  // Verify with a fresh probe — the server reports truth, we don't assume it.
  // Helper engines (MarkItDown) stay "loaded" but aren't GPU-resident, so they
  // don't count against the one-model invariant.
  const deadline = Date.now() + timeoutMs;
  let verify = await fetchOmlxAdminModels(baseUrl);
  while (verify.ok && inferenceLoadedIds(verify.models).length > 0 && Date.now() < deadline) {
    await sleep(1000);
    verify = await fetchOmlxAdminModels(baseUrl);
  }
  if (!verify.ok) return verify;
  const stillLoaded = inferenceLoadedIds(verify.models);
  if (stillLoaded.length > 0) {
    return { ok: false, reason: "still-loaded", detail: stillLoaded.join(", "), unloadedIds: toUnload };
  }
  return { ok: true, unloadedIds: toUnload };
}

// ── Settings snapshot / restore ────────────────────────────────────────────

/**
 * Capture the user's current oMLX settings for modelId into
 * <runDir>/settings-snapshot.json. Reads the offline file (works whether or
 * not the server echoes everything). Records hadEntry=false when the model
 * had no settings entry — see restoreSettingsSnapshot for the caveat.
 */
export async function snapshotModelSettings(runDir, modelId) {
  const settings = await readOmlxModelSettings(modelId);
  const snapshot = {
    modelId,
    capturedAt: new Date().toISOString(),
    hadEntry: settings !== null,
    settings: settings ?? null,
  };
  await writeFile(join(runDir, SNAPSHOT_FILE), JSON.stringify(snapshot, null, 2) + "\n");
  return snapshot;
}

/**
 * Restore a previously snapshotted entry via an echo-verified PUT. oMLX PUTs
 * are partial merges layered on current state, so restoring only the
 * snapshotted keys would leave sweep-touched keys (turboquant_kv_enabled,
 * dflash_enabled, …) ON when the user's entry never had them. The PUT is
 * therefore { ...ALL_OFF_BASELINE, ...snapshot.settings }: keys the user had
 * are preserved exactly; sweep knobs they never had are forced explicitly
 * off. (Data keys like dflash_draft_model may linger when they didn't exist
 * before, but are inert behind their false boolean.) baseUrl accepts either
 * the /v1 form or the root — it is normalized here, matching sweepConfig.
 *
 * Caveat: the oMLX admin API has no "delete settings entry" — if the model
 * had no entry before the sweep (hadEntry=false), keys the sweep created
 * remain at their sweep-touched values; callers surface that as a warning
 * rather than pretending Discard was perfect.
 */
export async function restoreSettingsSnapshot(baseUrl, runDir) {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(join(runDir, SNAPSHOT_FILE), "utf8"));
  } catch (err) {
    return { ok: false, reason: "missing-snapshot", detail: err?.message };
  }
  if (!snapshot.hadEntry) {
    return { ok: false, reason: "no-entry-to-restore", modelId: snapshot.modelId };
  }
  const settings = { ...ALL_OFF_BASELINE, ...snapshot.settings };
  const result = await putOmlxModelSettings(apiRootUrl(baseUrl), snapshot.modelId, settings);
  return { ...result, modelId: snapshot.modelId };
}

// ── Journal ────────────────────────────────────────────────────────────────

/** Append one JSONL row. The journal is the resume source of truth. */
export async function appendJournal(runDir, row) {
  await appendFile(join(runDir, JOURNAL_FILE), `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
}

/**
 * Read the journal back — used by resume to find the first incomplete row.
 * Tolerant per line: one corrupt (crash-truncated) row is skipped, it does
 * not wipe out the resumable state of every completed config.
 */
export async function readJournal(runDir) {
  let text;
  try {
    text = await readFile(join(runDir, JOURNAL_FILE), "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch { /* corrupt/truncated line — skip it, keep the rest */ }
  }
  return rows;
}

