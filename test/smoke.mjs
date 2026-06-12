import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Module imports catch ReferenceError (computeFlags, readFile, etc.) on production paths.
import { detectCapabilities, computeFlags } from "../src/autodetect.mjs";
import { createProfileFromModel, loadProfiles } from "../src/profiles.mjs";
import { scanGgufModels } from "../src/scan.mjs";
import { estimateMemory } from "../src/estimate.mjs";
import { backendFor, BACKENDS } from "../src/backends.mjs";
import { readJson, writeJson } from "../src/json.mjs";
import { findLlamaServer, hasHomebrew } from "../src/config.mjs";

describe("module imports", () => {
  it("autodetect exports are callable", () => {
    assert.equal(typeof detectCapabilities, "function");
    assert.equal(typeof computeFlags, "function");
  });

  it("profiles exports are callable", () => {
    assert.equal(typeof createProfileFromModel, "function");
    assert.equal(typeof loadProfiles, "function");
  });

  it("scan exports are callable", () => {
    assert.equal(typeof scanGgufModels, "function");
  });

  it("estimate exports are callable", () => {
    assert.equal(typeof estimateMemory, "function");
  });

  it("backends exports are callable", () => {
    assert.equal(typeof backendFor, "function");
    assert.equal(typeof BACKENDS, "object");
    assert.ok(BACKENDS["llama-cpp"]);
    assert.ok(BACKENDS.ollama);
    assert.ok(BACKENDS.omlx);
  });

  it("json exports are callable", () => {
    assert.equal(typeof readJson, "function");
    assert.equal(typeof writeJson, "function");
  });

  it("config exports are callable", () => {
    assert.equal(typeof findLlamaServer, "function");
    assert.equal(typeof hasHomebrew, "function");
  });
});
