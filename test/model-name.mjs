import { parseModelName } from "../src/model-name.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("parseModelName", () => {
  it("parses a GGUF name with publisher, model, params, and quant", () => {
    const result = parseModelName("unsloth/Qwen3-30B-A3B-Q4_K_M", "local-gguf");
    assert.equal(result.publisher, "unsloth");
    assert.equal(result.quant, "Q4_K_M");
    assert.equal(result.id, "unsloth/Qwen3-30B-A3B-Q4_K_M");
    assert.ok(result.display.includes("Qwen 3"));
    assert.ok(result.display.includes("Q4_K_M"));
  });

  it("differentiates Q4 and Q5 quants", () => {
    const q4 = parseModelName("unsloth/Qwen3-30B-A3B-Q4_K_M", "local-gguf");
    const q5 = parseModelName("unsloth/Qwen3-30B-A3B-Q5_K_M", "local-gguf");
    assert.equal(q4.quant, "Q4_K_M");
    assert.equal(q5.quant, "Q5_K_M");
    assert.notEqual(q4.display, q5.display);
  });

  it("parses a GGUF name with it tag", () => {
    const result = parseModelName("bartowski/Gemma-4-12b-it-Q4_K_M", "local-gguf");
    assert.equal(result.publisher, "bartowski");
    assert.equal(result.quant, "Q4_K_M");
    assert.ok(result.tags.includes("it"), `expected 'it' in tags, got: ${result.tags}`);
    assert.ok(result.display.includes("Gemma 4"));
  });

  it("parses a name with MTP tag", () => {
    const result = parseModelName("gemma-4-31B-it-MTP-Q8_0", "local-gguf");
    assert.equal(result.quant, "Q8_0");
    assert.ok(result.tags.includes("mtp"), `expected 'mtp' in tags, got: ${result.tags}`);
  });

  it("parses a name with QAT quant pattern", () => {
    const result = parseModelName("google/Gemma-3-27b-it-QAT-Q4_K_M", "local-gguf");
    assert.ok(result.quant != null, "expected quant to be extracted");
  });

  it("parses a name with UD quant pattern", () => {
    const result = parseModelName("bartowski/Mistral-7B-Instruct-v0.3-UD-Q4_K_XL", "local-gguf");
    assert.ok(result.quant != null, "expected quant to be extracted");
    assert.ok(result.quant.startsWith("UD-") || result.quant.includes("Q4"), `unexpected quant: ${result.quant}`);
  });

  it("handles a name without publisher", () => {
    const result = parseModelName("Qwen3-30B-A3B", "local-gguf");
    assert.equal(result.publisher, null);
    assert.ok(result.display.includes("Qwen 3"));
  });

  it("handles a bare name with no publisher, no quant", () => {
    const result = parseModelName("gemma-4-12b-it", "local-gguf");
    assert.equal(result.publisher, null);
    assert.equal(result.quant, null);
    assert.ok(result.tags.includes("it"), `expected 'it' in tags, got: ${result.tags}`);
  });


  it("parses an oMLX model id with publisher", () => {
    const result = parseModelName("mlx-community/gemma-4-12b-it-q4", "omlx");
    assert.equal(result.publisher, "mlx-community");
    assert.ok(result.display.includes("Gemma 4"));
  });

  it("preserves the raw id without modification", () => {
    const result = parseModelName("unsloth/Qwen3-30B-A3B-Q4_K_M", "local-gguf");
    assert.equal(result.id, "unsloth/Qwen3-30B-A3B-Q4_K_M");
  });

  it("extracts params from model name", () => {
    const result = parseModelName("unsloth/Qwen3-30B-A3B-Q4_K_M", "local-gguf");
    assert.equal(result.params, "30B");
  });

  it("extracts smaller param sizes", () => {
    const result = parseModelName("bartowski/Gemma-4-12b-it-Q4_K_M", "local-gguf");
    assert.equal(result.params, "12B");
  });

  it("handles a name with only publisher and bare model", () => {
    const result = parseModelName("TheBlock/Gemma-2B", "local-gguf");
    assert.equal(result.publisher, "TheBlock");
    assert.ok(result.display.includes("Gemma"));
  });

  it("handles F16 quant", () => {
    const result = parseModelName("google/Gemma-3-27b-it-F16", "local-gguf");
    assert.equal(result.quant, "F16");
  });

  it("handles BF16 quant", () => {
    const result = parseModelName("google/Gemma-3-27b-it-BF16", "local-gguf");
    assert.equal(result.quant, "BF16");
  });

  it("always returns a display string (never empty)", () => {
    const result = parseModelName("x", "local-gguf");
    assert.ok(result.display.length > 0, "display should never be empty");
    assert.equal(result.id, "x");
  });

  it("title-cases known model families with version separation", () => {
    const families = [
      { input: "qwen3-30b", expected: "Qwen 3" },
      { input: "gemma-4-12b", expected: "Gemma 4" },
      { input: "mistral-7b", expected: "Mistral" },
      { input: "deepseek-r1-7b", expected: "DeepSeek R1" },
    ];
    for (const { input, expected } of families) {
      const result = parseModelName(input, "local-gguf");
      assert.ok(result.display.includes(expected), `expected "${expected}" in display for "${input}", got: "${result.display}"`);
    }
  });

  it("uses › separator in display between publisher, model, and quant", () => {
    const result = parseModelName("unsloth/Qwen3-30B-A3B-Q4_K_M", "local-gguf");
    const parts = result.display.split(" › ");
    assert.ok(parts.length >= 2, `expected at least 2 parts separated by ›, got: ${result.display}`);
    assert.equal(parts[0], "unsloth");
    assert.ok(parts[parts.length - 1].includes("Q4_K_M"), `last part should contain quant, got: ${parts[parts.length - 1]}`);
  });

  it("extracts active params like A3B", () => {
    const result = parseModelName("Qwen3-235B-A22B", "local-gguf");
    assert.ok(result.display.includes("A22B"), `expected A22B in display, got: ${result.display}`);
    assert.equal(result.params, "235B");
  });
});