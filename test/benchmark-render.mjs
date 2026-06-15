import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slugModelId, createRunId, renderBenchmarkSummary } from "../src/benchmark.mjs";

describe("benchmark renderer", () => {
  it("slugModelId normalises and hashes long ids", () => {
    const short = slugModelId("gemma-3-4b-it");
    assert.equal(short, "gemma-3-4b-it");

    const long = slugModelId("some/extremely/long/model/name/that/exceeds/the/max/length/limit/by/quite/a/bit");
    assert.ok(long.length <= 91, `slug too long: ${long}`); // 80 + 1 + 10 hash
    assert.match(long, /-[\da-f]{10}$/u, "long slug ends with hash suffix");
  });

  it("slugModelId is deterministic", () => {
    const id = "Qwen3-4B-Instruct-GGUF";
    assert.equal(slugModelId(id), slugModelId(id));
  });

  it("createRunId produces ISO-8601-ish string", () => {
    const id = createRunId(new Date("2025-06-15T12:30:45.123Z"));
    assert.match(id, /^\d{4}-\d{2}-\d{2}T/u, "run id starts with date");
    assert.ok(!id.includes("."), "no dots in run id");
  });

  it("renderBenchmarkSummary shows completed run", () => {
    const metadata = {
      status: "completed",
      results: {
        wallClockMs: 45000,
        agentTurns: 3,
        toolCalls: 8,
        toolResults: 8,
        outputFiles: ["index.html", "preview.png"],
        perTurn: [],
      },
      runner: {
        tokenMetrics: {
          reported: true,
          promptTokens: 1200,
          completionTokens: 3400,
          totalTokens: 4600,
        },
        speedMetrics: {
          prefillTokensPerSecond: 150,
          generationTokensPerSecond: 45,
          ttftMs: 320,
          modelLoadMs: null,
          speculativeDecodeAcceptance: null,
          kvCacheTokens: 800,
          metricSource: "llama.cpp /v1/chat/completions timings",
        },
        metricSource: "llama.cpp /v1/chat/completions timings",
      },
      error: null,
    };

    // renderBenchmarkSummary writes to console; just ensure it doesn't throw.
    assert.doesNotThrow(() => renderBenchmarkSummary(metadata));
  });

  it("renderBenchmarkSummary shows failed run with error tip", () => {
    const metadata = {
      status: "failed",
      results: {
        wallClockMs: null,
        agentTurns: 0,
        toolCalls: 0,
        toolResults: 0,
        outputFiles: [],
        perTurn: [],
      },
      runner: {
        tokenMetrics: {
          reported: false,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
      },
      error: { message: "The required output file (index.html) was missing or empty after the run." },
    };

    assert.doesNotThrow(() => renderBenchmarkSummary(metadata));
  });

  it("renderBenchmarkSummary handles null speed metrics", () => {
    const metadata = {
      status: "completed",
      results: {
        wallClockMs: 10000,
        agentTurns: 1,
        toolCalls: 0,
        toolResults: 0,
        outputFiles: ["index.html"],
        perTurn: [],
      },
      runner: {
        tokenMetrics: {
          reported: true,
          promptTokens: 500,
          completionTokens: 1000,
          totalTokens: 1500,
        },
        speedMetrics: null,
        metricSource: null,
      },
      error: null,
    };

    assert.doesNotThrow(() => renderBenchmarkSummary(metadata));
  });
});