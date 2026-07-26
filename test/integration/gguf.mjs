import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

import { detectCapabilities, computeFlags } from "../../src/autodetect.mjs";
import { createProfileFromModel } from "../../src/profiles.mjs";
import { scanGgufModels } from "../../src/scan.mjs";
import { estimateMemory } from "../../src/estimate.mjs";
import { backendFor } from "../../src/backends.mjs";

const MODEL_DIR = join(homedir(), ".lmstudio", "models");
const runIntegration = process.env.MINIMAL_INTEGRATION === "1" && existsSync(MODEL_DIR);

describe("GGUF model pipeline", { skip: !runIntegration }, () => {
  let models;

  it("scanGgufModels finds models", async () => {
    const result = await scanGgufModels();
    models = result.models;
    assert.ok(models.length > 0, "Expected at least one GGUF model");
  });

  it("detectCapabilities works on each model", () => {
    for (const model of models) {
      const caps = detectCapabilities(model.path, model.mmprojPath);
      assert.ok(caps, `detectCapabilities returned null for ${model.label}`);
      assert.ok(caps.architecture, `missing architecture for ${model.label}`);
      assert.ok(typeof caps.thinking === "boolean", `thinking not boolean for ${model.label}`);
      assert.ok(typeof caps.vision === "boolean", `vision not boolean for ${model.label}`);
      assert.ok(caps.quant, `missing quant for ${model.label}`);
    }
  });

  it("computeFlags produces valid argv for each model", () => {
    for (const model of models) {
      const caps = detectCapabilities(model.path, model.mmprojPath);
      const { flags, argv } = computeFlags(caps, model.path, model.mmprojPath, null);
      assert.ok(flags, `computeFlags returned null flags for ${model.label}`);
      assert.ok(argv.length > 0, `empty argv for ${model.label}`);
      assert.ok(flags.port, `missing port for ${model.label}`);
      assert.ok(flags.ctxSize > 0, `invalid ctxSize for ${model.label}`);
      assert.ok(argv.includes(model.path), `argv missing model path for ${model.label}`);
    }
  });

  it("estimateMemory returns a result for each model", () => {
    for (const model of models) {
      const caps = detectCapabilities(model.path, model.mmprojPath);
      const { flags } = computeFlags(caps, model.path, model.mmprojPath, null);
      const mem = estimateMemory(model.path, model.mmprojPath, null, flags);
      assert.ok(mem, `estimateMemory returned null for ${model.label}`);
      assert.ok(typeof mem.totalBytes === "number", `totalBytes not a number for ${model.label}`);
    }
  });

  it("createProfileFromModel works for each model", async () => {
    for (const model of models) {
      const profile = await createProfileFromModel(model);
      assert.ok(profile.id, `missing profile.id for ${model.label}`);
      assert.ok(profile.label, `missing profile.label for ${model.label}`);
      assert.ok(profile.backend, `missing profile.backend for ${model.label}`);
      assert.ok(profile.modelPath, `missing profile.modelPath for ${model.label}`);
      assert.ok(profile.baseUrl, `missing profile.baseUrl for ${model.label}`);
    }
  });

  it("backendFor works for each profile backend", async () => {
    for (const model of models) {
      const profile = await createProfileFromModel(model);
      const backend = backendFor(profile.backend);
      assert.ok(backend, `backendFor(${profile.backend}) returned null`);
      assert.equal(backend.id, profile.backend);
    }
  });
});
