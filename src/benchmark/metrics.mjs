// ── Backend-aware server speed metrics ───────────────────────────────────────

import { backendFor } from "../backends.mjs";

const BENCH_SPEED_PROMPT = "Write a one-sentence summary of machine learning.";
const SPEED_QUERY_TIMEOUT_MS = 120_000;
const SPEED_QUERY_MAX_TOKENS = 64;

export async function queryServerMetrics(profile) {
  const backend = backendFor(profile.backend);

  if (backend.id === "llama-cpp" || backend.id === "llama-cpp-mtp") {
    return await queryLlamaCppMetrics(profile);
  }
  if (backend.id === "omlx") {
    return await queryOmlxMetrics(profile);
  }

  throw new Error(`Unsupported backend for benchmark speed metrics: ${backend.id}`);
}

async function queryLlamaCppMetrics(profile) {
  const body = {
    model: profile.modelAlias,
    messages: [{ role: "user", content: BENCH_SPEED_PROMPT }],
    stream: false,
    max_tokens: SPEED_QUERY_MAX_TOKENS,
  };

  const response = await fetch(profile.baseUrl.replace(/\/$/u, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SPEED_QUERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`llama.cpp speed query failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const timings = data.timings;
  if (!timings || typeof timings.prompt_per_second !== "number" || typeof timings.predicted_per_second !== "number") {
    throw new Error("llama.cpp response did not include usable timings object");
  }
  const draftN = timings.draft_n;
  const draftAccepted = timings.draft_n_accepted;

  return {
    prefillTokensPerSecond: timings.prompt_per_second ?? null,
    generationTokensPerSecond: timings.predicted_per_second ?? null,
    ttftMs: timings.prompt_ms ?? null,
    modelLoadMs: null,
    speculativeDecodeAcceptance: (draftN && Number.isFinite(draftAccepted) && Number.isFinite(draftN) && draftN > 0)
      ? draftAccepted / draftN
      : null,
    kvCacheTokens: timings.cache_n ?? null,
    metricSource: "llama.cpp /v1/chat/completions timings",
  };
}

async function queryOmlxMetrics(profile) {
  const body = {
    model: profile.modelAlias,
    messages: [{ role: "user", content: BENCH_SPEED_PROMPT }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: SPEED_QUERY_MAX_TOKENS,
  };

  const response = await fetch(profile.baseUrl.replace(/\/$/u, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SPEED_QUERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`oMLX speed query failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  let usage = null;
  for (const line of text.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk.usage) {
        usage = chunk.usage;
        break;
      }
    } catch {
      // Ignore malformed SSE chunks.
    }
  }

  if (!usage) {
    throw new Error("oMLX speed query did not return usage in streaming response");
  }

  return {
    prefillTokensPerSecond: usage.prompt_tokens_per_second ?? null,
    generationTokensPerSecond: usage.generation_tokens_per_second ?? null,
    ttftMs: usage.time_to_first_token != null ? usage.time_to_first_token * 1000 : null,
    modelLoadMs: null,
    speculativeDecodeAcceptance: null,
    kvCacheTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
    metricSource: "oMLX /v1/chat/completions streaming include_usage",
  };
}
