import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
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

const dataDir = await mkdtemp(join(tmpdir(), "minimal-scan-"));
process.env.MINIMAL_DIR = dataDir;

const { scanGgufModels, isEmbeddingArchitecture, drafterTargetHint } = await import("../src/scan.mjs");

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

describe("drafterTargetHint (#2 matcher)", () => {
  // The hint must strip quant tokens + MTP/assistant/draft markers so a
  // drafter and its main model reduce to the same base — for BOTH the
  // `mtp-`-prefix style (huihui) and the `-MTP`-suffix style (unsloth),
  // where the quant sits before the -MTP marker.
  it("matches an mtp- prefix drafter to its main (huihui style)", () => {
    assert.equal(drafterTargetHint("ornith-9b-mtp-kl-Q8_0"), "ornith-9b-mtp-kl");
    assert.equal(drafterTargetHint("mtp-ornith-9b-mtp-kl-Q8_0"), "ornith-9b-mtp-kl");
  });

  it("matches a -MTP suffix drafter to its main (unsloth style)", () => {
    // Quant is BEFORE the -MTP marker; suffix-only stripping used to leave
    // "gemma-4-e2b-it-q8_0" and fail to match. Global stripping fixes it.
    assert.equal(drafterTargetHint("gemma-4-E2B-it-Q8_0"), "gemma-4-e2b-it");
    assert.equal(drafterTargetHint("gemma-4-E2B-it-Q8_0-MTP"), "gemma-4-e2b-it");
  });

  it("does NOT collapse different model sizes together", () => {
    assert.notEqual(drafterTargetHint("gemma-4-12b-it-Q8_0"), drafterTargetHint("gemma-4-31b-it-Q8_0"));
  });

  it("strips K-quant, UD-quant, and F16/BF16 tokens", () => {
    assert.equal(drafterTargetHint("model-Q4_K_M"), "model");
    assert.equal(drafterTargetHint("model-UD-Q4_K_XL"), "model");
    assert.equal(drafterTargetHint("model-F16"), "model");
    assert.equal(drafterTargetHint("model-BF16"), "model");
  });

  it("strips a trailing .gguf extension defensively (callers may pass full paths)", () => {
    assert.equal(drafterTargetHint("gemma-4-E2B-it-Q8_0.gguf"), "gemma-4-e2b-it");
    assert.equal(drafterTargetHint("gemma-4-E2B-it-Q8_0-MTP.gguf"), "gemma-4-e2b-it");
    // Dir prefixes are preserved (callers pass basename, like matchDrafter does):
    assert.equal(drafterTargetHint("MTP/gemma-4-E2B-it-Q8_0-MTP.gguf"), "mtp/gemma-4-e2b-it");
  });
});
