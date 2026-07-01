import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = await mkdtemp(join(tmpdir(), "offgrid-profile-command-"));
process.env.OFFGRID_DIR = dataDir;

const { ensureDirs } = await import("../src/config.mjs");
const { saveProfile, createProfileFromMlxModel } = await import("../src/profiles.mjs");
const { piApiModelId } = await import("../src/harness-pi.mjs");

describe("createProfileFromMlxModel", () => {
  it("keeps the friendly label as modelAlias; the API id is derived at serve time", async () => {
    const modelDir = await mkdtemp(join(tmpdir(), "offgrid-mlx-id-"));
    await writeFile(join(modelDir, "config.json"), JSON.stringify({
      model_type: "qwen3",
      architectures: ["Qwen3ForCausalLM"],
      max_position_embeddings: 32768,
    }));
    const model = { label: "org/test-mlx", filePath: modelDir, source: "huggingface", sizeBytes: 1234 };
    const profile = await createProfileFromMlxModel(model);
    assert.equal(profile.backend, "mlx-vlm");
    assert.equal(profile.label, "org/test-mlx");
    assert.equal(profile.modelAlias, "org/test-mlx", "modelAlias is the friendly label, not the path");
    assert.equal(profile.modelPath, modelDir);
    assert.equal(profile.modelSizeBytes, 1234);
    assert.ok(profile.commandArgv.includes("--model"), "commandArgv must include --model");
    assert.ok(profile.commandArgv.includes(modelDir), "commandArgv must pass the model path to --model");
    // The id Pi sends must be the model path (what mlx-vlm registers), not the label.
    assert.equal(piApiModelId(profile), modelDir, "piApiModelId must be the model path for mlx-vlm");
  });

  it("piApiModelId uses modelAlias for non-mlx-vlm backends", () => {
    assert.equal(piApiModelId({ backend: "llama-cpp", modelAlias: "friendly", modelPath: "/m.gguf" }), "friendly");
    assert.equal(piApiModelId({ backend: "omlx", modelAlias: "Qwen3-27B", modelPath: null }), "Qwen3-27B");
  });
});
