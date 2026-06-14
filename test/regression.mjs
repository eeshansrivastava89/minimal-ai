import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { detectCapabilities } from "../src/autodetect.mjs";
import { removeInstallerPathBlock } from "../src/shell-path.mjs";
import { compareVersions, detectInvocation, isNewerVersion, updateCommand } from "../src/updates.mjs";
import { applyRuntimeFlagOverrides, removeMtpDefaults } from "../src/profile-setup.mjs";
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

  it("postinstall adds npm global bin to shell rc even when PATH already contains it", async () => {
    const home = await mkdtemp(join(tmpdir(), "offgrid-postinstall-"));
    const prefix = join(home, "npm-global");
    const npmBin = join(prefix, "bin");
    await mkdir(npmBin, { recursive: true });
    const zshrc = join(home, ".zshrc");
    await writeFile(zshrc, "# existing config\n", "utf8");

    const env = {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      npm_config_global: "true",
      npm_config_prefix: prefix,
      // npm puts its bin in PATH during install, so the old check would skip
      PATH: `${npmBin}:${process.env.PATH ?? ""}`,
      OFFGRID_SKIP_POSTINSTALL: "",
      CI: "",
    };

    await execFileAsync(process.execPath, ["src/postinstall.mjs"], { env, cwd: process.cwd() });

    const rc = await readFile(zshrc, "utf8");
    assert.match(rc, /# Added by offgrid-ai installer/);
    assert.ok(rc.includes(`export PATH="${npmBin}:$PATH"`));
  });

  it("postinstall adds PATH to rc even for a Hermes-managed npm prefix", async () => {
    const home = await mkdtemp(join(tmpdir(), "offgrid-postinstall-"));
    const prefix = join(home, ".hermes", "node");
    const npmBin = join(prefix, "bin");
    await mkdir(npmBin, { recursive: true });
    const zshrc = join(home, ".zshrc");
    await writeFile(zshrc, "# existing config\n", "utf8");

    const env = {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      npm_config_global: "true",
      npm_config_prefix: prefix,
      PATH: `${npmBin}:${process.env.PATH ?? ""}`,
      OFFGRID_SKIP_POSTINSTALL: "",
      CI: "",
    };

    await execFileAsync(process.execPath, ["src/postinstall.mjs"], { env, cwd: process.cwd() });

    const rc = await readFile(zshrc, "utf8");
    assert.match(rc, /# Added by offgrid-ai installer/);
    assert.ok(rc.includes(`export PATH="${npmBin}:$PATH"`));
  });

  it("postinstall does not duplicate an existing PATH export in rc", async () => {
    const home = await mkdtemp(join(tmpdir(), "offgrid-postinstall-"));
    const prefix = join(home, "npm-global");
    const npmBin = join(prefix, "bin");
    const zshrc = join(home, ".zshrc");
    await writeFile(zshrc, `export PATH="${npmBin}:$PATH"\n`, "utf8");

    const env = {
      ...process.env,
      HOME: home,
      SHELL: "/bin/zsh",
      npm_config_global: "true",
      npm_config_prefix: prefix,
      PATH: `${npmBin}:${process.env.PATH ?? ""}`,
      OFFGRID_SKIP_POSTINSTALL: "",
      CI: "",
    };

    await execFileAsync(process.execPath, ["src/postinstall.mjs"], { env, cwd: process.cwd() });

    const rc = await readFile(zshrc, "utf8");
    assert.equal((rc.match(/export PATH=/g) || []).length, 1);
    assert.doesNotMatch(rc, /# Added by offgrid-ai installer/);
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


  it("disabling MTP clears backend, flags, drafter, and capability state", () => {
    const profile = {
      backend: "llama-cpp-mtp",
      providerId: "llama-cpp-mtp",
      drafterPath: "/tmp/drafter.gguf",
      capabilities: { mtp: true },
      flags: { host: "127.0.0.1", port: 8081, ctxSize: 32768, cacheTypeK: "bf16", cacheTypeV: "bf16" },
      commandArgv: ["--model", "/tmp/model.gguf", "--spec-type", "draft-mtp", "--spec-draft-n-max", "4", "--spec-draft-model", "/tmp/drafter.gguf"],
    };

    const updated = removeMtpDefaults(profile);
    assert.equal(updated.backend, "llama-cpp");
    assert.equal(updated.providerId, "llama-cpp");
    assert.equal(updated.drafterPath, null);
    assert.equal(updated.capabilities.mtp, false);
    assert.equal(updated.flags.port, 8080);
    assert.equal(updated.commandArgv.includes("--spec-type"), false);
    assert.equal(updated.commandArgv.includes("--spec-draft-n-max"), false);
    assert.equal(updated.commandArgv.includes("--spec-draft-model"), false);
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

  it("does not treat an available Ollama model as running unless it is loaded", async () => {
    const profile = managedProfile("ollama", "llama3.2:latest", "http://localhost:11434/v1");
    const { isProfileRunning, isProfileServerUp, profileRuntimeStatus } = await import("../src/process.mjs");

    await withMockedFetch(async (url) => {
      if (url === "http://localhost:11434/v1/models") return jsonResponse({ data: [{ id: "llama3.2:latest" }] });
      if (url === "http://localhost:11434/api/ps") return jsonResponse({ models: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      assert.equal(await isProfileServerUp(profile), true);
      assert.equal(await isProfileRunning(profile), false);
      const status = await profileRuntimeStatus(profile);
      assert.equal(status.ready, true);
      assert.equal(status.running, false);
      assert.equal(status.modelLoaded, false);
    });
  });

  it("uses Ollama /api/ps to detect loaded models", async () => {
    const profile = managedProfile("ollama", "llama3.2:latest", "http://localhost:11434/v1");
    const { isProfileRunning, profileRuntimeStatus } = await import("../src/process.mjs");

    await withMockedFetch(async (url) => {
      if (url === "http://localhost:11434/v1/models") return jsonResponse({ data: [{ id: "llama3.2:latest" }] });
      if (url === "http://localhost:11434/api/ps") return jsonResponse({ models: [{ name: "llama3.2:latest" }] });
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      assert.equal(await isProfileRunning(profile), true);
      const status = await profileRuntimeStatus(profile);
      assert.equal(status.running, true);
      assert.equal(status.modelLoaded, true);
    });
  });

  it("uses oMLX loaded-model status instead of /v1/models availability", async () => {
    const profile = managedProfile("omlx", "Qwen3-4B-4bit", "http://127.0.0.1:8000/v1");
    const { isProfileRunning, profileRuntimeStatus } = await import("../src/process.mjs");

    await withMockedFetch(async (url) => {
      if (url === "http://127.0.0.1:8000/v1/models") return jsonResponse({ data: [{ id: "Qwen3-4B-4bit" }] });
      if (url === "http://127.0.0.1:8000/v1/models/status") {
        return jsonResponse({ loaded_count: 0, models: [{ id: "Qwen3-4B-4bit", loaded: false }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      assert.equal(await isProfileRunning(profile), false);
      const status = await profileRuntimeStatus(profile);
      assert.equal(status.ready, true);
      assert.equal(status.running, false);
      assert.equal(status.modelLoaded, false);
    });
  });
});

function optionValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function managedProfile(backend, modelId, baseUrl) {
  return {
    id: `${backend}-${modelId.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`,
    backend,
    label: modelId,
    modelAlias: modelId,
    baseUrl,
    ...(backend === "ollama" ? { ollamaModel: modelId } : { omlxModel: modelId }),
  };
}

async function withMockedFetch(fetchImpl, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => fetchImpl(String(url));
  try {
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}
