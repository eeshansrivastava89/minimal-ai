import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { openSync, closeSync, ftruncateSync } from "node:fs";

function createSparseFile(path, size) {
  const dir = join(path, "..");
  return mkdir(dir, { recursive: true }).then(() => {
    const fd = openSync(path, "w");
    ftruncateSync(fd, size);
    closeSync(fd);
  });
}

const dataDir = await mkdtemp(join(tmpdir(), "offgrid-scan-"));
process.env.OFFGRID_DIR = dataDir;

const { scanGgufModels, isEmbeddingArchitecture } = await import("../src/scan.mjs");

describe("scanGgufModels", () => {
  it("sets source label from scan directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scan-src-"));
    const file = join(dir, "model.gguf");
    await createSparseFile(file, 11 * 1024 * 1024);
    const { models } = await scanGgufModels([dir]);
    assert.equal(models.length, 1);
    assert.equal(models[0].source, basename(dir));
  });

  it("skips embedding models by filename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scan-embed-"));
    await createSparseFile(join(dir, "bge-small-en-v1.5.gguf"), 11 * 1024 * 1024);
    await createSparseFile(join(dir, "regular-model.gguf"), 11 * 1024 * 1024);
    const { models } = await scanGgufModels([dir]);
    assert.equal(models.length, 1);
    assert.ok(models[0].path.includes("regular-model.gguf"));
  });

  it("skips tiny GGUF files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scan-tiny-"));
    await createSparseFile(join(dir, "tiny-model.gguf"), 1024);
    const { models } = await scanGgufModels([dir]);
    assert.equal(models.length, 0);
  });
});

describe("isEmbeddingArchitecture", () => {
  it("detects BGE and Jina embeddings", () => {
    assert.equal(isEmbeddingArchitecture("bert", "bge-small.gguf"), true);
    assert.equal(isEmbeddingArchitecture(null, "jina-embeddings-v2.gguf"), true);
    assert.equal(isEmbeddingArchitecture("llama", "qwen.gguf"), false);
  });
});
