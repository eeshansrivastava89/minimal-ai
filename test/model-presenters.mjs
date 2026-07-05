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
  it("shows NEEDS SETUP for new models", () => {
    const item = {
      type: "new",
      model: { label: "unsloth/Qwen3-27B", sizeBytes: 15e9, source: "lmstudio", format: "gguf" },
      label: "unsloth/Qwen3-27B",
      sizeBytes: 15e9,
      contextLength: 32768,
      quant: "Q4_K_S",
    };
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40 });
    assert.match(plain(opt), /NEEDS SETUP/);
    assert.match(plain(opt), /Q4_K_S/);
  });

  it("infers oMLX source for managed profiles without stored source", () => {
    const item = {
      type: "profile",
      profile: { id: "omlx-qwen", label: "Qwen oMLX", backend: "omlx", omlxModel: "Qwen3.6-27B", flags: {} },
      label: "Qwen oMLX",
      fileMissing: false,
      sizeBytes: null,
      contextLength: null,
      quant: null,
    };
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40 });
    assert.match(plain(opt), /READY\s+oMLX\s+oMLX/);
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
      quant: null,
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
      quant: "Q8_0",
    };
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40 });
    assert.match(plain(opt), /LM Studio/);
    assert.match(plain(opt), /11\.00\s*MB/);
    assert.match(plain(opt), /Q8_0/); // quant column
  });
});