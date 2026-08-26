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
