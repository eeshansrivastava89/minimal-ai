import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Sandbox before importing modules that resolve homedir()/MINIMAL_DIR at load
// time — syncPiConfig writes ~/.pi/agent/models.json, which must never be the
// real one.
const sandboxHome = await mkdtemp(join(tmpdir(), "minimal-picfg-home-"));
process.env.HOME = sandboxHome;
process.env.MINIMAL_DIR = join(sandboxHome, "minimal-data");
after(() => rm(sandboxHome, { recursive: true, force: true }));

const { syncPiConfig } = await import("../src/harness-pi.mjs");

function omlxProfile(overrides = {}) {
  return {
    id: "qwen38",
    label: "Qwen3.8 27B",
    providerId: "omlx",
    backend: "omlx",
    modelAlias: "Youssofal--Qwen3.8-27B-MTPLX-Optimized-Speed",
    omlxModel: "Youssofal--Qwen3.8-27B-MTPLX-Optimized-Speed",
    baseUrl: "http://127.0.0.1:8000/v1",
    capabilities: { thinking: true },
    flags: { ctxSize: 81920 },
    ...overrides,
  };
}

async function readPiConfig() {
  return JSON.parse(await readFile(join(sandboxHome, ".pi", "agent", "models.json"), "utf8"));
}

describe("syncPiConfig thinking levels", () => {
  it("enables reasoning_effort and maps thinking levels for thinking-capable models", async () => {
    await syncPiConfig(omlxProfile());
    const config = await readPiConfig();

    const provider = config.providers.omlx;
    assert.equal(provider.compat.supportsReasoningEffort, true);
    assert.equal(provider.compat.supportsDeveloperRole, false);

    const model = provider.models.find((m) => m.id === "Youssofal--Qwen3.8-27B-MTPLX-Optimized-Speed");
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.thinkingLevelMap, {
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: null,
    });
    // Qwen-family models must carry the level through chat_template_kwargs —
    // the "qwen-chat-template" format drops it (regression: oMLX model stuck
    // at its xhigh template default regardless of the chosen level).
    assert.deepEqual(model.compat, {
      thinkingFormat: "chat-template",
      chatTemplateKwargs: {
        enable_thinking: { $var: "thinking.enabled" },
        reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
        preserve_thinking: true,
      },
    });
  });

  it("detects thinking by name for managed models without capabilities", async () => {
    // oMLX/Ollama profiles never get GGUF capability detection — the name
    // hint fallback must flag them so Pi shows thinking levels.
    const noCaps = omlxProfile();
    delete noCaps.capabilities;
    await syncPiConfig(noCaps);
    const config = await readPiConfig();
    const model = config.providers.omlx.models[0];
    assert.equal(model.reasoning, true);
    assert.ok(model.thinkingLevelMap);
  });

  it("omits reasoning fields for non-thinking models", async () => {
    await syncPiConfig(omlxProfile({
      capabilities: undefined,
      id: "llama32",
      label: "Llama 3.2 3B",
      modelAlias: "llama-3.2-3b",
      omlxModel: "llama-3.2-3b",
    }));
    const config = await readPiConfig();
    const model = config.providers.omlx.models[0];
    assert.equal(model.reasoning, undefined);
    assert.equal(model.thinkingLevelMap, undefined);
  });

  it("respects an explicit capabilities.thinking false over name hints", async () => {
    await syncPiConfig(omlxProfile({ capabilities: { thinking: false } }));
    const config = await readPiConfig();
    const model = config.providers.omlx.models[0];
    assert.equal(model.reasoning, undefined);
    assert.equal(model.thinkingLevelMap, undefined);
  });
});
