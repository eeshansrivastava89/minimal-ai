// ── Unload model from server memory after benchmark ────────────────────────────

import { backendFor } from "../backends.mjs";
import { apiRootUrl, serverModelIds } from "../process.mjs";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pc, renderRows, renderSection } from "../ui.mjs";

export async function unloadModelFromServer(profile) {
  const backend = backendFor(profile.backend);

  if (backend.id === "ollama") {
    const apiBaseUrl = apiRootUrl(profile.baseUrl || backend.apiBaseUrl || "");

    try {
      await fetch(`${apiBaseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: profile.modelAlias, prompt: "", stream: false, keep_alive: 0 }),
        signal: AbortSignal.timeout(10000),
      });
      return { unloaded: true, backend: backend.id };
    } catch (err) {
      return { unloaded: false, backend: backend.id, error: err.message };
    }
  }

  if (backend.id === "llama-cpp" || backend.id === "llama-cpp-mtp") {
    // llama.cpp unloads when the server process exits; no HTTP unload API exists.
    // If offgrid-ai started the server, stopProfile already handled it.
    return { unloaded: false, backend: backend.id, reason: "stop server to unload" };
  }

  if (backend.id === "omlx") {
    return await unloadOmlxModel(profile);
  }

  return { unloaded: false, backend: backend.id, reason: "unsupported backend" };
}

async function unloadOmlxModel(profile) {
  const baseUrl = profile.baseUrl?.replace(/\/v1\/?$/u, "") || "";
  const adminUrl = `${baseUrl}/admin/api/models`;
  const modelId = profile.modelAlias || profile.omlxModel || profile.id;

  try {
    const ids = await serverModelIds(profile.baseUrl);
    const match = ids.find((id) => id.toLowerCase() === modelId.toLowerCase());
    const targetId = match ?? modelId;

    const response = await fetch(`${adminUrl}/${encodeURIComponent(targetId)}/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30000),
    });

    if (response.ok) {
      return { unloaded: true, backend: "omlx", modelId: targetId };
    }

    const detail = await responseErrorDetail(response);

    if (response.status === 400 && /not loaded/i.test(detail)) {
      return { unloaded: true, backend: "omlx", modelId: targetId, reason: "model was not loaded" };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        unloaded: false,
        backend: "omlx",
        modelId: targetId,
        error: "oMLX admin authentication required. Enable skip_api_key_verification in oMLX settings, or unload manually from the admin panel.",
      };
    }

    return { unloaded: false, backend: "omlx", modelId: targetId, error: `HTTP ${response.status}: ${detail}` };
  } catch (err) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      return { unloaded: false, backend: "omlx", modelId, error: "Unload request timed out. The model may still be unloading in the background." };
    }
    return { unloaded: false, backend: "omlx", modelId, error: err.message };
  }
}

async function responseErrorDetail(response) {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    const body = JSON.parse(text);
    return body?.detail ?? body?.message ?? text;
  } catch {
    return text;
  }
}

export async function finalizeBenchmarkRun(runDirectory, runResult, speedMetrics, speedMetricsError = null) {
  const metadataPath = join(runDirectory, "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const now = new Date();
  const timestamp = now.toISOString();

  const kind = metadata.kind ?? "visual";
  const isDs = kind === "data-science";
  const requiredFile = isDs ? "analysis.ipynb" : "index.html";
  const requiredPath = join(runDirectory, requiredFile);

  const outputFiles = [];
  for (const candidate of [requiredFile, isDs ? "summary.json" : "preview.png", isDs ? "chart-distribution.png" : "preview.webm", "preview.mp4"]) {
    if (existsSync(join(runDirectory, candidate))) {
      outputFiles.push(candidate);
    }
  }

  const success = existsSync(requiredPath) && (await readFile(requiredPath, "utf8")).trim().length > 0;
  const hasTurns = runResult.agentTurns > 0;

  let failureReason = null;
  if (runResult.error) {
    failureReason = typeof runResult.error === "string" ? runResult.error : (runResult.error.message ?? "Unknown error");
  } else if (!hasTurns) {
    failureReason = "The model did not produce any response turns.";
  } else if (!success) {
    if (runResult.toolCalls === 0) {
      failureReason = `The model finished without writing the required output file (${requiredFile}). It may have returned the response as chat text instead of using the write tool.`;
    } else {
      failureReason = `The required output file (${requiredFile}) was missing or empty after the run.`;
    }
  }

  const failed = failureReason !== null;

  metadata.status = failed ? "failed" : "completed";
  metadata.updatedAt = timestamp;
  if (failed) {
    metadata.failedAt = timestamp;
  } else {
    metadata.completedAt = timestamp;
  }

  const totalTokens = runResult.promptTokens + runResult.completionTokens;

  metadata.runner.tokenMetrics = {
    reported: hasTurns,
    promptTokens: runResult.promptTokens,
    completionTokens: runResult.completionTokens,
    totalTokens,
  };

  metadata.runner.speedMetrics = speedMetrics;
  metadata.runner.metricSource = speedMetrics?.metricSource ?? null;
  metadata.runner.speedMetricsError = speedMetricsError ?? null;

  metadata.results = {
    wallClockMs: runResult.wallClockMs,
    agentTurns: runResult.agentTurns,
    toolCalls: runResult.toolCalls,
    toolResults: runResult.toolResults,
    success,
    outputFiles,
    perTurn: runResult.perTurn,
  };

  if (failureReason) {
    metadata.error = { message: failureReason, ...(typeof runResult.error === "object" && runResult.error?.stack ? { stack: runResult.error.stack } : {}) };
  } else if (runResult.error) {
    metadata.error = typeof runResult.error === "string"
      ? { message: runResult.error }
      : { message: runResult.error.message ?? "Unknown error", ...(runResult.error.stack ? { stack: runResult.error.stack } : {}) };
  }

  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
  return metadata;
}

function formatMetric(value, formatter) {
  if (value === null || value === undefined || !Number.isFinite(value)) return pc.dim("—");
  return formatter(value);
}

function formatMs(ms) {
  return formatMetric(ms, (n) => (n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`));
}

function formatNumber(n) {
  return formatMetric(n, (v) => v.toLocaleString());
}

function formatTokPerSec(n) {
  return formatMetric(n, (v) => `${v.toFixed(1)} tok/s`);
}

function formatPercent(n) {
  return formatMetric(n, (v) => `${(v * 100).toFixed(0)} %`);
}

export function renderBenchmarkSummary(metadata) {
  const { status, results, runner, error } = metadata;

  const agentRows = [
    ["Status", status === "completed" ? pc.green("completed") : pc.red(status ?? "failed")],
    ["Duration", formatMs(results?.wallClockMs)],
    ["Agent turns", formatNumber(results?.agentTurns)],
    ["Input tokens", formatNumber(runner?.tokenMetrics?.promptTokens)],
    ["Output tokens", formatNumber(runner?.tokenMetrics?.completionTokens)],
    ["Total tokens", formatNumber(runner?.tokenMetrics?.totalTokens)],
    ["Tool calls", formatNumber(results?.toolCalls)],
    ["Tool results", formatNumber(results?.toolResults)],
    ["Output files", (results?.outputFiles?.length ?? 0) > 0 ? results.outputFiles.join(", ") : pc.dim("—")],
  ];

  console.log("");
  console.log(renderSection("Benchmark Result", renderRows(agentRows)));

  if (status === "completed" && runner?.speedMetrics) {
    const speed = runner.speedMetrics;
    const speedRows = [
      ["Prefill tok/s", formatTokPerSec(speed.prefillTokensPerSecond)],
      ["Generation tok/s", formatTokPerSec(speed.generationTokensPerSecond)],
      ["TTFT", formatMs(speed.ttftMs)],
      ["Speculative decode", formatPercent(speed.speculativeDecodeAcceptance)],
      ["KV cache tokens", formatNumber(speed.kvCacheTokens)],
      ["Model load time", formatMs(speed.modelLoadMs)],
      ["Metric source", speed.metricSource ?? pc.dim("—")],
    ];
    console.log(renderSection("Speed Metrics", renderRows(speedRows)));
  } else if (error) {
    const wrappedError = wrapText(error.message ?? "Unknown error");
    console.log(renderSection("Error", pc.red(wrappedError)));
    if (error.message?.includes("write tool") || error.message?.includes("required output file")) {
      const tip = wrapText("Tip: This usually means the model returned the answer as chat text instead of writing the file. Try a model with stronger tool-use support, or run the prompt manually.", 64);
      console.log(pc.dim("\n" + tip));
    }
  }

  if (status === "completed" && !runner?.speedMetrics && runner?.speedMetricsError) {
    console.log(pc.dim(`\nSpeed metrics unavailable: ${runner.speedMetricsError}`));
  }
}

function wrapText(text, width = 64) {
  if (!text) return "";
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current.trim());
  return lines.join("\n");
}