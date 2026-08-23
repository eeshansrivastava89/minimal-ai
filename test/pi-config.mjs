import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const { detectOmlxCapabilities } = await import("../src/capabilities.mjs");

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

  it("enables reasoning for Ollama models with an identity thinking map", async () => {
    // Ollama's /v1 honors reasoning_effort since 0.32.x and accepts every
    // Pi level verbatim (curl-verified 0.32.15). The identity map unlocks
    // xhigh/max in Pi's picker; no chat-template compat — /v1 ignores
    // chat_template_kwargs.
    await syncPiConfig({
      id: "qwen38-ollama",
      label: "Qwen3.8 27B (Ollama)",
      providerId: "ollama",
      backend: "ollama",
      modelAlias: "qwen3.8:27b-mlx",
      ollamaModel: "qwen3.8:27b-mlx",
      baseUrl: "http://127.0.0.1:11434/v1",
      capabilities: { thinking: true },
      flags: { ctxSize: 32768 },
    });
    const config = await readPiConfig();
    const provider = config.providers.ollama;
    assert.equal(provider.compat.supportsReasoningEffort, true);
    const model = provider.models[0];
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.thinkingLevelMap, {
      off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
    });
    assert.equal(model.compat, undefined);
  });

  it("suppresses thinking controls for Ollama models without stored facts", async () => {
    // Same rule as oMLX: the harness renders stored capability facts only.
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

  it("no name-hint fallback at harness sync — managed profiles need stored facts", async () => {
    // Issue #12: the harness renders stored capabilities only; the name-hint
    // regex lives in the detector (setup/reconfigure). A managed profile that
    // never stored thinking (pre-detector) shows no thinking controls until
    // Reconfigure refreshes its facts.
    const noCaps = omlxProfile();
    delete noCaps.capabilities;
    await syncPiConfig(noCaps);
    const config = await readPiConfig();
    const model = config.providers.omlx.models[0];
    assert.equal(model.reasoning, undefined);
    assert.equal(model.thinkingLevelMap, undefined);
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

describe("detectOmlxCapabilities", () => {
  async function makeOmlxModel(id, config) {
    const dir = join(sandboxHome, ".omlx", "models", "pub", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(config));
    await writeFile(join(dir, "model.safetensors"), "stub");
    return id;
  }

  it("detects vision_config in the model's config.json", async () => {
    const id = await makeOmlxModel("Vision-Model-4bit", { model_type: "qwen3_5", vision_config: { depth: 24 } });
    const facts = await detectOmlxCapabilities({ modelId: id });
    assert.equal(facts.vision, true);
    assert.equal(facts.architecture, "qwen3_5");
  });

  it("returns no vision for text-only models and falls back to name hints for thinking", async () => {
    const id = await makeOmlxModel("Qwen3.8-27B-4bit", { model_type: "qwen3_5" });
    const facts = await detectOmlxCapabilities({ modelId: id });
    assert.equal(facts.vision, false);
    assert.equal(facts.mtp, false);
    assert.equal(facts.thinking, true); // qwen3 name hint, last resort
  });

  it("detects MTP only when config, whitelist, and weights all agree", async () => {
    const id = await makeOmlxModel("MTP-Model-4bit", { model_type: "qwen3_5", mtp_num_hidden_layers: 1 });
    await writeFile(join(sandboxHome, ".omlx", "models", "pub", id, "model.safetensors.index.json"),
      JSON.stringify({ weight_map: { "mtp.0.weight": "model.safetensors" } }));
    const facts = await detectOmlxCapabilities({ modelId: id });
    assert.equal(facts.mtp, true);
  });

  it("flags DFlash draft checkpoints as drafters in the disk scan", async () => {
    const { scanOmlxModelSizes, lookupOmlxModelInfo } = await import("../src/mlx-discovery.mjs");
    await makeOmlxModel("Qwen3.8-27B-DFlash2", {
      model_type: "qwen3",
      architectures: ["DFlash2DraftModel"],
      dflash_config: { block_size: 8 },
    });
    const infoMap = await scanOmlxModelSizes();
    assert.equal(lookupOmlxModelInfo("Qwen3.8-27B-DFlash2", infoMap)?.drafter, true);
    assert.equal(lookupOmlxModelInfo("Vision-Model-4bit", infoMap)?.drafter, false);
  });
});

describe("readOmlxModelSettings", () => {
  it("reads per-model server settings from ~/.omlx/model_settings.json", async () => {
    const { readOmlxModelSettings } = await import("../src/mlx-discovery.mjs");
    await mkdir(join(sandboxHome, ".omlx"), { recursive: true });
    await writeFile(join(sandboxHome, ".omlx", "model_settings.json"), JSON.stringify({
      version: 1,
      models: {
        "Qwen3.8-27B-4bit": { dflash_enabled: true, thinking_budget_enabled: true, thinking_budget_tokens: 4096 },
        "Qwen3.6-35B-A3B-4bit": { dflash_enabled: false, thinking_budget_enabled: false },
      },
    }));
    const dflash = await readOmlxModelSettings("Qwen3.8-27B-4bit");
    assert.equal(dflash.dflash_enabled, true);
    assert.equal(dflash.thinking_budget_tokens, 4096);
    const plain = await readOmlxModelSettings("Qwen3.6-35B-A3B-4bit");
    assert.equal(plain.dflash_enabled, false);
  });

  it("matches by dir basename for org/name-style ids", async () => {
    const { readOmlxModelSettings } = await import("../src/mlx-discovery.mjs");
    const settings = await readOmlxModelSettings("mlx-community/Qwen3.8-27B-4bit");
    assert.equal(settings.dflash_enabled, true);
  });

  it("returns null for unknown models and a missing file", async () => {
    const { readOmlxModelSettings } = await import("../src/mlx-discovery.mjs");
    assert.equal(await readOmlxModelSettings("no-such-model"), null);
    await rm(join(sandboxHome, ".omlx", "model_settings.json"));
    assert.equal(await readOmlxModelSettings("Qwen3.8-27B-4bit"), null);
  });
});
