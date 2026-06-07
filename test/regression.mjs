import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectCapabilities } from "../src/autodetect.mjs";
import { removeInstallerPathBlock } from "../src/shell-path.mjs";
import { compareVersions, detectInvocation, isNewerVersion, updateCommand } from "../src/updates.mjs";
import { applyRuntimeFlagOverrides } from "../src/profile-setup.mjs";
import { parseOptions, renderRows } from "../src/ui.mjs";

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

  it("updates first-run profile flags and command argv together", () => {
    const profile = {
      flags: { host: "127.0.0.1", port: 8080, ctxSize: 32768, cacheTypeK: "bf16", cacheTypeV: "bf16" },
      commandArgv: ["--model", "/tmp/model.gguf", "--ctx-size", "32768", "--cache-type-k", "bf16", "--cache-type-v", "bf16"],
    };

    const updated = applyRuntimeFlagOverrides(profile, { ctxSize: 65536, cacheTypeK: "q8_0", cacheTypeV: "q8_0" });
    assert.equal(updated.flags.ctxSize, 65536);
    assert.equal(updated.baseUrl, "http://127.0.0.1:8080/v1");
    assert.deepEqual(updated.commandArgv.slice(-6), ["--ctx-size", "65536", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]);
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
