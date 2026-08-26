import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSync, closeSync, ftruncateSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

const dataDir = await mkdtemp(join(tmpdir(), "minimal-presenters-"));
process.env.MINIMAL_DIR = dataDir;

const { modelSelectOption, modelNameWidth, discoverySourceForItem } = await import("../src/model-presenters.mjs");

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
  it("new models show name · backend, quant, ctx, and size on one row", () => {
    const item = {
      type: "new",
      model: { label: "unsloth/Qwen3-27B", sizeBytes: 15e9, source: "lmstudio", format: "gguf" },
      label: "unsloth/Qwen3-27B",
      sizeBytes: 15e9,
      contextLength: 32768,
      quant: "Q4_K_S",
    };
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40 });
    assert.match(plain(opt), /unsloth\/Qwen3-27B · llama\.cpp/);
    assert.match(plain(opt), /Q4_K_S/);
    assert.match(plain(opt), /32k/);
  });

  it("infers oMLX as the discovery source for managed profiles without stored source", () => {
    const item = {
      type: "profile",
      profile: { id: "omlx-qwen", label: "Qwen oMLX", backend: "omlx", omlxModel: "Qwen3.6-27B", flags: {} },
      label: "Qwen oMLX",
      fileMissing: false,
      sizeBytes: null,
      contextLength: null,
      quant: null,
    };
    assert.equal(discoverySourceForItem(item), "omlx");
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
    assert.equal(discoverySourceForItem(item), "lmstudio");
    const opt = modelSelectOption(item, { runningProfilesNow: [], modelMissingIds: new Set(), nameWidth: 40 });
    assert.match(plain(opt), /11\.00\s*MB/);
    assert.match(plain(opt), /Q8_0/); // quant column
  });
});

describe("modelNameWidth", () => {
  it("never exceeds the terminal width minus the other picker columns", () => {
    const longName = "org/" + "x".repeat(200) + "-Q4_K_S.gguf";
    const items = [{ type: "new", label: longName, model: { label: longName } }];
    const width = modelNameWidth(items);
    // maxWidth() is 80 in the non-TTY test env; columns beyond the name take
    // ~39, so the name column must stay within 41.
    assert.ok(width <= 80 - 39, `nameWidth ${width} overflows an 80-col terminal`);
  });
});

