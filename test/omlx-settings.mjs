import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.MINIMAL_DIR = await mkdtemp(join(tmpdir(), "minimal-omlx-settings-"));

const { desiredOmlxModelSettings } = await import("../src/managed-backends.mjs");

describe("desiredOmlxModelSettings (A4 — profile is source of truth)", () => {
  it("plain profile: MTP off, thinking on, budget disabled — explicit, never silent", () => {
    const settings = desiredOmlxModelSettings({ mtpEnabled: false });
    assert.deepEqual(settings, {
      mtp_enabled: false,
      enable_thinking: true,
      thinking_budget_enabled: false,
    });
  });

  it("thinkingOff maps to enable_thinking=false; budget round-trips", () => {
    const settings = desiredOmlxModelSettings({ thinkingOff: true, thinkingBudget: 4096 });
    assert.equal(settings.enable_thinking, false);
    assert.equal(settings.thinking_budget_enabled, true);
    assert.equal(settings.thinking_budget_tokens, 4096);
  });

  it("MTP choice comes from the profile field, with legacy capability fallback", () => {
    assert.equal(desiredOmlxModelSettings({ mtpEnabled: true }).mtp_enabled, true);
    assert.equal(desiredOmlxModelSettings({ mtpEnabled: false, capabilities: { mtp: true } }).mtp_enabled, false);
    // Legacy (pre-choice) profiles stored the answer in capabilities.mtp.
    assert.equal(desiredOmlxModelSettings({ capabilities: { mtp: true } }).mtp_enabled, true);
  });

  it("a removed budget produces thinking_budget_enabled=false (the old lifecycle writer could never disable it)", () => {
    const settings = desiredOmlxModelSettings({ thinkingOff: false });
    assert.equal(settings.enable_thinking, true); // re-enable reaches the server too
    assert.equal(settings.thinking_budget_enabled, false);
    assert.ok(!("thinking_budget_tokens" in settings));
  });
});
