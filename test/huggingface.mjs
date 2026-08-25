import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHfRef, resolveHfDownload, getHfGenerationConfig, extractRecommendedSamplers, listDrafterFiles, listGgufFiles } from "../src/huggingface.mjs";

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

describe("getHfGenerationConfig", () => {
  it("returns parsed JSON on a 200 response", async () => {
    const cfg = { temperature: 0.7, top_p: 0.9, top_k: 40 };
    const result = await getHfGenerationConfig("org/model", {
      fetchImpl: async () => ({ ok: true, json: async () => cfg }),
    });
    assert.deepEqual(result, cfg);
  });

  it("returns null on 404 (repo has no generation_config.json)", async () => {
    const result = await getHfGenerationConfig("org/model", {
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    assert.equal(result, null);
  });

  it("returns null on a network error (best-effort, never throws)", async () => {
    const result = await getHfGenerationConfig("org/model", {
      fetchImpl: async () => { throw new Error("network down"); },
    });
    assert.equal(result, null);
  });

  it("returns null on an unparseable body", async () => {
    const result = await getHfGenerationConfig("org/model", {
      fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("bad json"); } }),
    });
    assert.equal(result, null);
  });
});

describe("listDrafterFiles (#2)", () => {
  // listDrafterFiles and listGgufFiles use the same isDrafterFile rule on
  // opposite sides — together they partition a repo's GGUFs into drafters
  // and main models, so the drafter offer never re-offers a main model.
  const tree = [
    { type: "file", path: "gemma-4-E2B-it-Q4_K_M.gguf", size: 2_000_000_000, lfs: { size: 2_000_000_000 } },
    { type: "file", path: "gemma-4-E2B-it-Q8_0.gguf", size: 4_000_000_000, lfs: { size: 4_000_000_000 } },
    { type: "file", path: "MTP/gemma-4-E2B-it-Q8_0-MTP.gguf", size: 97_000_000, lfs: { size: 97_000_000 } },
    { type: "file", path: "mtp-ornith-9b-mtp-kl-Q8_0.gguf", size: 2_260_000_000, lfs: { size: 2_260_000_000 } },
    { type: "file", path: "mmproj.gguf", size: 600_000_000, lfs: { size: 600_000_000 } },
  ];
  const fetchImpl = async () => ({ ok: true, json: async () => tree });

  it("lists only drafter GGUFs (MTP/ subdir + mtp- prefix), sorted by size", async () => {
    const drafters = await listDrafterFiles("org/repo", { fetchImpl });
    assert.equal(drafters.length, 2);
    assert.equal(drafters[0].path, "MTP/gemma-4-E2B-it-Q8_0-MTP.gguf"); // smallest first
    assert.equal(drafters[1].path, "mtp-ornith-9b-mtp-kl-Q8_0.gguf");
  });

  it("is the complement of listGgufFiles (no overlap, no mmproj)", async () => {
    const [drafters, ggufs, mmprojs] = await Promise.all([
      listDrafterFiles("org/repo", { fetchImpl }),
      listGgufFiles("org/repo", { fetchImpl }),
      (async () => (await import("../src/huggingface.mjs")).listMmprojFiles("org/repo", { fetchImpl }))(),
    ]);
    const drafterPaths = new Set(drafters.map((d) => d.path));
    for (const g of ggufs) assert.ok(!drafterPaths.has(g.path), `main model ${g.path} leaked into drafter list`);
    for (const d of drafters) assert.ok(!d.path.includes("mmproj"), `mmproj leaked into drafter list`);
    assert.equal(mmprojs.length, 1); // sanity: mmproj detected separately
  });

  it("returns [] when the repo has no drafter files", async () => {
    const emptyTree = [
      { type: "file", path: "model-Q8_0.gguf", size: 1_000, lfs: { size: 1_000 } },
    ];
    const drafters = await listDrafterFiles("org/repo", {
      fetchImpl: async () => ({ ok: true, json: async () => emptyTree }),
    });
    assert.equal(drafters.length, 0);
  });
});

describe("extractRecommendedSamplers", () => {
  it("maps HF field names to flag names and keeps only finite values", () => {
    const rec = extractRecommendedSamplers({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      repetition_penalty: 1.1,
      presence_penalty: 0.0,
      min_p: 0.0,
      bos_token_id: 151643, // non-sampler fields ignored
    });
    assert.deepEqual(rec, {
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      repeatPenalty: 1.1,
      presencePenalty: 0.0,
      minP: 0.0,
    });
  });

  it("drops non-finite values (null/NaN/string)", () => {
    const rec = extractRecommendedSamplers({
      temperature: "warm",
      top_p: null,
      top_k: NaN,
      repetition_penalty: 1.1, // only this one is finite
    });
    assert.deepEqual(rec, { repeatPenalty: 1.1 });
  });

  it("returns null when no sampler fields are present", () => {
    assert.equal(extractRecommendedSamplers({ bos_token_id: 1, eos_token_id: 2 }), null);
  });

  it("returns null on a non-object input", () => {
    assert.equal(extractRecommendedSamplers(null), null);
    assert.equal(extractRecommendedSamplers(undefined), null);
    assert.equal(extractRecommendedSamplers("not an object"), null);
  });
});
