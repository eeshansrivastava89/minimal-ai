import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { ollamaServedContext } = await import("../src/ollama-runtime.mjs");

function psResponse(models) {
  return { ok: true, json: async () => ({ models }) };
}

describe("ollamaServedContext", () => {
  it("returns the live context_length for the loaded model", async () => {
    const fetchImpl = async () => psResponse([
      { name: "qwen3.8:27b-mlx", context_length: 32768 },
    ]);
    assert.equal(await ollamaServedContext("qwen3.8:27b-mlx", { fetchImpl }), 32768);
  });

  it("returns null when the model is not loaded", async () => {
    const fetchImpl = async () => psResponse([
      { name: "other-model", context_length: 8192 },
    ]);
    assert.equal(await ollamaServedContext("qwen3.8:27b-mlx", { fetchImpl }), null);
  });

  it("returns null on server errors and bad payloads", async () => {
    assert.equal(await ollamaServedContext("m", { fetchImpl: async () => ({ ok: false }) }), null);
    assert.equal(await ollamaServedContext("m", { fetchImpl: async () => { throw new Error("down"); } }), null);
    const noCtx = async () => psResponse([{ name: "m" }]);
    assert.equal(await ollamaServedContext("m", { fetchImpl: noCtx }), null);
  });
});
