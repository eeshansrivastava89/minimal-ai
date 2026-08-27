import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSync, closeSync, ftruncateSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

const dataDir = await mkdtemp(join(tmpdir(), "minimal-presenters-"));
process.env.MINIMAL_DIR = dataDir;

const { modelRowOptions, discoverySourceForItem } = await import("../src/model-presenters.mjs");

function plain(opt) {
  return stripVTControlCharacters(opt.label);
}

function rowFor(items, item) {
  const options = modelRowOptions(items, { runningProfilesNow: [], modelMissingIds: new Set() });
  const entries = [...options.entries()];
  const idx = items.indexOf(item);
  return entries[idx][1];
}

function createSparseFile(path, size) {
  const dir = join(path, "..");
  return mkdir(dir, { recursive: true }).then(() => {
    const fd = openSync(path, "w");
    ftruncateSync(fd, size);
    closeSync(fd);
  });
}

const originalColumns = process.stdout.columns;
afterEach(() => {
  process.stdout.columns = originalColumns;
});

describe("modelRowOptions", () => {
  it("new models show name (backend lives in the group header), quant, ctx, and size on one row", () => {
    const item = {
      type: "new",
      model: { label: "unsloth/Qwen3-27B", path: "/tmp/q.gguf", sizeBytes: 15e9, source: "lmstudio", format: "gguf" },
      label: "unsloth/Qwen3-27B",
      sizeBytes: 15e9,
      contextLength: 32768,
      quant: "Q4_K_S",
    };
    const opt = rowFor([item], item);
    assert.match(plain(opt), /unsloth\/Qwen3-27B/);
    assert.doesNotMatch(plain(opt), /· llama\.cpp/); // backend is the group header's job
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
    const opt = rowFor([item], item);
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
    const opt = rowFor([item], item);
    assert.match(plain(opt), /11\.00\s*MB/);
    assert.match(plain(opt), /Q8_0/); // quant column
  });

  it("sheds columns on narrow terminals instead of truncating anything", () => {
    process.stdout.columns = 60;
    const items = [
      {
        type: "profile",
        profile: { id: "p1", label: "my-fine-model", backend: "llama-cpp", modelPath: "/tmp/a.gguf", flags: {} },
        label: "my-fine-model",
        fileMissing: false,
        sizeBytes: 15e9,
        contextLength: 131072,
        quant: "Q4_K_S",
      },
      {
        type: "new",
        model: { label: "org/a-very-long-model-name", path: "/tmp/b.gguf", sizeBytes: 9e9, source: "huggingface" },
        label: "org/a-very-long-model-name",
        sizeBytes: 9e9,
        contextLength: 262144,
        quant: "Q4_0",
      },
    ];
    const options = modelRowOptions(items, { runningProfilesNow: [], modelMissingIds: new Set() });
    for (const opt of options.values()) {
      const text = plain(opt);
      // Row fits the prompt frame (60 - 5 gutter) without any name truncation.
      assert.ok(text.length <= 55, `row too wide at 60 cols: ${text.length} (${text})`);
      assert.ok(!text.includes("…"), `must never ellipsize: ${text}`);
    }
    // The full names survived.
    const joined = [...options.values()].map(plain).join("\n");
    assert.match(joined, /my-fine-model/);
    assert.match(joined, /org\/a-very-long-model-name/);
  });

  it("never truncates a name even when it alone exceeds the window", () => {
    process.stdout.columns = 40;
    const longName = "org/" + "x".repeat(200) + "-Q4_K_S.gguf";
    const items = [{ type: "new", label: longName, model: { path: "/tmp/c.gguf", label: longName, source: "huggingface" } }];
    const options = modelRowOptions(items, { runningProfilesNow: [], modelMissingIds: new Set() });
    const text = plain(options.get("new:/tmp/c.gguf"));
    assert.ok(!text.includes("…"), `must never ellipsize: ${text.slice(0, 60)}…`);
    assert.ok(text.includes(longName)); // wraps, never cuts
  });
});
