import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

let importCounter = 0;
function freshConfigImport() {
  return import(`../src/config.mjs?t=${Date.now()}-${++importCounter}`);
}

import { detectCapabilities } from "../src/autodetect.mjs";
import { removeInstallerPathBlock } from "../src/shell-path.mjs";
import { checkForUpdate, compareVersions, currentPackageVersion, detectInvocation, isNewerVersion, updateCommand } from "../src/updates.mjs";
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

  it("checks npm directly instead of using a hidden update cache", async () => {
    const currentVersion = currentPackageVersion();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse({ version: calls === 1 ? currentVersion : "999.0.0" });
    };

    assert.equal(await checkForUpdate({ fetchImpl }), null);
    assert.deepEqual(await checkForUpdate({ fetchImpl }), { current: currentVersion, latest: "999.0.0" });
    assert.equal(calls, 2);
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


  it("disabling MTP clears drafter and capability state", () => {
    const profile = {
      backend: "llama-cpp",
      providerId: "llama-cpp",
      drafterPath: "/tmp/drafter.gguf",
      capabilities: { mtp: true },
      flags: { host: "127.0.0.1", port: 8080, ctxSize: 32768, cacheTypeK: "bf16", cacheTypeV: "bf16" },
    };

    const updated = removeMtpDefaults(profile);
    assert.equal(updated.backend, "llama-cpp");
    assert.equal(updated.providerId, "llama-cpp");
    assert.equal(updated.drafterPath, null);
    assert.equal(updated.capabilities.mtp, false);
  });

  it("updates first-run profile flags together", () => {
    const profile = {
      flags: { host: "127.0.0.1", port: 8080, ctxSize: 32768, cacheTypeK: "bf16", cacheTypeV: "bf16" },
    };

    const updated = applyRuntimeFlagOverrides(profile, { ctxSize: 65536, cacheTypeK: "q8_0", cacheTypeV: "q8_0" });
    assert.equal(updated.flags.ctxSize, 65536);
    assert.equal(updated.baseUrl, "http://127.0.0.1:8080/v1");
    assert.equal(updated.flags.cacheTypeK, "q8_0");
    assert.equal(updated.flags.cacheTypeV, "q8_0");
  });

  it("treats corrupt .gguf files as unknown metadata instead of crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "offgrid-regression-"));
    const file = join(dir, "broken-Q4_K_M.gguf");
    await writeFile(file, "GGUF\0");
    const caps = detectCapabilities(file, null);
    assert.equal(caps.architecture, null);
    assert.equal(caps.quant, "Q4_K_M");
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
      assert.equal(status.modelAvailable, true);
    });
  });

  it("reports an oMLX model as unavailable when it is not in the discovered model list", async () => {
    const profile = managedProfile("omlx", "Qwen3-4B-4bit", "http://127.0.0.1:8000/v1");
    const { modelAvailableOnServer, profileRuntimeStatus } = await import("../src/process.mjs");

    await withMockedFetch(async (url) => {
      if (url === "http://127.0.0.1:8000/v1/models") return jsonResponse({ data: [{ id: "Other-Model-4bit" }] });
      if (url === "http://127.0.0.1:8000/v1/models/status") {
        return jsonResponse({ loaded_count: 0, models: [{ id: "Other-Model-4bit", loaded: false }] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      assert.equal(await modelAvailableOnServer(profile), false);
      const status = await profileRuntimeStatus(profile);
      assert.equal(status.serverUp, true);
      assert.equal(status.modelAvailable, false);
      assert.equal(status.modelLoaded, false);
    });
  });

  it("fails a benchmark before launching Pi when a managed-server model is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "offgrid-benchmark-missing-model-"));
    const fakeBin = join(dir, "bin");
    const runDirectory = join(dir, "run");
    const piMarker = join(dir, "pi-ran");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, "metadata.json"), JSON.stringify({ kind: "visual", status: "prepared", runner: {}, results: {} }, null, 2) + "\n", "utf8");
    await writeFile(join(fakeBin, "pi"), `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(piMarker)}, "ran");\n`, "utf8");
    await chmod(join(fakeBin, "pi"), 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;
    const profile = managedProfile("omlx", "Qwen3-4B-4bit", "http://127.0.0.1:8000/v1");

    try {
      await withMockedFetch(async (url) => {
        if (url === "http://127.0.0.1:8000/v1/models") return jsonResponse({ data: [{ id: "Other-Model-4bit" }] });
        throw new Error(`Unexpected fetch: ${url}`);
      }, async () => {
        const { runPreparedBenchmark } = await import(`../src/benchmark/flow.mjs?t=${Date.now()}-${++importCounter}`);
        const metadata = await runPreparedBenchmark(profile, runDirectory);
        assert.equal(metadata.status, "failed");
        assert.match(metadata.error.message, /Qwen3-4B-4bit is not available on oMLX/);
        await assert.rejects(() => readFile(piMarker), /ENOENT/);
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("unloads oMLX benchmark models with the discovered server model id", async () => {
    const profile = managedProfile("omlx", "qwen3-4b-4bit", "http://127.0.0.1:8000/v1");
    const { unloadModelFromServer } = await import("../src/process.mjs");
    const calls = [];

    await withMockedFetch(async (url) => {
      calls.push(url);
      if (url === "http://127.0.0.1:8000/v1/models") return jsonResponse({ data: [{ id: "Qwen3-4B-4bit" }] });
      if (url === "http://127.0.0.1:8000/admin/api/models/Qwen3-4B-4bit/unload") return textResponse("", { ok: true, status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const result = await unloadModelFromServer(profile);
      assert.deepEqual(result, { unloaded: true, backend: "omlx", modelId: "Qwen3-4B-4bit" });
      assert.equal(calls.length, 2);
    });
  });

  it("treats an oMLX unload response for an already-unloaded model as success", async () => {
    const profile = managedProfile("omlx", "Qwen3-4B-4bit", "http://127.0.0.1:8000/v1");
    const { unloadModelFromServer } = await import("../src/process.mjs");

    await withMockedFetch(async (url) => {
      if (url === "http://127.0.0.1:8000/v1/models") return jsonResponse({ data: [{ id: "Qwen3-4B-4bit" }] });
      if (url === "http://127.0.0.1:8000/admin/api/models/Qwen3-4B-4bit/unload") {
        return textResponse(JSON.stringify({ detail: "model is not loaded" }), { ok: false, status: 400 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const result = await unloadModelFromServer(profile);
      assert.equal(result.unloaded, true);
      assert.equal(result.reason, "model was not loaded");
    });
  });

  it("returns clear oMLX unload errors for auth and network failures", async () => {
    const profile = managedProfile("omlx", "Qwen3-4B-4bit", "http://127.0.0.1:8000/v1");
    const { unloadModelFromServer } = await import("../src/process.mjs");

    await withMockedFetch(async (url) => {
      if (url === "http://127.0.0.1:8000/v1/models") return jsonResponse({ data: [{ id: "Qwen3-4B-4bit" }] });
      if (url === "http://127.0.0.1:8000/admin/api/models/Qwen3-4B-4bit/unload") {
        return textResponse("forbidden", { ok: false, status: 403 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const result = await unloadModelFromServer(profile);
      assert.equal(result.unloaded, false);
      assert.match(result.error, /admin authentication required/);
    });

    await withMockedFetch(async (url) => {
      if (url === "http://127.0.0.1:8000/v1/models") return jsonResponse({ data: [{ id: "Qwen3-4B-4bit" }] });
      if (url === "http://127.0.0.1:8000/admin/api/models/Qwen3-4B-4bit/unload") throw new Error("socket closed");
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const result = await unloadModelFromServer(profile);
      assert.equal(result.unloaded, false);
      assert.equal(result.error, "socket closed");
    });
  });

  it("excludes MarkItDown and other utility models from oMLX scan", async () => {
    const { BACKENDS } = await import("../src/backends.mjs");
    await withMockedFetch(async (url) => {
      if (url === "http://127.0.0.1:8000/v1/models") {
        return jsonResponse({
          data: [
            { id: "gemma-4-e2b-it-4bit", max_model_len: 131072 },
            { id: "MarkItDown", max_model_len: null, model_type: "markitdown" },
            { id: "all-MiniLM-L6-v2", model_type: "embeddings" },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }, async () => {
      const models = await BACKENDS.omlx.scanModels();
      const ids = models.map((m) => m.id);
      assert.ok(ids.includes("gemma-4-e2b-it-4bit"), "expected chat model to be included");
      assert.ok(!ids.includes("MarkItDown"), "expected MarkItDown to be excluded");
      assert.ok(!ids.includes("all-MiniLM-L6-v2"), "expected embedding model to be excluded");
    });
  });

  it("loadConfig returns defaults for missing config (ENOENT)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "offgrid-no-config-"));
    process.env.OFFGRID_DIR = dir;
    // Fresh import to pick up OFFGRID_DIR.
    const mod = await freshConfigImport();
    const config = await mod.loadConfig();
    assert.equal(config.modelScanDirs.length, 0);
    assert.equal(config.benchmarkRepoPath, null);
  });

  it("loadConfig throws on corrupt config instead of silently defaulting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "offgrid-corrupt-config-"));
    process.env.OFFGRID_DIR = dir;
    const configPath = join(dir, "config.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, "not valid json {{{");
    const mod = await freshConfigImport();
    await assert.rejects(
      () => mod.loadConfig(),
      (err) => err.message.includes("Failed to read config"),
    );
  });
});

function managedProfile(backend, modelId, baseUrl) {
  return {
    id: `${backend}-${modelId.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`,
    backend,
    label: modelId,
    modelAlias: modelId,
    baseUrl,
    omlxModel: modelId,
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
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => JSON.stringify(body) };
}

function textResponse(body, { ok, status }) {
  return {
    ok,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}
