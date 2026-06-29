import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = await mkdtemp(join(tmpdir(), "offgrid-profile-command-"));
process.env.OFFGRID_DIR = dataDir;

const { ensureDirs } = await import("../src/config.mjs");
const { commandJsonPath, readCommandArgv, saveProfile, createProfileFromMlxModel } = await import("../src/profiles.mjs");

describe("profile command files", () => {
  it("uses command.json argv as the local server source of truth", async () => {
    await ensureDirs();
    const profile = await saveProfile({
      id: "demo",
      label: "Demo",
      backend: "llama-cpp",
      providerId: "llama-cpp",
      modelAlias: "demo",
      flags: { host: "127.0.0.1", port: 8080 },
      commandArgv: ["--model", "/old/model.gguf"],
    });

    await writeFile(commandJsonPath(profile.id), JSON.stringify({ argv: ["--model", "/edited/model.gguf", "--ctx-size", 4096] }, null, 2));

    assert.deepEqual(await readCommandArgv(profile), ["--model", "/edited/model.gguf", "--ctx-size", "4096"]);
  });
});

describe("createProfileFromMlxModel", () => {
  it("uses the full model path as the API model id (modelAlias), not the label", async () => {
    // mlx-vlm registers the loaded model with the --model path as its API id.
    // Requests must send that exact path; sending the repo-id label makes
    // mlx-vlm unload the local model and re-fetch the repo from HuggingFace.
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
    assert.equal(profile.modelAlias, modelDir, "modelAlias must be the model path, not the label");
    assert.equal(profile.modelPath, modelDir);
    assert.equal(profile.modelSizeBytes, 1234);
    assert.ok(profile.commandArgv.includes("--model"), "commandArgv must include --model");
    assert.ok(profile.commandArgv.includes(modelDir), "commandArgv must pass the model path to --model");
  });
});
