import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectMlxCapabilitiesFromConfig, defaultMlxContextLength } from "../src/mlx-discovery.mjs";

describe("MLX capability detection", () => {
  it("detects vision from image_token_id", () => {
    const caps = detectMlxCapabilitiesFromConfig({
      _name_or_path: "mlx-community/gemma-4-e2b-it-4bit",
      model_type: "gemma4",
      architectures: ["Gemma4ForConditionalGeneration"],
      image_token_id: 258880,
      max_position_embeddings: 131072,
    });
    assert.equal(caps.vision, true);
    assert.equal(caps.thinking, true);
    assert.equal(caps.contextLength, 131072);
    assert.equal(caps.architecture, "Gemma4ForConditionalGeneration");
  });

  it("detects vision from vision_config", () => {
    const caps = detectMlxCapabilitiesFromConfig({
      _name_or_path: "mlx-community/Qwen3.5-9B-MLX-4bit",
      model_type: "qwen3_5",
      vision_config: { hidden_size: 1152 },
      text_config: { max_position_embeddings: 32768 },
    });
    assert.equal(caps.vision, true);
    assert.equal(caps.contextLength, 32768);
  });

  it("detects thinking from Qwen family names", () => {
    const caps = detectMlxCapabilitiesFromConfig({
      _name_or_path: "mlx-community/Qwen3.6-27B-4bit",
      model_type: "qwen3_5",
      max_position_embeddings: 32768,
    });
    assert.equal(caps.thinking, true);
  });

  it("returns null context length when missing", () => {
    const caps = detectMlxCapabilitiesFromConfig({
      _name_or_path: "some/model",
      model_type: "llama",
    });
    assert.equal(caps.contextLength, null);
  });

  it("picks context length capped by RAM", () => {
    assert.equal(defaultMlxContextLength(131072, 8), 4096);
    assert.equal(defaultMlxContextLength(131072, 16), 16384);
    assert.equal(defaultMlxContextLength(131072, 24), 16384);
    assert.equal(defaultMlxContextLength(262144, 48), 262144);
  });
});
