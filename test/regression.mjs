import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { computeFlags, detectCapabilities } from "../src/autodetect.mjs";
import { removeInstallerPathBlock } from "../src/shell-path.mjs";
import { compareVersions, detectInvocation, isNewerVersion, updateCommand } from "../src/updates.mjs";
import { applyRuntimeFlagOverrides } from "../src/profile-setup.mjs";
import { parseOptions, renderRows } from "../src/ui.mjs";
import { inferHfRef } from "../src/scan.mjs";

describe("regressions", () => {
  it("parseOptions handles short booleans and --key=value", () => {
    assert.deepEqual(parseOptions(["uninstall", "-f", "--name=value", "--", "--literal"]), {
      positional: ["uninstall", "--literal"],
      options: { f: true, name: "value" },
    });
  });

  it("renderRows handles an empty row list", () => {
    assert.equal(renderRows([]), "");
  });

  it("removes installer PATH blocks without depending on current npm bin", () => {
    const input = [
      "export PATH=\"/usr/local/bin:$PATH\"",
      "",
      "# Added by offgrid-ai installer",
      "export PATH=\"/old/npm/bin:$PATH\"",
      "alias ll=ls",
      "",
    ].join("\n");

    const result = removeInstallerPathBlock(input);
    assert.equal(result.changed, true);
    assert.equal(result.content, "export PATH=\"/usr/local/bin:$PATH\"\nalias ll=ls\n");
  });

  it("does not report downgrades as updates", () => {
    assert.equal(compareVersions("0.3.10", "0.3.9") > 0, true);
    assert.equal(isNewerVersion("0.3.10", "0.4.0"), false);
    assert.equal(isNewerVersion("0.4.0", "0.3.10"), true);
  });

  it("uses npm exec for npx-like invocations", () => {
    const invocation = detectInvocation({ npm_command: "exec" });
    const plan = updateCommand(invocation, ["status"]);
    assert.equal(plan.mode, "run-latest");
    assert.deepEqual(plan.args, ["exec", "--yes", "--", "offgrid-ai@latest", "status"]);
  });

  it("detects MTP from LM Studio parent directory names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "Qwen3.6-35B-A3B-MTP-GGUF-"));
    const file = join(dir, "Qwen3.6-35B-A3B-UD-Q4_K_S.gguf");
    await writeFile(file, "GGUF\0");
    const caps = detectCapabilities(file, null);
    assert.equal(caps.mtp, true);
  });

  it("does not conflate imatrix with QAT", async () => {
    const dir = await mkdtemp(join(tmpdir(), "Qwen3.6-35B-A3B-imatrix-GGUF-"));
    const file = join(dir, "Qwen3.6-35B-A3B-Q4_K_M.gguf");
    await writeFile(file, "GGUF\0");
    const caps = detectCapabilities(file, null);
    assert.equal(caps.imatrix, true);
    assert.equal(caps.qat, false);
  });

  it("detects explicit Gemma QAT naming", async () => {
    const dir = await mkdtemp(join(tmpdir(), "google-gemma-3-4b-it-qat-q4_0-gguf-"));
    const file = join(dir, "gemma-3-4b-it-qat-Q4_0.gguf");
    await writeFile(file, "GGUF\0");
    const caps = detectCapabilities(file, null);
    assert.equal(caps.qat, true);
  });

  it("infers Hugging Face refs from cached GGUF paths", () => {
    const path = join(tmpdir(), "hub", "models--unsloth--gemma-4-26B-A4B-it-qat-GGUF", "snapshots", "abc", "gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf");
    assert.deepEqual(inferHfRef(path), {
      repo: "unsloth/gemma-4-26B-A4B-it-qat-GGUF",
      variant: "UD-Q4_K_XL",
    });
  });

  it("infers Hugging Face refs from LM Studio model paths", () => {
    const path = join(tmpdir(), ".lmstudio", "models", "unsloth", "gemma-4-26B-A4B-it-qat-GGUF", "gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf");
    assert.deepEqual(inferHfRef(path), {
      repo: "unsloth/gemma-4-26B-A4B-it-qat-GGUF",
      variant: "UD-Q4_K_XL",
    });
  });

  it("uses llama.cpp Hugging Face refs instead of local draft paths when available", () => {
    const { argv } = computeFlags({ mtp: true, thinking: true, hfRepo: "unsloth/gemma-4-26B-A4B-it-qat-GGUF", hfVariant: "UD-Q4_K_XL" }, "/tmp/model.gguf", "/tmp/mmproj.gguf", "/tmp/mtp.gguf");
    assert.deepEqual(argv.slice(0, 2), ["-hf", "unsloth/gemma-4-26B-A4B-it-qat-GGUF:UD-Q4_K_XL"]);
    assert.equal(argv.includes("--spec-draft-model"), false);
    assert.equal(optionValue(argv, "--spec-type"), "draft-mtp");
  });

  it("updates first-run profile flags and command argv together", () => {
    const profile = {
      flags: { host: "127.0.0.1", port: 8080, ctxSize: 32768, cacheTypeK: "bf16", cacheTypeV: "bf16" },
      commandArgv: ["--model", "/tmp/model.gguf", "--ctx-size", "32768", "--cache-type-k", "bf16", "--cache-type-v", "bf16"],
    };

    const updated = applyRuntimeFlagOverrides(profile, { ctxSize: 65536, cacheTypeK: "q8_0", cacheTypeV: "q8_0" });
    assert.equal(updated.flags.ctxSize, 65536);
    assert.equal(updated.baseUrl, "http://127.0.0.1:8080/v1");
    assert.equal(optionValue(updated.commandArgv, "--ctx-size"), "65536");
    assert.equal(optionValue(updated.commandArgv, "--cache-type-k"), "q8_0");
    assert.equal(optionValue(updated.commandArgv, "--cache-type-v"), "q8_0");
  });

  it("treats corrupt .gguf files as unknown metadata instead of crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "offgrid-regression-"));
    const file = join(dir, "broken-Q4_K_M.gguf");
    await writeFile(file, "GGUF\0");
    const caps = detectCapabilities(file, null);
    assert.equal(caps.architecture, null);
    assert.equal(caps.quant, "q4_k_m");
  });
});

function optionValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}
