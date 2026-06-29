import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recommendModels, selectFormat, allFittingModels, getModelEntries } from "../src/recommendations.mjs";

describe("recommendations", () => {
  it("loads curated model entries", () => {
    const entries = getModelEntries();
    assert.ok(entries.length > 0, "expected at least one recommendation");
    assert.ok(entries.every((e) => typeof e.id === "string" && typeof e.minRamGb === "number"));
  });

  it("recommends the highest RAM tier that fits", () => {
    const hardware = { totalRamBytes: 32 * 1024 ** 3, platform: "darwin", arch: "arm64" };
    const fitting = recommendModels(hardware);
    assert.ok(fitting.length > 0, "expected at least one fitting model");
    const maxTier = Math.max(...fitting.map((e) => e.minRamGb));
    assert.equal(fitting.every((e) => e.minRamGb === maxTier), true);
  });

  it("prefers MLX on Apple Silicon", () => {
    const hardware = { totalRamBytes: 32 * 1024 ** 3, platform: "darwin", arch: "arm64" };
    const entry = { id: "test", label: "Test", minRamGb: 8, mlx: "mlx-community/test", gguf: "unsloth/test" };
    assert.equal(selectFormat(entry, hardware), "mlx");
  });

  it("falls back to GGUF on non-Apple Silicon", () => {
    const hardware = { totalRamBytes: 32 * 1024 ** 3, platform: "linux", arch: "x64" };
    const entry = { id: "test", label: "Test", minRamGb: 8, mlx: "mlx-community/test", gguf: "unsloth/test" };
    assert.equal(selectFormat(entry, hardware), "gguf");
  });

  it("returns null when no compatible format exists", () => {
    const hardware = { totalRamBytes: 32 * 1024 ** 3, platform: "darwin", arch: "arm64" };
    const entry = { id: "test", label: "Test", minRamGb: 8 };
    assert.equal(selectFormat(entry, hardware), null);
  });

  it("sorts fitting models by tier descending", () => {
    const hardware = { totalRamBytes: 64 * 1024 ** 3, platform: "darwin", arch: "arm64" };
    const fitting = allFittingModels(hardware);
    for (let i = 1; i < fitting.length; i += 1) {
      assert.ok(fitting[i - 1].minRamGb >= fitting[i].minRamGb, "fitting models should be sorted best-first");
    }
  });
});
