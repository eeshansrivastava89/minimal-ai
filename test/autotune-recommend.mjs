import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Sandbox a run dir for writeOptimalJson.
const sandbox = await mkdtemp(join(tmpdir(), "minimal-autotune-recommend-"));
after(() => rm(sandbox, { recursive: true, force: true }));

const { recommendOptimal, writeOptimalJson, compareReal, resultsFromJournal, isThinkingOn } = await import("../src/autotune/recommend.mjs");

// Helpers to build a result shape like sweepConfig returns.
function result(configId, label, median, { mad = 0.1, family = "speculative", acceptPct = null, settings = {} } = {}) {
  const mtp = acceptPct != null ? { acceptPct, tokPerCycle: 1.8, accepted: 76, total: 102 } : null;
  return {
    configId,
    label,
    family,
    settings,
    summary: { n: 4, median, mad, min: median - 0.1, max: median + 0.1, spread: 0.2, noiseRatio: mad / median, mtp },
  };
}

describe("recommendOptimal", () => {
  it("picks the highest-tps thinking-off config as the fast path", () => {
    const results = [
      result("vanilla", "vanilla", 10.1),
      result("mtp", "MTP on", 11.8, { acceptPct: 74.5 }),
      result("thinking", "thinking + budget", 9.5, { family: "thinking" }),
    ];
    const rec = recommendOptimal(results);
    assert.equal(rec.ok, true);
    assert.equal(rec.fastPath.configId, "mtp");
    assert.equal(rec.recommendation.configId, "mtp");
  });

  it("picks the highest-tps thinking-on config as the beauty path", () => {
    const results = [
      result("vanilla", "vanilla", 10.1),
      result("mtp-thinking", "MTP + thinking + budget", 9.0, { family: "thinking", acceptPct: 70 }),
      result("thinking", "thinking + budget", 8.5, { family: "thinking" }),
    ];
    const rec = recommendOptimal(results);
    assert.equal(rec.beautyPath.configId, "mtp-thinking");
  });

  it("reasoning cites tps, the delta vs vanilla, and the beauty path", () => {
    const results = [
      result("vanilla", "vanilla", 10.1),
      result("mtp", "MTP on", 11.8, { acceptPct: 74.5 }),
      result("mtp-thinking", "MTP + thinking + budget", 9.5, { family: "thinking" }),
    ];
    const rec = recommendOptimal(results);
    assert.match(rec.reasoning, /MTP on — 11\.8 tps/);
    assert.match(rec.reasoning, /\+17% vs vanilla/);
    assert.match(rec.reasoning, /Beauty path: MTP \+ thinking/);
  });

  it("falls back to the beauty path when no thinking-off config succeeded", () => {
    const results = [result("thinking", "thinking + budget", 9.5, { family: "thinking" })];
    const rec = recommendOptimal(results);
    assert.equal(rec.ok, true);
    assert.equal(rec.fastPath, null);
    assert.equal(rec.recommendation.configId, "thinking");
  });

  it("returns no-results when nothing has a median", () => {
    const rec = recommendOptimal([{ configId: "vanilla", summary: { median: null } }]);
    assert.equal(rec.ok, false);
    assert.equal(rec.reason, "no-results");
  });

  it("does not recommend a tie: fast path within noise of vanilla → noChange, recommend vanilla", () => {
    // Fast path (mtp) is only +0.3 tps over vanilla, inside 2× MAD (1.0) →
    // not a real improvement. The recommender must not dress up the tie as a win.
    const results = [
      result("vanilla", "vanilla", 10.1, { mad: 1.0 }),
      result("mtp", "MTP on", 10.4, { mad: 1.0, acceptPct: 74.5 }),
    ];
    const rec = recommendOptimal(results);
    assert.equal(rec.ok, true);
    assert.equal(rec.noChange, true);
    assert.equal(rec.recommendation.configId, "vanilla");
    assert.equal(rec.fastPath.configId, "mtp");
    assert.match(rec.reasoning, /No config beat the clean baseline/);
  });

  it("flags the beauty path as within-noise of the fast path in the reasoning", () => {
    // Reproduces the 3.x confusion: beauty path (thinking on) has higher raw
    // tps but is within its own noise of the fast path, and counts thinking
    // tokens. The reasoning must explain why the fast path is still the pick.
    const results = [
      result("vanilla", "vanilla", 56.0, { mad: 0.25 }),
      result("ane", "ANE prefill", 57.45, { mad: 0.05, settings: { qwen35_ane_prefill_enabled: true } }),
      result("thinking", "thinking + budget", 58.1, { mad: 0.7, family: "thinking", settings: { enable_thinking: true } }),
    ];
    const rec = recommendOptimal(results);
    assert.equal(rec.ok, true);
    assert.equal(rec.recommendation.configId, "ane");
    assert.match(rec.reasoning, /within noise of the fast path/);
    assert.match(rec.reasoning, /counts thinking tokens/);
  });

  it("explains when the beauty path's raw tps outranks the fast path but still loses wall-clock", () => {
    // The 9B MTPLX case: MTP+thinking measured 47.6 tps vs MTP-on 38.8 — the
    // beauty path's rate is really higher, yet thinking tokens make it the
    // slower experience. Reasoning must say why the fast path is still the pick.
    const results = [
      result("vanilla", "vanilla", 31.6, { mad: 1.0 }),
      result("mtp", "MTP on", 38.8, { mad: 0.5, settings: { mtp_enabled: true } }),
      result("mtp-thinking", "MTP + thinking + budget", 47.6, { family: "thinking", mad: 0.5, settings: { mtp_enabled: true, enable_thinking: true } }),
    ];
    const rec = recommendOptimal(results);
    assert.equal(rec.ok, true);
    assert.equal(rec.recommendation.configId, "mtp");
    assert.equal(rec.noChange, false);
    assert.match(rec.reasoning, /counts thinking tokens/);
    assert.match(rec.reasoning, /quality alternative, not a speed win/);
    assert.match(rec.reasoning, /Beauty path: MTP \+ thinking \+ budget/);
  });
});

describe("isThinkingOn", () => {
  it("flags thinking and mtp-thinking configs", () => {
    assert.equal(isThinkingOn({ configId: "thinking" }), true);
    assert.equal(isThinkingOn({ configId: "mtp-thinking" }), true);
    assert.equal(isThinkingOn({ configId: "vanilla" }), false);
    assert.equal(isThinkingOn({ configId: "mtp" }), false);
    assert.equal(isThinkingOn({ configId: "ane" }), false);
  });
});

describe("compareReal", () => {
  it("flags a difference ≥ 2× noise as real", () => {
    const a = result("vanilla", "vanilla", 10.1, { mad: 0.1 });
    const b = result("mtp", "MTP on", 11.8, { mad: 0.1 });
    // |11.8 - 10.1| = 1.7 >= 2 * 0.1 = 0.2 -> real
    assert.equal(compareReal(a, b), "real");
  });

  it("flags a difference inside 2× noise as noise", () => {
    const a = result("vanilla", "vanilla", 10.1, { mad: 1.0 });
    const b = result("mtp", "MTP on", 10.4, { mad: 1.0 });
    // |10.4 - 10.1| = 0.3 < 2 * 1.0 = 2.0 -> noise
    assert.equal(compareReal(a, b), "noise");
  });

  it("returns n/a when a median is missing", () => {
    assert.equal(compareReal({ summary: { median: null, mad: 0 } }, result("mtp", "MTP on", 11.8)), "n/a");
  });
});

describe("resultsFromJournal", () => {
  it("joins journal summaries with grid settings/family", () => {
    const journal = [
      { event: "config-done", configId: "mtp", label: "MTP on", summary: { median: 11.8, mad: 0.1, mtp: { acceptPct: 74.5 } } },
      { event: "start", configId: "ignored" },
      { event: "config-done", configId: "vanilla", label: "vanilla", summary: { median: 10.1, mad: 0.1, mtp: null } },
    ];
    const grid = [
      { id: "mtp", family: "speculative", settings: { mtp_enabled: true } },
      { id: "vanilla", family: "baseline", settings: {} },
      { id: "dflash", family: "speculative", settings: { dflash_enabled: true } },
    ];
    const results = resultsFromJournal(journal, grid);
    assert.equal(results.length, 2);
    const mtp = results.find((r) => r.configId === "mtp");
    assert.equal(mtp.family, "speculative");
    assert.deepEqual(mtp.settings, { mtp_enabled: true });
    assert.equal(mtp.summary.median, 11.8);
  });
});

describe("writeOptimalJson", () => {
  it("writes a payload with the recommendation, both paths, and reasoning", async () => {
    const results = [
      result("vanilla", "vanilla", 10.1, { family: "baseline" }),
      result("mtp", "MTP on", 11.8, { acceptPct: 74.5, settings: { mtp_enabled: true } }),
      result("mtp-thinking", "MTP + thinking + budget", 9.5, { family: "thinking", settings: { mtp_enabled: true, enable_thinking: true } }),
    ];
    const rec = recommendOptimal(results);
    const payload = await writeOptimalJson(sandbox, rec);
    assert.equal(payload.recommended.configId, "mtp");
    assert.equal(payload.fastPath.configId, "mtp");
    assert.equal(payload.beautyPath.configId, "mtp-thinking");
    assert.match(payload.reasoning, /MTP on/);

    const onDisk = JSON.parse(await readFile(join(sandbox, "optimal.json"), "utf8"));
    assert.equal(onDisk.recommended.settings.mtp_enabled, true);
    assert.equal(onDisk.beautyPath.configId, "mtp-thinking");
  });
});