import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHfRef, resolveHfDownload } from "../src/huggingface.mjs";

describe("huggingface download helpers", () => {
  it("parses a repo ID", () => {
    const ref = parseHfRef("mlx-community/gemma-4-e2b-it-4bit");
    assert.equal(ref.repo, "mlx-community/gemma-4-e2b-it-4bit");
    assert.equal(ref.filename, undefined);
  });

  it("parses a repo/filename reference", () => {
    const ref = parseHfRef("unsloth/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_S.gguf");
    assert.equal(ref.repo, "unsloth/gemma-4-E2B-it-GGUF");
    assert.equal(ref.filename, "gemma-4-E2B-it-Q4_K_S.gguf");
  });

  it("parses a HuggingFace URL", () => {
    const ref = parseHfRef("https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_S.gguf");
    assert.equal(ref.repo, "unsloth/gemma-4-E2B-it-GGUF");
    assert.equal(ref.filename, "gemma-4-E2B-it-Q4_K_S.gguf");
  });

  it("rejects an invalid reference", () => {
    assert.throws(() => parseHfRef("not-a-repo"), /Invalid HuggingFace reference/);
  });

  it("resolves a GGUF download plan", async () => {
    const fakeTree = [
      { type: "file", path: "gemma-4-E2B-it-Q4_K_S.gguf", size: 3043900000, lfs: { size: 3043900000, oid: "sha256:abc" } },
    ];
    const plan = await resolveHfDownload("unsloth/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_S.gguf", {
      fetchImpl: async () => ({ ok: true, json: async () => fakeTree }),
    });
    assert.equal(plan.format, "gguf");
    assert.equal(plan.files.length, 1);
    assert.equal(plan.files[0].filename, "gemma-4-E2B-it-Q4_K_S.gguf");
    assert.equal(plan.totalSizeBytes, 3043900000);
  });

  it("resolves an MLX repo when no GGUF is present", async () => {
    const fakeTree = [
      { type: "file", path: "config.json", size: 1000 },
      { type: "file", path: "model.safetensors", size: 1000000, lfs: { size: 1000000, oid: "sha256:def" } },
    ];
    const plan = await resolveHfDownload("mlx-community/test-mlx", {
      fetchImpl: async () => ({ ok: true, json: async () => fakeTree }),
    });
    assert.equal(plan.format, "mlx");
    assert.equal(plan.files.length, 2);
  });
});
