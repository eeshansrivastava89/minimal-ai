// Leaf module: OpenAI-compatible server HTTP helpers + model-id matching.
// Pure (node:path only) so runtimes, adapters, and server-status can all
// depend on it without cycles — apiRootUrl/responseErrorDetail used to live
// in server-status.mjs, which meant no lower layer could use them.

import { basename } from "node:path";

/** Fetch + parse JSON from a local admin endpoint (2s timeout, never throws). */
export async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, data: await response.json() };
  } catch (err) {
    return { ok: false, error: err?.message };
  }
}

/** Ids the server advertises at GET /models. */
export async function serverModelIds(baseUrl) {
  const result = await fetchJson(`${stripTrailingSlash(baseUrl)}/models`);
  if (!result.ok) return { ok: false, ids: [] };
  const ids = (Array.isArray(result.data?.data) ? result.data.data : [])
    .map((model) => String(model?.id ?? "").trim())
    .filter(Boolean);
  return { ok: true, ids };
}

export function stripTrailingSlash(url) {
  return String(url ?? "").replace(/\/+$/u, "");
}

/** Root of an OpenAI-compatible base URL (".../v1" → origin). */
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

/** Detail text from a failed HTTP response (JSON detail/message, else body). */
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

// ── Model-id matching ──────────────────────────────────────────────────────

/** Every id that would identify this model on a server. */
export function expectedModelIds(profile) {
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

/** Whether any expected id appears among the actual advertised ids. */
export function modelIdsMatch(actualIds, expectedIds) {
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

/** oMLX: ids currently loaded, from /models/status plus the admin summary. */
export async function omlxLoadedModelIds(baseUrl) {
  const statusResult = await fetchJson(`${stripTrailingSlash(baseUrl)}/models/status`);
  if (!statusResult.ok) return { ok: false, ids: [] };
  const statusData = statusResult.data;
  const fromStatus = (Array.isArray(statusData?.models) ? statusData.models : [])
    .filter((model) => model?.loaded === true)
    .flatMap((model) => [model?.id, model?.name, model?.model, model?.alias])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);
  if (Number(statusData?.loaded_count) === 0) return { ok: true, ids: fromStatus };

  const summaryResult = await fetchJson(`${stripTrailingSlash(apiRootUrl(baseUrl))}/api/status`);
  if (!summaryResult.ok) return { ok: true, ids: fromStatus };
  const summaryData = summaryResult.data;
  const fromSummary = (Array.isArray(summaryData?.loaded_models) ? summaryData.loaded_models : [])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);
  return { ok: true, ids: [...fromStatus, ...fromSummary] };
}