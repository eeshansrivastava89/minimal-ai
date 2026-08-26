import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  parseChatCompletionLine,
  parseMtpLine,
  extractMeasurement,
  median,
  mad,
  summarizeSamples,
  BENCHMARK_PROMPT,
} = await import("../src/autotune/sweep.mjs");

// ── Real captured log lines (2026-08-26, oMLX 0.6.3rc3) ─────────────────────

const REAL_CHAT_LINE =
  "2026-08-25 20:19:42,258 - omlx.server - INFO - [-] - Chat completion: model=Qwen3.5-4B-OptiQ-4bit, 40 tokens in 1.08s (37.1 tok/s), prompt: 36, finish_reason=length, max_tokens=40, request_max_tokens=40";

const REAL_MTP_LINE =
  "2026-08-25 20:20:11,233 - omlx.patches.mlx_lm_mtp.batch_generator - INFO - [-] - MTP[0] finish=length tokens=40 cycles=16 tok/cycle=2.50 accept=22/25 (88.0%) depth[d1=11/13,d2=9/10,d3=2/2] d0=3 emits[init=2,draft=22,bonus=13,verify=3] timing[backbone=1973.2ms mtp=13.7ms sample=0.5ms cache=1.2ms]";

const REAL_MTP_CHAT_LINE =
  "2026-08-25 20:20:11,260 - omlx.server - INFO - [-] - Chat completion: model=Qwen3.8-27B-MTPLX-Optimized-Speed, 40 tokens in 6.61s (6.1 tok/s), prompt: 78, finish_reason=length, max_tokens=40, request_max_tokens=40";

describe("parseChatCompletionLine", () => {
  it("parses the real captured format", () => {
    const r = parseChatCompletionLine(REAL_CHAT_LINE);
    assert.deepEqual(r, {
      model: "Qwen3.5-4B-OptiQ-4bit",
      tokens: 40,
      seconds: 1.08,
      tps: 37.1,
      promptTokens: 36,
      finishReason: "length",
    });
  });

  it("parses without a finish_reason field", () => {
    const r = parseChatCompletionLine(
      "Chat completion: model=X-4bit, 170 tokens in 17.0s (10.0 tok/s), prompt: 42",
    );
    assert.equal(r.model, "X-4bit");
    assert.equal(r.tokens, 170);
    assert.equal(r.tps, 10.0);
    assert.equal(r.promptTokens, 42);
    assert.equal(r.finishReason, null);
  });

  it("returns null for non-completion lines", () => {
    assert.equal(parseChatCompletionLine("Loading model: X"), null);
    assert.equal(parseChatCompletionLine(""), null);
    assert.equal(parseChatCompletionLine(null), null);
  });
});

describe("parseMtpLine", () => {
  it("parses the real captured MTP stats", () => {
    const r = parseMtpLine(REAL_MTP_LINE);
    assert.deepEqual(r, {
      tokens: 40,
      cycles: 16,
      tokPerCycle: 2.5,
      accepted: 22,
      total: 25,
      acceptPct: 88.0,
    });
  });

  it("returns null for non-MTP lines", () => {
    assert.equal(parseMtpLine(REAL_CHAT_LINE), null);
    assert.equal(parseMtpLine("MTP path activated for uid=0"), null);
  });
});

describe("extractMeasurement", () => {
  it("pairs the last completion with the last MTP line", () => {
    const block = [REAL_MTP_LINE, REAL_MTP_CHAT_LINE].join("\n");
    const m = extractMeasurement(block);
    assert.equal(m.model, "Qwen3.8-27B-MTPLX-Optimized-Speed");
    assert.equal(m.tps, 6.1);
    assert.equal(m.mtp.acceptPct, 88.0);
    assert.equal(m.mtp.tokPerCycle, 2.5);
  });

  it("returns a measurement with null mtp when no MTP line is present", () => {
    const m = extractMeasurement(REAL_CHAT_LINE);
    assert.equal(m.tps, 37.1);
    assert.equal(m.mtp, null);
  });

  it("returns null when no completion line is present", () => {
    assert.equal(extractMeasurement(REAL_MTP_LINE), null);
    assert.equal(extractMeasurement(""), null);
  });

  it("takes the last completion when several appear", () => {
    const block = [REAL_CHAT_LINE, REAL_MTP_CHAT_LINE].join("\n");
    const m = extractMeasurement(block);
    assert.equal(m.model, "Qwen3.8-27B-MTPLX-Optimized-Speed");
  });
});

describe("median + mad", () => {
  it("median of an odd set is the middle", () => {
    assert.equal(median([10.1, 11.8, 7.4]), 10.1);
  });

  it("median of an even set is the mean of the two middles", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  it("mad measures spread around the median", () => {
    // samples 9, 10, 11 -> median 10, deviations 1,0,1 -> mad 1
    assert.equal(mad([9, 10, 11]), 1);
  });

  it("mad of a single sample is 0", () => {
    assert.equal(mad([10]), 0);
  });
});

describe("summarizeSamples", () => {
  it("summarizes a tps sample set", () => {
    const s = summarizeSamples([10.0, 10.2, 10.1, 10.3]);
    assert.equal(s.n, 4);
    assert.ok(Math.abs(s.median - 10.15) < 1e-9);
    assert.equal(s.min, 10.0);
    assert.equal(s.max, 10.3);
    assert.ok(Math.abs(s.spread - 0.3) < 1e-9);
    assert.ok(s.mad >= 0);
    assert.ok(s.noiseRatio < 0.05);
  });

  it("returns an empty summary for no samples", () => {
    const s = summarizeSamples([]);
    assert.equal(s.n, 0);
    assert.equal(s.median, null);
    assert.equal(s.spread, 0);
  });
});

describe("benchmark prompt constant", () => {
  it("matches the reference doc's fixed prompt", () => {
    assert.match(BENCHMARK_PROMPT, /running AI locally.*privacy/i);
  });
});