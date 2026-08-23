import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Sandbox before importing modules that resolve MINIMAL_DIR at load time.
const sandboxHome = await mkdtemp(join(tmpdir(), "minimal-limits-"));
process.env.HOME = sandboxHome;
process.env.MINIMAL_DIR = join(sandboxHome, "minimal-data");
after(() => rm(sandboxHome, { recursive: true, force: true }));

const { resolvedLimits, modelDescriptor } = await import("../src/harness-shared.mjs");

function profile(overrides = {}) {
  return { id: "x", label: "X", backend: "llama-cpp", modelAlias: "x", ...overrides };
}

describe("resolvedLimits", () => {
  it("llama.cpp: configured flags.ctxSize wins over metadata", () => {
    const p = profile({ flags: { ctxSize: 8192 }, capabilities: { contextLength: 32768 } });
    assert.deepEqual(resolvedLimits(p), { maxTokens: 8192, contextWindow: 8192 });
  });

  it("llama.cpp: falls back to metadata context length", () => {
    assert.equal(resolvedLimits(profile({ capabilities: { contextLength: 32768 } })).maxTokens, 32768);
  });

  it("omlx: uses the server-reported context length persisted at setup", () => {
    const p = profile({ backend: "omlx", capabilities: { contextLength: 131072 } });
    assert.deepEqual(resolvedLimits(p), { maxTokens: 131072, contextWindow: 131072 });
  });

  it("ollama: served context wins; legacy flags.ctxSize still honored", () => {
    const p = profile({ backend: "ollama", capabilities: { servedContext: 32768 } });
    assert.deepEqual(resolvedLimits(p), { maxTokens: 32768, contextWindow: 32768 });
    const legacy = profile({ backend: "ollama", flags: { ctxSize: 24576 } });
    assert.equal(resolvedLimits(legacy).maxTokens, 24576);
  });
});

describe("modelDescriptor maxTokens", () => {
  it("uses real windows when known; 16384 only as a last resort", () => {
    assert.equal(modelDescriptor(profile({ backend: "omlx", capabilities: { contextLength: 131072 } })).maxTokens, 131072);
    assert.equal(modelDescriptor(profile({ backend: "ollama", capabilities: { servedContext: 32768 } })).maxTokens, 32768);
    assert.equal(modelDescriptor(profile({ flags: { ctxSize: 8192 } })).maxTokens, 8192);
    assert.equal(modelDescriptor(profile()).maxTokens, 16384);
  });

  it("no contextWindow when nothing is known", () => {
    assert.equal(modelDescriptor(profile()).contextWindow, undefined);
  });
});