import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Sandbox before importing modules that resolve homedir()/MINIMAL_DIR at load
// time — syncPiConfig writes ~/.pi/agent/models.json, which must never be the
// real one.
const sandboxHome = await mkdtemp(join(tmpdir(), "minimal-picfg-home-"));
process.env.HOME = sandboxHome;
process.env.MINIMAL_DIR = join(sandboxHome, "minimal-data");
after(() => rm(sandboxHome, { recursive: true, force: true }));

const { piHarness } = await import("../src/harness-pi.mjs");
const syncPiConfig = (profile) => piHarness.syncConfig(profile);
const { detectOmlxVision } = await import("../src/mlx-discovery.mjs");

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
    // Qwen3.8's template accepts only low/medium/xhigh, so every Pi level maps
    // to one of those (high must never silently escalate to xhigh via oMLX
    // alias fallback; minimal/max must not fall to the xhigh template default).
    assert.deepEqual(model.thinkingLevelMap, {
      minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh",
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

  it("suppresses thinking controls for Ollama models", async () => {
    // Ollama's /v1 endpoint ignores every thinking field (curl-verified) —
    // advertising reasoning would show knobs that provably do nothing.
    await syncPiConfig({
      id: "qwen38-ollama",
      label: "Qwen3.8 27B (Ollama)",
      providerId: "ollama",
      backend: "ollama",
      modelAlias: "qwen3.8:27b-mlx",
      ollamaModel: "qwen3.8:27b-mlx",
      baseUrl: "http://127.0.0.1:11434/v1",
      flags: { ctxSize: 32768 },
    });
    const config = await readPiConfig();
    const model = config.providers.ollama.models[0];
    assert.equal(model.reasoning, undefined);
    assert.equal(model.thinkingLevelMap, undefined);
    assert.equal(model.compat, undefined);
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

  it("maps every qwen3.x Pi level to a value its template accepts (no silent xhigh)", async () => {
    // Qwen3.5/3.6/3.8 templates accept only low/medium/xhigh (xhigh default).
    // Pi "high" would 400 the template and oMLX would alias it to xhigh;
    // minimal/max would be omitted and fall to the xhigh default. Every level
    // must land where the user expects.
    await syncPiConfig(omlxProfile()); // label "Qwen3.8 27B"
    const config = await readPiConfig();
    const model = config.providers.omlx.models[0];
    assert.deepEqual(model.thinkingLevelMap, {
      minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh",
    });
  });

  it("keeps the standard thinking map for non-qwen3.x families", async () => {
    await syncPiConfig(omlxProfile({
      id: "gemma426",
      label: "Gemma 4 26B",
      modelAlias: "gemma-4-26b-a4b-it",
      omlxModel: "gemma-4-26b-a4b-it",
    }));
    const config = await readPiConfig();
    const model = config.providers.omlx.models[0];
    assert.deepEqual(model.thinkingLevelMap, {
      minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null,
    });
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

  it("marks vision-capable managed models as image input", async () => {
    await syncPiConfig(omlxProfile({ capabilities: { thinking: true, vision: true } }));
    const config = await readPiConfig();
    const model = config.providers.omlx.models[0];
    assert.deepEqual(model.input, ["text", "image"]);
  });

  it("defaults managed models to text-only input", async () => {
    await syncPiConfig(omlxProfile());
    const config = await readPiConfig();
    const model = config.providers.omlx.models[0];
    assert.deepEqual(model.input, ["text"]);
  });
});

describe("detectOmlxVision", () => {
  it("detects vision_config in the model's config.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minimal-mlx-vision-"));
    after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "config.json"), JSON.stringify({ model_type: "qwen3_5", vision_config: { depth: 24 } }));
    assert.equal(await detectOmlxVision(dir), true);
  });

  it("returns false for text-only models and missing config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minimal-mlx-novision-"));
    after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "config.json"), JSON.stringify({ model_type: "qwen3_5" }));
    assert.equal(await detectOmlxVision(dir), false);
    assert.equal(await detectOmlxVision(join(dir, "does-not-exist")), false);
  });
});
