import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSync, closeSync, ftruncateSync } from "node:fs";

const dataDir = await mkdtemp(join(tmpdir(), "offgrid-presenters-"));
process.env.OFFGRID_DIR = dataDir;

const { modelSelectOption } = await import("../src/model-presenters.mjs");

function createSparseFile(path, size) {
  const dir = join(path, "..");
  return mkdir(dir, { recursive: true }).then(() => {
    const fd = openSync(path, "w");
    ftruncateSync(fd, size);
    closeSync(fd);
  });
}

describe("modelSelectOption", () => {
  it("shows separate backend and source columns", () => {
    const item = {
      type: "new",
      model: { label: "mlx-community/gemma-4-e2b-it-4bit", sizeBytes: 3e9, source: "huggingface", format: "mlx" },
      label: "mlx-community/gemma-4-e2b-it-4bit",
    };
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40, managedModels: [] });
    assert.match(opt.label, /SETUP\s+│\s+mlx-vlm\s+│\s+HuggingFace/);
  });

  it("infers oMLX source for managed profiles without stored source", () => {
    const item = {
      type: "profile",
      profile: { id: "omlx-qwen", label: "Qwen oMLX", backend: "omlx", omlxModel: "Qwen3.6-27B", flags: {} },
      label: "Qwen oMLX",
      fileMissing: false,
    };
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40, managedModels: [] });
    assert.match(opt.label, /READY\s+│\s+oMLX\s+│\s+oMLX/);
    assert.doesNotMatch(opt.label, /GGUF/);
  });

  it("looks up managed profile size from managedModels", () => {
    const item = {
      type: "profile",
      profile: { id: "omlx-qwen", label: "Qwen oMLX", backend: "omlx", omlxModel: "Qwen3.6-27B", flags: {} },
      label: "Qwen oMLX",
      fileMissing: false,
    };
    const managedModels = [{ backendId: "omlx", models: [{ id: "Qwen3.6-27B", sizeBytes: 15e9, source: "omlx" }], status: "ok" }];
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40, managedModels });
    assert.match(opt.label, /13\.97\s*GB/);
  });

  it("infers source from model path for old GGUF profiles", async () => {
    const dir = join(tmpdir(), ".lmstudio", "models", "presenter-src");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "model.gguf");
    await createSparseFile(file, 11 * 1024 * 1024);
    const item = {
      type: "profile",
      profile: { id: "gguf-old", label: "Old model", backend: "llama-cpp", modelPath: file, source: "local-gguf", flags: {} },
      label: "Old model",
      fileMissing: false,
    };
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40, managedModels: [] });
    assert.match(opt.label, /LM Studio/);
    assert.match(opt.label, /11\.00\s*MB/);
  });
});
