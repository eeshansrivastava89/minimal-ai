import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDir = await mkdtemp(join(tmpdir(), "minimal-profile-command-"));
process.env.MINIMAL_DIR = dataDir;

const { harnessModelRef } = await import("../src/harness-shared.mjs");

describe("harnessModelRef", () => {
  it("uses modelAlias for all backends", () => {
    assert.equal(harnessModelRef({ providerId: "llama-cpp", modelAlias: "friendly" }), "llama-cpp/friendly");
    assert.equal(harnessModelRef({ providerId: "omlx", modelAlias: "Qwen3-27B" }), "omlx/Qwen3-27B");
  });
});