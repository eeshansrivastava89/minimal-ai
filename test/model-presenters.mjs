import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSync, closeSync, ftruncateSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

const dataDir = await mkdtemp(join(tmpdir(), "offgrid-presenters-"));
process.env.OFFGRID_DIR = dataDir;

const { modelSelectOption } = await import("../src/model-presenters.mjs");

function plain(opt) {
  return stripVTControlCharacters(opt.label);
}

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
      sizeBytes: 3e9,
      contextLength: 131072,
    };
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40 });
    assert.match(plain(opt), /NEEDS SETUP\s+│\s+mlx-vlm\s+│\s+HuggingFace/);
    // SETUP items show size but not context window
    assert.match(plain(opt), /3e\+9|2\.79\s*GB/); // size is shown
    assert.doesNotMatch(plain(opt), /131k/); // context is not shown for SETUP
  });

  it("infers oMLX source for managed profiles without stored source", () => {
    const item = {
      type: "profile",
      profile: { id: "omlx-qwen", label: "Qwen oMLX", backend: "omlx", omlxModel: "Qwen3.6-27B", flags: {} },
      label: "Qwen oMLX",
      fileMissing: false,
      sizeBytes: null,
      contextLength: null,
    };
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40 });
    assert.match(plain(opt), /READY\s+│\s+oMLX\s+│\s+oMLX/);
    assert.doesNotMatch(plain(opt), /GGUF/);
  });

  it("displays pre-computed size for managed profiles", () => {
    const item = {
      type: "profile",
      profile: { id: "omlx-qwen", label: "Qwen oMLX", backend: "omlx", omlxModel: "Qwen3.6-27B", flags: {} },
      label: "Qwen oMLX",
      fileMissing: false,
      sizeBytes: 15e9,
      contextLength: null,
    };
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40 });
    assert.match(plain(opt), /13\.97\s*GB/);
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
      sizeBytes: 11 * 1024 * 1024,
      contextLength: null,
    };
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40 });
    assert.match(plain(opt), /LM Studio/);
    assert.match(plain(opt), /11\.00\s*MB/);
  });
});
