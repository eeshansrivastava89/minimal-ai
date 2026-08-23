import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let importCounter = 0;
function freshConfigImport() {
  return import(`../src/config.mjs?t=${Date.now()}-${++importCounter}`);
}

import { detectGgufCapabilities } from "../src/capabilities.mjs";
import { removeInstallerPathBlock } from "../src/shell-path.mjs";
import { checkForUpdate, compareVersions, currentPackageVersion, detectInvocation, isNewerVersion, updateCommand } from "../src/updates.mjs";
import { applyRuntimeFlagOverrides, removeMtpDefaults } from "../src/profile-flags.mjs";
import { computeMemoryTotal } from "../src/estimate.mjs";
import { parseOptions, renderList } from "../src/ui.mjs";

describe("regressions", () => {
  it("KV estimate skips layers past gemma4's short attention arrays", () => {
    // gemma4 GGUFs: block_count 48 but only 32 attention layers carry
    // head_count_kv / sliding_window_pattern entries. Layers past the array
    // have no KV cache — they must be skipped, not zero the whole estimate.
    const headKv = Array.from({ length: 32 }, (_, i) => (i % 6 === 5 ? 1 : 8));
    const slidingWindowPattern = Array.from({ length: 32 }, (_, i) => i % 6 !== 5);
    const prepared = {
      modelBytes: 7 * 1024 ** 3,
      mmprojBytes: 0,
      draftBytes: 0,
      overheadBytes: 256 * 1024 ** 2,
      kvParams: {
        layers: 48,
        headKv,
        keyLength: 512,
        valueLength: 512,
        slidingWindow: 1024,
        slidingWindowPattern,
        keyLengthSwa: 256,
        valueLengthSwa: 256,
      },
    };
    const small = computeMemoryTotal(prepared, { ctxSize: 4096, cacheTypeK: "bf16", cacheTypeV: "bf16", parallel: 1 });
    const large = computeMemoryTotal(prepared, { ctxSize: 131072, cacheTypeK: "bf16", cacheTypeV: "bf16", parallel: 1 });
    assert.ok(small.kvBytes > 0, "small ctx should produce a nonzero KV estimate");
    assert.ok(large.kvBytes > small.kvBytes, "KV must grow with context (only global-attention layers grow past SWA)");
    // Exact check, 4k bf16: 27 SWA layers: 1024 ctx * 8 kv-heads * (256*2 + 256*2)
    //                      + 5 global layers: 4096 ctx * 1 kv-head * (512*2 + 512*2)
    const expected = 27 * (1024 * 8 * (512 + 512)) + 5 * (4096 * 1 * (1024 + 1024));
    assert.equal(small.kvBytes, expected);
    const quant = computeMemoryTotal(prepared, { ctxSize: 4096, cacheTypeK: "q4_0", cacheTypeV: "q4_0", parallel: 1 });
    assert.ok(quant.kvBytes < small.kvBytes, "KV must shrink with quantized cache types");
  });

  it("KV estimate counts only full-attention layers on qwen35 hybrid models", async () => {
    // qwen35 GGUFs (Qwen3.5/3.8 dense hybrids) report scalar attention dims
    // for all blocks plus full_attention_interval: only every interval-th
    // layer has a KV cache; the rest are Gated DeltaNet layers with a small
    // fixed recurrent state. Mirrors unsloth/Qwen3.8-27B-GGUF metadata.
    const dir = await mkdtemp(join(tmpdir(), "minimal-qwen35-"));
    const file = join(dir, "Qwen3.8-27B-IQ4_XS.gguf");
    await writeFile(file, buildGguf({
      "general.architecture": "qwen35",
      "qwen35.block_count": 65,
      "qwen35.context_length": 262144,
      "qwen35.embedding_length": 5120,
      "qwen35.feed_forward_length": 17408,
      "qwen35.attention.head_count": 24,
      "qwen35.attention.head_count_kv": 4,
      "qwen35.attention.key_length": 256,
      "qwen35.attention.value_length": 256,
      "qwen35.full_attention_interval": 4,
      "qwen35.ssm.state_size": 128,
      "qwen35.ssm.inner_size": 6144,
      "qwen35.ssm.conv_kernel": 4,
      "qwen35.ssm.time_step_rank": 48,
      "qwen35.nextn_predict_layers": 1,
    }));

    const { prepareMemoryEstimate } = await import("../src/estimate.mjs");
    const prepared = prepareMemoryEstimate(file, null, null);
    assert.equal(prepared.kvParams.layers, 16, "only every 4th of 65 blocks carries KV cache");

    const flags = { ctxSize: 262144, cacheTypeK: "bf16", cacheTypeV: "bf16", parallel: 1 };
    const est = computeMemoryTotal(prepared, flags);
    // 16 layers * 262144 ctx * 4 kv-heads * (256*2 + 256*2) = 16 GiB, not 65x that.
    assert.equal(est.kvBytes, 16 * 1024 ** 3);
    // Fixed recurrent state is folded into overhead: 49 linear layers *
    // (128*6144 f32 state + 3*6144 f32 conv) on top of the size-scaled base.
    const stateBytes = 49 * (128 * 6144 * 4 + 3 * 6144 * 4);
    assert.equal(est.overheadBytes, Math.max(256 * 1024 ** 2, Math.round(prepared.modelBytes * 0.05)) + stateBytes);

    const q4 = computeMemoryTotal(prepared, { ...flags, cacheTypeK: "q4_0", cacheTypeV: "q4_0" });
    assert.ok(q4.kvBytes < est.kvBytes, "quantized cache types still shrink hybrid KV");
  });

  it("parseOptions handles short booleans and --key=value", () => {
    assert.deepEqual(parseOptions(["uninstall", "-f", "--name=value", "--", "--literal"]), {
      positional: ["uninstall", "--literal"],
      options: { f: true, name: "value" },
    });
  });

  it("renderList handles an empty row list", () => {
    assert.equal(renderList([]), "");
  });

  it("removes installer PATH blocks without depending on current npm bin", () => {
    const input = [
      "export PATH=\"/usr/local/bin:$PATH\"",
      "",
      "# Added by minimal-ai installer",
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
    assert.deepEqual(plan.args, ["exec", "--yes", "--", "minimal-ai@latest", "status"]);
  });

  it("falls back to global install for npx update to avoid recursion", () => {
    const invocation = detectInvocation({ npm_command: "exec" });
    const plan = updateCommand(invocation, ["update"]);
    assert.equal(plan.mode, "install-global");
    assert.deepEqual(plan.args, ["install", "-g", "minimal-ai@latest"]);
  });

  it("detects MTP from LM Studio parent directory names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "Qwen3.6-35B-A3B-MTP-GGUF-"));
    const file = join(dir, "Qwen3.6-35B-A3B-UD-Q4_K_S.gguf");
    await writeFile(file, "GGUF\0");
    const caps = detectGgufCapabilities(file, null);
    assert.equal(caps.mtp, true);
  });

  it("does not conflate imatrix with QAT", async () => {
    const dir = await mkdtemp(join(tmpdir(), "Qwen3.6-35B-A3B-imatrix-GGUF-"));
    const file = join(dir, "Qwen3.6-35B-A3B-Q4_K_M.gguf");
    await writeFile(file, "GGUF\0");
    const caps = detectGgufCapabilities(file, null);
    assert.equal(caps.imatrix, true);
    assert.equal(caps.qat, false);
  });

  it("detects explicit Gemma QAT naming", async () => {
    const dir = await mkdtemp(join(tmpdir(), "google-gemma-3-4b-it-qat-q4_0-gguf-"));
    const file = join(dir, "gemma-3-4b-it-qat-Q4_0.gguf");
    await writeFile(file, "GGUF\0");
    const caps = detectGgufCapabilities(file, null);
    assert.equal(caps.qat, true);
  });


  it("disabling MTP clears drafter and the choice, keeping the fact", () => {
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
    // The choice moves to mtpEnabled; capabilities.mtp stays the pure fact.
    assert.equal(updated.mtpEnabled, false);
    assert.equal(updated.capabilities.mtp, true);
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
    const dir = await mkdtemp(join(tmpdir(), "minimal-regression-"));
    const file = join(dir, "broken-Q4_K_M.gguf");
    await writeFile(file, "GGUF\0");
    const caps = detectGgufCapabilities(file, null);
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

  it("unloads oMLX models with the discovered server model id", async () => {
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
            { id: "mlx-community/Qwen3.6-27B-MTP-4bit", model_type: "qwen3_5_mtp", max_model_len: 262144 },
            { id: "Jundot/Qwen3.6-27B-oQ4e-mtp", model_type: "qwen3_5", max_model_len: 262144 },
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
      assert.ok(!ids.includes("mlx-community/Qwen3.6-27B-MTP-4bit"), "expected MTP drafter to be excluded");
      assert.ok(ids.includes("Jundot/Qwen3.6-27B-oQ4e-mtp"), "expected MTP-capable chat model to be included");
    });
  });

  it("loadConfig returns defaults for missing config (ENOENT)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minimal-no-config-"));
    process.env.MINIMAL_DIR = dir;
    // Fresh import to pick up MINIMAL_DIR.
    const mod = await freshConfigImport();
    const config = await mod.loadConfig();
    assert.equal(config.modelScanDirs.length, 0);

  });

  it("loadConfig throws on corrupt config instead of silently defaulting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minimal-corrupt-config-"));
    process.env.MINIMAL_DIR = dir;
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

/** Write a minimal valid GGUF file (header + metadata only) for reader tests. */
function buildGguf(meta) {
  const entries = Object.entries(meta);
  const parts = [];
  const header = Buffer.alloc(24);
  header.write("GGUF", 0, "utf8");
  header.writeUInt32LE(3, 4); // version
  header.writeBigUInt64LE(0n, 8); // tensor count
  header.writeBigUInt64LE(BigInt(entries.length), 16);
  parts.push(header);
  for (const [key, value] of entries) {
    const keyBuf = Buffer.alloc(8 + Buffer.byteLength(key));
    keyBuf.writeBigUInt64LE(BigInt(Buffer.byteLength(key)), 0);
    keyBuf.write(key, 8, "utf8");
    parts.push(keyBuf);
    if (typeof value === "string") {
      const valBuf = Buffer.alloc(4 + 8 + Buffer.byteLength(value));
      valBuf.writeUInt32LE(8, 0); // string type
      valBuf.writeBigUInt64LE(BigInt(Buffer.byteLength(value)), 4);
      valBuf.write(value, 12, "utf8");
      parts.push(valBuf);
    } else {
      const valBuf = Buffer.alloc(4 + 4);
      valBuf.writeUInt32LE(4, 0); // uint32 type
      valBuf.writeUInt32LE(value, 4);
      parts.push(valBuf);
    }
  }
  return Buffer.concat(parts);
}

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
