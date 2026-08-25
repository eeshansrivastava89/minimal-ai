import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHfRef, resolveHfDownload, getHfGenerationConfig, extractRecommendedSamplers, listDrafterFiles, listGgufFiles, isValidRepoId, assertValidRepoId, isSafeRelativePath, assertSafeHfFilename, isMlxRepo } from "../src/huggingface.mjs";

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

describe("HF input validation (H1/M1/M2 security)", () => {
  describe("isValidRepoId / assertValidRepoId", () => {
    it("accepts a well-formed org/name", () => {
      assert.equal(isValidRepoId("unsloth/Qwen3-8B-GGUF"), true);
      assert.equal(isValidRepoId("mlx-community/Qwen3.8-27B-4bit"), true);
    });
    it("rejects flag-injection, traversal, and malformed repo IDs", () => {
      assert.equal(isValidRepoId("--foo/bar"), false);
      assert.equal(isValidRepoId("org/.."), false);
      assert.equal(isValidRepoId("../etc"), false);
      assert.equal(isValidRepoId("unsloth"), false); // one part
      assert.equal(isValidRepoId("a/b/c"), false); // three parts
      assert.equal(isValidRepoId(""), false);
      assert.equal(isValidRepoId(null), false);
      assert.equal(isValidRepoId(123), false);
    });
    it("assertValidRepoId throws a clear message", () => {
      assert.throws(() => assertValidRepoId("--foo/bar"), /Invalid HuggingFace repo ID/);
    });
  });

  describe("parseHfRef rejects unsafe repo IDs (M2)", () => {
    it("rejects a flag-injection repo ID", () => {
      assert.throws(() => parseHfRef("--foo/bar"), /Invalid HuggingFace repo ID/);
    });
    it("rejects a path-traversal repo ID", () => {
      assert.throws(() => parseHfRef("../etc/passwd"), /Invalid HuggingFace repo ID/);
    });
    it("still accepts a valid repo/filename", () => {
      const ref = parseHfRef("unsloth/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_S.gguf");
      assert.equal(ref.repo, "unsloth/gemma-4-E2B-it-GGUF");
      assert.equal(ref.filename, "gemma-4-E2B-it-Q4_K_S.gguf");
    });
  });

  describe("isSafeRelativePath (M1)", () => {
    it("accepts normal and subdirectory paths", () => {
      assert.equal(isSafeRelativePath("model-Q8_0.gguf"), true);
      assert.equal(isSafeRelativePath("MTP/gemma-4-E2B-it-Q8_0-MTP.gguf"), true);
    });
    it("rejects flag-injection, traversal, absolute, backslash, empty", () => {
      assert.equal(isSafeRelativePath("--cache-dir=/tmp/x.gguf"), false);
      assert.equal(isSafeRelativePath("model/../../etc"), false);
      assert.equal(isSafeRelativePath("/etc/passwd"), false);
      assert.equal(isSafeRelativePath("model\\\\..\\\\x"), false);
      assert.equal(isSafeRelativePath(""), false);
      assert.equal(isSafeRelativePath(null), false);
    });
  });

  describe("assertSafeHfFilename — download boundary guard (H1)", () => {
    it("accepts a normal filename", () => {
      assert.equal(assertSafeHfFilename("model-Q8_0.gguf"), "model-Q8_0.gguf");
    });
    it("rejects a flag-injection filename", () => {
      assert.throws(() => assertSafeHfFilename("--cache-dir=/tmp"), /unsafe filename/);
    });
    it("rejects a path-traversal filename", () => {
      assert.throws(() => assertSafeHfFilename("../escape.gguf"), /unsafe filename/);
    });
  });

  describe("listGgufFiles drops unsafe tree entries paths (M1)", () => {
    const evilTree = [
      { type: "file", path: "model-Q8_0.gguf", size: 1000 },
      { type: "file", path: "--cache-dir=/tmp/x.gguf", size: 1 }, // flag injection
      { type: "file", path: "../escape.gguf", size: 1 },        // traversal
      { type: "file", path: "/abs.gguf", size: 1 },              // absolute
      { type: "file", path: "model.gguf", size: "huge" },        // non-numeric size
      { type: "file", path: "ok.gguf", lfs: { size: 2000 } },
    ];
    const fetchImpl = async () => ({ ok: true, json: async () => evilTree });
    it("keeps only safe paths", async () => {
      const files = await listGgufFiles("org/repo", { fetchImpl });
      assert.deepEqual(files.map((f) => f.path).sort(), ["model-Q8_0.gguf", "model.gguf", "ok.gguf"]);
    });
    it("coerces non-numeric sizes to 0", async () => {
      const files = await listGgufFiles("org/repo", { fetchImpl });
      assert.equal(files.find((f) => f.path === "model.gguf").sizeBytes, 0);
      assert.equal(files.find((f) => f.path === "ok.gguf").sizeBytes, 2000);
    });
  });

  describe("isMlxRepo guards non-object input (M1)", () => {
    it("returns false for null/string/non-object", () => {
      assert.equal(isMlxRepo(null), false);
      assert.equal(isMlxRepo("mlx"), false);
      assert.equal(isMlxRepo(42), false);
    });
    it("still detects mlx by library_name and tags", () => {
      assert.equal(isMlxRepo({ library_name: "mlx" }), true);
      assert.equal(isMlxRepo({ tags: ["mlx"] }), true);
      assert.equal(isMlxRepo({ tags: "mlx" }), false); // non-array tags
    });
  });
});
