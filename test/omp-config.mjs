import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";

// Sandbox before importing modules that resolve homedir()/MINIMAL_DIR at load
// time — syncConfig writes ~/.omp/agent/models.yml, which must never be the
// real one.
const sandboxHome = await mkdtemp(join(tmpdir(), "minimal-ompcfg-home-"));
process.env.HOME = sandboxHome;
process.env.MINIMAL_DIR = join(sandboxHome, "minimal-data");
after(() => rm(sandboxHome, { recursive: true, force: true }));

const { ompHarness } = await import("../src/harness-omp.mjs");

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

async function readOmpConfig() {
  return YAML.parse(await readFile(join(sandboxHome, ".omp", "agent", "models.yml"), "utf8"));
}

describe("omp harness config", () => {
  it("writes a providers map omp can read, with reasoning for omlx models", async () => {
    await ompHarness.syncConfig(omlxProfile());
    const config = await readOmpConfig();

    const provider = config.providers.omlx;
    assert.equal(provider.baseUrl, "http://127.0.0.1:8000/v1");
    assert.equal(provider.api, "openai-completions");
    assert.equal(provider.compat.supportsReasoningEffort, true);

    const model = provider.models[0];
    assert.equal(model.id, "Youssofal--Qwen3.8-27B-MTPLX-Optimized-Speed");
    assert.equal(model.reasoning, true);
    assert.equal(model.contextWindow, 81920);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    // omp has no thinkingLevelMap / chatTemplateKwargs — those are Pi-only.
    assert.equal(model.thinkingLevelMap, undefined);
    assert.equal(model.compat, undefined);
  });

  it("marks llama.cpp models as non-reasoning; Ollama reasons via /v1 reasoning_effort", async () => {
    // Wire-verified 2026-08: llama.cpp ignores top-level reasoning_effort
    // (needs chat_template_kwargs, which omp cannot send) — advertising it
    // would show thinking controls that do nothing. Ollama's /v1 honors
    // reasoning_effort since 0.32.x (maps to internal think levels).
    const fakeGguf = join(sandboxHome, "fake-model.gguf");
    await writeFile(fakeGguf, "GGUF");
    await ompHarness.syncConfig(omlxProfile({
      providerId: "llama-cpp",
      backend: "llama-cpp",
      modelAlias: "unsloth/gemma-4-E2B-it-Q4_K_M",
      omlxModel: undefined,
      modelPath: fakeGguf,
      baseUrl: "http://127.0.0.1:8080/v1",
    }));
    await ompHarness.syncConfig(omlxProfile({
      providerId: "ollama",
      backend: "ollama",
      modelAlias: "qwen3.8:27b-mlx",
      omlxModel: undefined,
      ollamaModel: "qwen3.8:27b-mlx",
      baseUrl: "http://127.0.0.1:11434/v1",
    }));
    const config = await readOmpConfig();
    assert.equal(config.providers["llama-cpp"].models[0].reasoning, false);
    assert.equal(config.providers.ollama.models[0].reasoning, true);
    assert.equal(config.providers.ollama.compat.supportsReasoningEffort, true);
  });

  it("preserves providers it did not write", async () => {
    const configPath = join(sandboxHome, ".omp", "agent", "models.yml");
    await mkdir(join(sandboxHome, ".omp", "agent"), { recursive: true });
    await writeFile(configPath, YAML.stringify({
      providers: { "ollama-cloud": { baseUrl: "https://ollama.com/v1", apiKey: "secret", models: [{ id: "glm-5.2" }] } },
    }));
    await ompHarness.syncConfig(omlxProfile());
    const config = await readOmpConfig();
    assert.equal(config.providers["ollama-cloud"].apiKey, "secret");
    assert.ok(config.providers.omlx);
  });

  it("hasModel and removeModel round-trip", async () => {
    const profile = omlxProfile({ modelAlias: "roundtrip-model", omlxModel: "roundtrip-model" });
    assert.equal(await ompHarness.hasModel(profile), false);
    await ompHarness.syncConfig(profile);
    assert.equal(await ompHarness.hasModel(profile), true);
    const result = await ompHarness.removeModel(profile);
    assert.equal(result.cleaned, true);
    assert.equal(await ompHarness.hasModel(profile), false);
    // provider removed entirely when its last model goes away
    const config = await readOmpConfig();
    assert.equal(config.providers.omlx, undefined);
  });
});
