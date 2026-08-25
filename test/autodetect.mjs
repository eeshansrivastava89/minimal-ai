import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeFlags,
  isUncustomizedSampler,
  GENERAL_SAMPLER_DEFAULTS,
  THINKING_SAMPLER_DEFAULTS,
} from "../src/autodetect.mjs";

describe("isUncustomizedSampler", () => {
  it("treats general defaults as uncustomized", () => {
    assert.equal(isUncustomizedSampler("temperature", GENERAL_SAMPLER_DEFAULTS.temperature), true);
    assert.equal(isUncustomizedSampler("topK", GENERAL_SAMPLER_DEFAULTS.topK), true);
    assert.equal(isUncustomizedSampler("repeatPenalty", GENERAL_SAMPLER_DEFAULTS.repeatPenalty), true);
  });

  it("treats thinking defaults as uncustomized (the other valid fresh state)", () => {
    assert.equal(isUncustomizedSampler("topK", THINKING_SAMPLER_DEFAULTS.topK), true);
    assert.equal(isUncustomizedSampler("presencePenalty", THINKING_SAMPLER_DEFAULTS.presencePenalty), true);
    assert.equal(isUncustomizedSampler("repeatPenalty", THINKING_SAMPLER_DEFAULTS.repeatPenalty), true);
  });

  it("treats a user-changed value as customized", () => {
    assert.equal(isUncustomizedSampler("temperature", 0.5), false);
    assert.equal(isUncustomizedSampler("topK", 99), false);
    assert.equal(isUncustomizedSampler("repeatPenalty", 1.3), false);
  });

  it("returns false for an unknown field (no default to compare against)", () => {
    assert.equal(isUncustomizedSampler("bogus", 123), false);
  });
});

describe("computeFlags uses the exported sampler defaults", () => {
  // Locks in that computeFlags seeds from GENERAL_SAMPLER_DEFAULTS (non-thinking)
  // and THINKING_SAMPLER_DEFAULTS (thinking) — so isUncustomizedSampler can
  // reliably detect a fresh-profile value. If someone bumps a default in one
  // place but not the other, these break.
  it("non-thinking profile gets general sampler defaults", () => {
    const caps = { thinking: false, mtp: false, contextLength: 8192, quant: "q8_0" };
    const { flags } = computeFlags(caps, "/m.gguf", null, null);
    assert.equal(flags.temperature, GENERAL_SAMPLER_DEFAULTS.temperature);
    assert.equal(flags.topP, GENERAL_SAMPLER_DEFAULTS.topP);
    assert.equal(flags.topK, GENERAL_SAMPLER_DEFAULTS.topK);
    assert.equal(flags.presencePenalty, GENERAL_SAMPLER_DEFAULTS.presencePenalty);
    assert.equal(flags.repeatPenalty, GENERAL_SAMPLER_DEFAULTS.repeatPenalty);
  });

  it("thinking profile gets thinking sampler defaults", () => {
    const caps = { thinking: true, mtp: false, contextLength: 8192, quant: "q8_0" };
    const { flags } = computeFlags(caps, "/m.gguf", null, null);
    assert.equal(flags.topK, THINKING_SAMPLER_DEFAULTS.topK);
    assert.equal(flags.presencePenalty, THINKING_SAMPLER_DEFAULTS.presencePenalty);
    assert.equal(flags.repeatPenalty, THINKING_SAMPLER_DEFAULTS.repeatPenalty);
    // temperature/topP are shared between the two default sets
    assert.equal(flags.temperature, THINKING_SAMPLER_DEFAULTS.temperature);
  });

  it("flagOverrides still win over the defaults", () => {
    const caps = { thinking: false, mtp: false, contextLength: 8192, quant: "q8_0" };
    const { flags } = computeFlags(caps, "/m.gguf", null, null, { temperature: 0.9 });
    assert.equal(flags.temperature, 0.9);
  });
});