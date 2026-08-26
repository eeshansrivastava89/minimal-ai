// Autotune measurement engine — the speed-sweep state machine plus the
// server.log parser and MAD confidence it drives. Built on the safety layer
// (one-model invariant, RAM gate, journal) and putOmlxModelSettings.
//
// Per-config state machine (reference doc "Speed methodology"):
//   PRECHECK  ensureNothingLoaded + RAM gate
//   PUT       row.settings delta (echo-verified by putOmlxModelSettings)
//   COLD      one /v1/chat/completions — auto-reloads with the new engine config
//   WARM      n identical requests (prefix cache hot) — steady-state tps
//   TEARDOWN  ensureNothingLoaded + waitForRam
//   JOURNAL   append a config-done row (crash/Ctrl-C resumes here)
//
// The parser is pure and fixture-tested against real captured log lines; the
// network orchestration (sweepConfig) is thin glue validated live
// in Phase 3, mirroring how the safety layer is tested.

import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { apiRootUrl } from "../server-status.mjs";
import { putOmlxModelSettings } from "../omlx-runtime.mjs";
import {
  ensureNothingLoaded,
  ramGate,
  waitForRam,
  appendJournal,
} from "./safety.mjs";

// ── Micro-benchmark prompt + params (reference doc "Speed methodology") ─────
//
// Fixed prompt, temperature=0, seed=1, one model loaded at a time. ~170 output
// tokens thinking-off, ~300 with thinking-on. Bounded generation so a sweep
// config completes in seconds, not minutes.

export const BENCHMARK_PROMPT =
  "Write a short, vivid blog intro (about 120 words) on why running AI locally matters for privacy and ownership.";
export const BENCHMARK_MAX_TOKENS = 300;
export const BENCHMARK_TEMPERATURE = 0;
export const BENCHMARK_SEED = 1;

// Floor of free RAM (bytes) required before loading a config. With everything
// unloaded on a 48 GB machine this passes trivially; it exists to refuse the
// next config if a previous unload didn't actually free memory. The wizard
// (Phase 2) can raise this model-size-aware.
const DEFAULT_RAM_MIN_BYTES = 8 * 1024 ** 3;
const DEFAULT_WARM_RUNS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000; // cold load + 300 tokens on a 27B

/** ~/.omlx/logs/server.log — the engine's own throughput log. */
export function serverLogPath() {
  return join(homedir(), ".omlx", "logs", "server.log");
}

// ── server.log parser (pure) ───────────────────────────────────────────────
//
// Real captured formats (2026-08-26, oMLX 0.6.3rc3):
//   Chat completion: model=<id>, <N> tokens in <T>s (<X> tok/s), prompt: <P>, finish_reason=<r>, max_tokens=…, request_max_tokens=…
//   MTP[0] finish=length tokens=<N> cycles=<C> tok/cycle=<X> accept=<a>/<t> (<pct>%) depth[…] emits[…] timing[…]

const CHAT_COMPLETION_RE =
  /Chat completion:\s*model=([^,]+),\s*(\d+)\s+tokens\s+in\s+([\d.]+)s\s+\(([\d.]+)\s+tok\/s\),\s*prompt:\s*(\d+)(?:,\s*finish_reason=(\w+))?/;

const MTP_RE =
  /MTP\[\d+\][^\n]*?tokens=(\d+)\s+cycles=(\d+)\s+tok\/cycle=([\d.]+)\s+accept=(\d+)\/(\d+)\s+\(([\d.]+)%\)/;

/** Parse one `Chat completion:` log line. Returns null if it isn't one. */
export function parseChatCompletionLine(line) {
  const m = String(line ?? "").match(CHAT_COMPLETION_RE);
  if (!m) return null;
  return {
    model: m[1].trim(),
    tokens: Number(m[2]),
    seconds: Number(m[3]),
    tps: Number(m[4]),
    promptTokens: Number(m[5]),
    finishReason: m[6] ?? null,
  };
}

/** Parse one `MTP[…]` log line. Returns null if it isn't one. */
export function parseMtpLine(line) {
  const m = String(line ?? "").match(MTP_RE);
  if (!m) return null;
  return {
    tokens: Number(m[1]),
    cycles: Number(m[2]),
    tokPerCycle: Number(m[3]),
    accepted: Number(m[4]),
    total: Number(m[5]),
    acceptPct: Number(m[6]),
  };
}

/**
 * Extract the last completion (+ last MTP stats) from a block of log text.
 * The MTP line is emitted just before its `Chat completion:` line, so taking
 * the last of each pairs them. Returns null if no completion line is present.
 */
export function extractMeasurement(logText) {
  const lines = String(logText ?? "").split("\n");
  let completion = null;
  let mtp = null;
  for (const line of lines) {
    const c = parseChatCompletionLine(line);
    if (c) completion = c;
    const m = parseMtpLine(line);
    if (m) mtp = m;
  }
  if (!completion) return null;
  return { ...completion, mtp };
}

// ── MAD confidence (pure) ──────────────────────────────────────────────────
//
// Within-config repeatability: median tps + median absolute deviation (the
// noise). A cross-config difference is "real" when it is ≥ 2× the noise (the
// reference doc's "≥2× over noise = real" rule, applied by recommend.mjs).

export function median(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mad(samples) {
  if (samples.length < 2) return 0;
  const m = median(samples);
  return median(samples.map((x) => Math.abs(x - m)));
}

/** Summarize a sample set for the report + recommendation engine. */
export function summarizeSamples(samples) {
  const values = samples.filter((x) => typeof x === "number" && !Number.isNaN(x));
  if (!values.length) {
    return { n: 0, median: null, mad: 0, min: null, max: null, spread: 0, noiseRatio: 0 };
  }
  const m = median(values);
  const a = mad(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { n: values.length, median: m, mad: a, min, max, spread: max - min, noiseRatio: m ? a / m : 0 };
}

// ── Log tail reader ─────────────────────────────────────────────────────────

/**
 * Pick the MTP acceptance sample reported for a config: the most recent run
 * that logged MTP stats, warm runs preferred (cold includes load effects).
 * `warm` is the run-result array; `coldMeasurement` may be null. Returns the
 * measurement.mtp object or null.
 */
export function pickMtpSample(warm, coldMeasurement) {
  return [{ ok: true, measurement: coldMeasurement }, ...warm]
    .filter((r) => r.ok && r.measurement?.mtp)
    .map((r) => r.measurement.mtp)
    .pop() ?? null;
}

async function logSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Read the log from a byte offset; returns the new text and the new offset.
 * A missing log (ENOENT mid-sweep — rotation, manual cleanup) is not fatal:
 * treated as "nothing new yet", fresh reads start at 0 like logSize does.
 */
export async function readLogSince(path, offsetBytes = 0) {
  let fh;
  try {
    fh = await open(path, "r");
  } catch (err) {
    if (err?.code === "ENOENT") return { text: "", offset: 0 };
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size <= offsetBytes) return { text: "", offset: size };
    const buffer = Buffer.alloc(size - offsetBytes);
    await fh.read(buffer, 0, buffer.length, offsetBytes);
    return { text: buffer.toString("utf8"), offset: size };
  } finally {
    await fh.close();
  }
}

// ── Completion request runner ───────────────────────────────────────────────

/**
 * POST /v1/chat/completions with the fixed micro-benchmark params. Returns
 * { ok, httpStatus, elapsedMs, completion } or { ok: false, reason, elapsedMs }.
 * The gen tps comes from the server.log parse (the engine's own accounting),
 * not wall-clock — this just drives the request and returns the JSON body.
 */
export async function runCompletion(baseUrl, modelId, options = {}) {
  const {
    maxTokens = BENCHMARK_MAX_TOKENS,
    prompt = BENCHMARK_PROMPT,
    temperature = BENCHMARK_TEMPERATURE,
    seed = BENCHMARK_SEED,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options;
  const start = Date.now();
  try {
    const response = await fetch(`${apiRootUrl(baseUrl)}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature,
        seed,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsedMs = Date.now() - start;
    if (!response.ok) {
      return { ok: false, reason: "http", httpStatus: response.status, elapsedMs };
    }
    const completion = await response.json().catch(() => null);
    return { ok: true, httpStatus: response.status, elapsedMs, completion };
  } catch (err) {
    const reason = err?.name === "TimeoutError" || /timeout|aborted/i.test(err?.message ?? "")
      ? "timeout"
      : "unreachable";
    return { ok: false, reason, detail: err?.message, elapsedMs: Date.now() - start };
  }
}

// ── One measurement (request + log parse) ───────────────────────────────────

async function measureOnce(baseUrl, modelId, logPath, requestTimeoutMs) {
  const offset = await logSize(logPath);
  const run = await runCompletion(baseUrl, modelId, { timeoutMs: requestTimeoutMs });
  if (!run.ok) return { ok: false, ...run };
  const { text } = await readLogSince(logPath, offset);
  const measurement = extractMeasurement(text);
  if (!measurement) {
    return { ok: false, reason: "no-log-line", elapsedMs: run.elapsedMs };
  }
  return { ok: true, elapsedMs: run.elapsedMs, measurement };
}

// ── Per-config state machine ────────────────────────────────────────────────

/**
 * Sweep one grid config: precheck → PUT → cold run → warm runs → teardown →
 * journal. Returns { ok, configId, label, cold, warm, summary, … } or
 * { ok: false, configId, label, reason, detail } for a precheck/put failure.
 * A warm-run failure is recorded but not fatal (partial samples may suffice).
 */
export async function sweepConfig(baseUrl, runDir, modelId, row, options = {}) {
  const {
    warmRuns = DEFAULT_WARM_RUNS,
    ramMinFreeBytes = DEFAULT_RAM_MIN_BYTES,
    logPath = serverLogPath(),
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options;

  // PRECHECK — one-model invariant + RAM gate.
  const precheck = await ensureNothingLoaded(baseUrl);
  if (!precheck.ok) {
    return { ok: false, configId: row.id, label: row.label, reason: "precheck", detail: precheck };
  }
  const gate = ramGate(ramMinFreeBytes);
  if (!gate.ok) {
    return { ok: false, configId: row.id, label: row.label, reason: "ram-gate", detail: gate };
  }

  // PUT config (echo-verified). Done while unloaded; the cold run reloads it.
  // putOmlxModelSettings builds its URL from baseUrl directly (no apiRootUrl),
  // so normalize here — every sweep entry point then accepts the /v1 form.
  const put = await putOmlxModelSettings(apiRootUrl(baseUrl), modelId, row.settings);
  if (!put.ok) {
    return { ok: false, configId: row.id, label: row.label, reason: "put", detail: put };
  }

  // COLD run — auto-reloads the model with the new engine config.
  const cold = await measureOnce(baseUrl, modelId, logPath, requestTimeoutMs);
  if (!cold.ok) {
    return { ok: false, configId: row.id, label: row.label, reason: "cold-run", detail: cold, put };
  }

  // WARM runs — prefix cache hot; these are the steady-state tps samples.
  const warm = [];
  for (let i = 0; i < warmRuns; i++) {
    const run = await measureOnce(baseUrl, modelId, logPath, requestTimeoutMs);
    if (!run.ok) {
      // Not fatal — we may already have enough warm samples to summarize.
      warm.push({ ok: false, index: i, ...run });
      break;
    }
    warm.push({ ok: true, index: i, measurement: run.measurement });
  }
  const warmOk = warm.filter((r) => r.ok).map((r) => r.measurement.tps);
  const summary = summarizeSamples(warmOk);
  // MTP acceptance from the most recent run that logged it (warm preferred —
  // the cold run includes load effects and is the least representative).
  summary.mtp = pickMtpSample(warm, cold.measurement);

  // TEARDOWN — unload + verify RAM recovered for the next config.
  const teardown = await ensureNothingLoaded(baseUrl);
  if (teardown.ok) await waitForRam(ramMinFreeBytes);

  const result = {
    ok: true,
    configId: row.id,
    label: row.label,
    family: row.family,
    settings: row.settings,
    cold: cold.measurement,
    warm: warm.filter((r) => r.ok).map((r) => r.measurement),
    warmFailures: warm.filter((r) => !r.ok),
    summary,
    teardown,
  };

  // JOURNAL — the resume source of truth. Summary carries everything
  // recommend.mjs needs, so a restart can recommend off the journal alone.
  await appendJournal(runDir, {
    event: "config-done",
    configId: row.id,
    label: row.label,
    summary,
  });
  return result;
}
