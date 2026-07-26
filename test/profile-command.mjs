import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = await mkdtemp(join(tmpdir(), "minimal-profile-command-"));
process.env.MINIMAL_DIR = dataDir;

const { piApiModelId } = await import("../src/harness-pi.mjs");

describe("piApiModelId", () => {
  it("uses modelAlias for all backends", () => {
    assert.equal(piApiModelId({ backend: "llama-cpp", modelAlias: "friendly", modelPath: "/m.gguf" }), "friendly");
    assert.equal(piApiModelId({ backend: "omlx", modelAlias: "Qwen3-27B", modelPath: null }), "Qwen3-27B");
  });
});