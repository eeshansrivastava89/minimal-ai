// oMLX capability probe — normalizes GET /admin/api/models entries into the
// records the autotune grid generator and safety layer drive off of. This is
// the only admin-endpoint parse in the codebase; /v1/models (serverModelIds)
// has no capability flags, and reading ~/.omlx/model_settings.json offline
// tells you settings, not capabilities.

import { apiRootUrl } from "../server-status.mjs";

const PROBE_TIMEOUT_MS = 5000;

/** Normalize one raw entry from GET /admin/api/models. */
export function normalizeOmlxAdminModel(raw) {
  return {
    id: String(raw?.id ?? "").trim(),
    displayName: String(raw?.display_name ?? raw?.id ?? "").trim(),
    modelPath: typeof raw?.model_path === "string" ? raw.model_path : null,
    loaded: raw?.loaded === true,
    isLoading: raw?.is_loading === true,
    estimatedSizeBytes: Number(raw?.estimated_size ?? 0) || 0,
    estimatedSizeFormatted: raw?.estimated_size_formatted ?? null,
    engineType: raw?.engine_type ?? null,
    thinkingDefault: raw?.thinking_default ?? null,
    mtpCompatible: raw?.mtp_compatible === true,
    mtpReason: raw?.mtp_compatibility_reason ?? null,
    dflashCompatible: raw?.dflash_compatible === true,
    dflashReason: raw?.dflash_compatibility_reason ?? null,
    // Mirrors the model's entry in ~/.omlx/model_settings.json (settings the
    // server knows; not a substitute for the offline file read in
    // mlx-discovery — use that one for snapshots).
    settings: raw?.settings && typeof raw.settings === "object" ? raw.settings : {},
  };
}

async function fetchJson(url, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "auth" };
    if (!response.ok) return { ok: false, reason: "http", detail: `HTTP ${response.status}` };
    return { ok: true, data: await response.json() };
  } catch (err) {
    return { ok: false, reason: "unreachable", detail: err?.message };
  }
}

/**
 * GET /admin/api/models → { ok, models } with normalized entries, or
 * { ok: false, reason } ("auth" | "http" | "unreachable"). Never throws.
 */
export async function fetchOmlxAdminModels(baseUrl) {
  const result = await fetchJson(`${apiRootUrl(baseUrl)}/admin/api/models`);
  if (!result.ok) return result;
  const list = Array.isArray(result.data?.models) ? result.data.models : [];
  return { ok: true, models: list.map(normalizeOmlxAdminModel) };
}

/**
 * Find one model by id (or displayName), case-insensitive. Returns
 * { ok: true, model: record|null } or the fetch error shape.
 */
export async function probeOmlxModel(baseUrl, modelId) {
  const result = await fetchOmlxAdminModels(baseUrl);
  if (!result.ok) return result;
  const needle = modelId.toLowerCase();
  const model = result.models.find((m) => m.id.toLowerCase() === needle)
    ?? result.models.find((m) => m.displayName.toLowerCase() === needle)
    ?? null;
  return { ok: true, model };
}

/** Ids of currently-loaded models from an already-fetched admin list. */
export function loadedModelIds(models) {
  return models.filter((m) => m.loaded).map((m) => m.id);
}

// Engine types that report `loaded: true` but are not GPU-resident inference
// engines (builtin helpers like MarkItDown). They aren't in the engine pool —
// unloading them 404s — so the one-model invariant doesn't apply to them.
const HELPER_ENGINE_TYPES = new Set(["markitdown"]);

/** Loaded ids excluding non-GPU-resident helpers (the one-model invariant set). */
export function inferenceLoadedIds(models) {
  return models.filter((m) => m.loaded && !HELPER_ENGINE_TYPES.has(m.engineType ?? "")).map((m) => m.id);
}

// ── MTPLX side-car import (the one mutating admin call here) ────────────────
//
// Some Qwen3.5/3.6 MLX checkpoints ship the MTP head as a separate
// `mtp.safetensors` side-car that oMLX does NOT auto-merge into the checkpoint
// index — the probe reports `mtp_compatible: false` with reason "MTPLX
// side-car detected but not imported." oMLX exposes a one-click admin UI button
// for this; behind it is `POST /admin/api/models/{id}/import-mtplx`, which we
// call here so autotune doesn't offload a manual oMLX-app click to the user.
// The merge is idempotent and non-destructive (it adds MTP tensors to the
// loadable index; it removes nothing). Everything else in this module is
// read-only.

const IMPORT_TIMEOUT_MS = 120_000;

/** True when a probe record is in the "side-car present but not imported" state. */
export function needsMtplxImport(model) {
  return Boolean(
    model && !model.mtpCompatible && /MTPLX side-car/i.test(model.mtpReason ?? ""),
  );
}

/** POST /admin/api/models/{id}/import-mtplx — merge the side-car MTP head. */
export async function importMtplxSidecar(baseUrl, modelId) {
  try {
    const response = await fetch(
      `${apiRootUrl(baseUrl)}/admin/api/models/${encodeURIComponent(modelId)}/import-mtplx`,
      { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS) },
    );
    if (response.status === 401 || response.status === 403) return { ok: false, reason: "auth" };
    if (response.status === 404) return { ok: false, reason: "not-found" };
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { ok: false, reason: "http", detail: `HTTP ${response.status} ${detail}`.trim() };
    }
    const data = await response.json().catch(() => ({}));
    return { ok: true, merged: data.mtp_tensors ?? null, mergeMode: data.merge_mode ?? null };
  } catch (err) {
    return { ok: false, reason: "unreachable", detail: err?.message };
  }
}

/**
 * If the model is in the side-car-not-imported state, import it and re-probe.
 * Returns { model, attempted, importResult?, flipped? } — `model` is the
 * (possibly re-probed) record to drive the grid off; `attempted` is true when
 * an import was needed; `flipped` is true when mtpCompatible is true after.
 */
export async function ensureMtplxImported(baseUrl, model) {
  if (!needsMtplxImport(model)) return { model, attempted: false };
  const importResult = await importMtplxSidecar(baseUrl, model.id);
  if (!importResult.ok) return { model, attempted: true, importResult, flipped: false };
  const reprobed = await probeOmlxModel(baseUrl, model.id);
  const updated = reprobed.ok ? reprobed.model : null;
  return { model: updated ?? model, attempted: true, importResult, flipped: Boolean(updated?.mtpCompatible) };
}
