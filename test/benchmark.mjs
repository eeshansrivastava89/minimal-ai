import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Sandbox before importing modules that resolve homedir()/MINIMAL_DIR at load
// time — benchmark repo linking touches config.json, which must never be the
// real one.
const sandboxHome = await mkdtemp(join(tmpdir(), "minimal-bench-home-"));
process.env.HOME = sandboxHome;
process.env.MINIMAL_DIR = join(sandboxHome, "minimal-data");
after(() => rm(sandboxHome, { recursive: true, force: true }));

const { slugModelId, createRunId, loadBenchmarks, prepareBenchmarkRun } = await import("../src/benchmark.mjs");

function makeTmp() {
  return mkdtemp(join(tmpdir(), "minimal-bench-"));
}

describe("slugModelId", () => {
  it("keeps already-clean lowercase slugs as-is", () => {
    assert.equal(slugModelId("gemma-4-26b-a4b-it-qat-mlx-4bit"), "gemma-4-26b-a4b-it-qat-mlx-4bit");
  });

  it("normalizes mixed-case model ids to gallery slugs", () => {
    assert.equal(slugModelId("gemma-4-26B-A4B-it-QAT-MLX-4bit"), "gemma-4-26b-a4b-it-qat-mlx-4bit");
  });

  it("appends a hash suffix when normalization changes the id", () => {
    const slug = slugModelId("Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed");
    assert.match(slug, /^youssofal-qwen3-8-27b-mtplx-optimized-speed-[0-9a-f]{10}$/);
  });

  it("truncates very long ids and appends a hash", () => {
    const slug = slugModelId("a".repeat(200));
    assert.ok(slug.length <= 80);
    assert.match(slug, /-[0-9a-f]{10}$/);
  });
});

describe("createRunId", () => {
  it("formats ISO timestamps with filesystem-safe separators", () => {
    const runId = createRunId(new Date("2026-06-25T05:57:52.369Z"));
    assert.equal(runId, "2026-06-25T05-57-52-369Z");
  });
});

describe("loadBenchmarks", () => {
  it("parses frontmatter and body from benchmark markdown files", async () => {
    const dir = await makeTmp();
    after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "sakura.md"), "---\nid: sakura\ntitle: Sakura Tree\ndescription: Cherry blossom animation.\n---\n\nBuild a tree.\n");
    await writeFile(join(dir, "plain.md"), "No frontmatter here.\n");

    const benchmarks = await loadBenchmarks(dir);
    assert.equal(benchmarks.length, 2);
    const sakura = benchmarks.find((b) => b.id === "sakura");
    assert.equal(sakura.title, "Sakura Tree");
    assert.equal(sakura.description, "Cherry blossom animation.");
    assert.equal(sakura.prompt, "Build a tree.");
    assert.equal(sakura.kind, "visual");
    const plain = benchmarks.find((b) => b.id === "plain");
    assert.equal(plain.prompt, "No frontmatter here.");
  });

  it("reads kind from frontmatter (data-science) and defaults to visual", async () => {
    const dir = await makeTmp();
    after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "ab-test-analysis.md"), "---\nid: ab-test-analysis\ntitle: A/B Test\nkind: data-science\n---\n\nAnalyze.\n");
    await writeFile(join(dir, "sakura.md"), "---\nid: sakura\ntitle: Sakura\n---\n\nPaint.\n");
    const benchmarks = await loadBenchmarks(dir);
    assert.equal(benchmarks.find((b) => b.id === "ab-test-analysis").kind, "data-science");
    assert.equal(benchmarks.find((b) => b.id === "sakura").kind, "visual");
  });

  it("rejects an invalid kind", async () => {
    const dir = await makeTmp();
    after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "weird.md"), "---\nid: weird\ntitle: Weird\nkind: quantum\n---\n\nNope.\n");
    await assert.rejects(() => loadBenchmarks(dir), /invalid benchmark "kind"/);
  });
});

describe("prepareBenchmarkRun", () => {
  const now = new Date("2026-08-17T12:00:00.000Z");

  function llamaProfile() {
    return {
      id: "qwen3-6-27b",
      label: "Qwen3.6 27B",
      backend: "llama-cpp",
      modelAlias: "qwen3.6-27b-q4_k_m",
      baseUrl: "http://127.0.0.1:8080/v1",
    };
  }

  it("creates a schema-compatible run slot with metadata and prompt", async () => {
    const repo = await makeTmp();
    after(() => rm(repo, { recursive: true, force: true }));
    await mkdir(join(repo, "benchmarks"), { recursive: true });

    const benchmark = { id: "sakura", title: "Sakura Tree", description: "Cherry blossom.", prompt: "Build a tree.", kind: "visual" };
    const runDirectory = await prepareBenchmarkRun({ repoPath: repo, benchmark, profile: llamaProfile(), now });

    // The alias contains "." and "_", so the slug gets a hash suffix.
    const expectedSlug = slugModelId("qwen3.6-27b-q4_k_m");
    assert.match(expectedSlug, /^qwen3-6-27b-q4-k-m-[0-9a-f]{10}$/);
    assert.equal(runDirectory, join(repo, "runs", "sakura", expectedSlug, "2026-08-17T12-00-00-000Z"));

    const metadata = JSON.parse(await readFile(join(runDirectory, "metadata.json"), "utf8"));
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.status, "prepared");
    assert.equal(metadata.kind, "visual");
    assert.equal(metadata.model.id, "qwen3.6-27b-q4_k_m");
    assert.equal(metadata.model.slug, expectedSlug);
    assert.equal(metadata.runner.modelSource, "llama-cpp");
    assert.equal(metadata.runner.backendLabel, "llama.cpp");
    assert.equal(metadata.runner.baseUrl, "http://127.0.0.1:8080/v1");
    assert.equal(metadata.assets.html, "index.html");
    assert.equal(metadata.runDirectory, runDirectory);

    const prompt = await readFile(join(runDirectory, "prompt.md"), "utf8");
    assert.equal(prompt, "Build a tree.\n");
  });

  it("tags llama.cpp profiles with a drafter as llama-cpp-mtp", async () => {
    const repo = await makeTmp();
    after(() => rm(repo, { recursive: true, force: true }));
    const benchmark = { id: "sakura", title: "Sakura Tree", description: "", prompt: "Build a tree.", kind: "visual" };
    const runDirectory = await prepareBenchmarkRun({
      repoPath: repo,
      benchmark,
      profile: { ...llamaProfile(), drafterPath: "/models/drafter.gguf" },
      now,
    });
    const metadata = JSON.parse(await readFile(join(runDirectory, "metadata.json"), "utf8"));
    assert.equal(metadata.runner.modelSource, "llama-cpp-mtp");
  });

  it("uses oMLX model ids and data-science assets for managed profiles", async () => {
    const repo = await makeTmp();
    after(() => rm(repo, { recursive: true, force: true }));
    const benchmark = { id: "ab-test-analysis", title: "A/B Test", description: "", prompt: "Analyze.", kind: "data-science" };
    const runDirectory = await prepareBenchmarkRun({
      repoPath: repo,
      benchmark,
      profile: {
        id: "gemma",
        label: "Gemma",
        backend: "omlx",
        omlxModel: "gemma-4-26B-A4B-it-QAT-MLX-4bit",
        baseUrl: "http://127.0.0.1:8000/v1",
      },
      now,
    });
    const metadata = JSON.parse(await readFile(join(runDirectory, "metadata.json"), "utf8"));
    assert.equal(metadata.model.id, "gemma-4-26B-A4B-it-QAT-MLX-4bit");
    assert.equal(metadata.runner.modelSource, "omlx");
    assert.equal(metadata.runner.backendLabel, "oMLX");
    assert.equal(metadata.assets.ds.notebook, "analysis.ipynb");
    assert.equal(metadata.assets.html, undefined);
  });
});
