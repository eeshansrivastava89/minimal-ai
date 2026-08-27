import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { samplerDefault, lowBitKvWarning, LONG_CONTEXT_KV_THRESHOLD } from "../src/profile-setup/index.mjs";

// These tests cover the pure seeding/threshold logic behind #17/#18 without
// driving the interactive prompt UI (which has no stdin-mocking harness).
// The interactive flow itself remains an honest coverage gap.

describe("samplerDefault (model-card seeding rule)", () => {
  const rec = { temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.05 };

  it("seeds the recommendation when the saved value is still a fresh default", () => {
    const fresh = { flags: { temperature: 0.6, topK: 20 } };
    assert.equal(samplerDefault(fresh, "temperature", rec), 0.7);
    assert.equal(samplerDefault(fresh, "topK", rec), 40);
  });

  it("preserves a user-customized value (never silently overridden)", () => {
    const custom = { flags: { temperature: 0.5, topK: 20 } };
    assert.equal(samplerDefault(custom, "temperature", rec), 0.5);
    // untouched field still seeds
    assert.equal(samplerDefault(custom, "topK", rec), 40);
  });

  it("treats thinking-default topK (64) as uncustomized and seeds it", () => {
    const thinking = { flags: { topK: 64 } };
    assert.equal(samplerDefault(thinking, "topK", rec), 40);
  });

  it("falls back to the saved value when there is no recommendation", () => {
    const fresh = { flags: { temperature: 0.6 } };
    assert.equal(samplerDefault(fresh, "temperature", null), 0.6);
  });

  it("falls back to the saved value when the recommendation omits the field", () => {
    const fresh = { flags: { minP: 0 } };
    assert.equal(samplerDefault(fresh, "minP", rec), 0);
  });

  it("falls back to the saved value when recommendation is undefined", () => {
    const fresh = { flags: { temperature: 0.6 } };
    assert.equal(samplerDefault(fresh, "temperature", undefined), 0.6);
  });
});

describe("lowBitKvWarning (KV-cache fidelity guardrail #18)", () => {
  it("warns above the 32K threshold", () => {
    assert.equal(lowBitKvWarning(32769), true);
    assert.equal(lowBitKvWarning(65536), true);
    assert.equal(lowBitKvWarning(131072), true);
  });

  it("does not warn at or below the 32K threshold", () => {
    assert.equal(lowBitKvWarning(32768), false);
    assert.equal(lowBitKvWarning(32767), false);
    assert.equal(lowBitKvWarning(8192), false);
    assert.equal(lowBitKvWarning(4096), false);
  });

  it("the threshold is exactly 32768", () => {
    assert.equal(LONG_CONTEXT_KV_THRESHOLD, 32768);
  });
});