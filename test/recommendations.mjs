import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allFittingModels } from "../src/recommendations.mjs";

describe("recommendations", () => {
  it("sorts fitting models by tier descending", () => {
    const hardware = { totalRamBytes: 64 * 1024 ** 3, platform: "darwin", arch: "arm64" };
    const fitting = allFittingModels(hardware);
    assert.ok(fitting.length > 0, "expected at least one fitting model");
    for (let i = 1; i < fitting.length; i += 1) {
      assert.ok(fitting[i - 1].minRamGb >= fitting[i].minRamGb, "fitting models should be sorted best-first");
    }
  });
});
