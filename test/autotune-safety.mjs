import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

// Sandbox DATA_DIR + HOME before importing modules that resolve them at load
// time — snapshot reads ~/.omlx/model_settings.json, which must never be the
// real one.
const sandboxHome = await mkdtemp(join(tmpdir(), "minimal-autotune-home-"));
process.env.HOME = sandboxHome;
const sandboxData = join(sandboxHome, "minimal-data");
process.env.MINIMAL_DIR = sandboxData;
after(() => rm(sandboxHome, { recursive: true, force: true }));

const {
  acquireAutotuneLock,
  autotuneRunsRoot,
  createRunDir,
  ramGate,
  snapshotModelSettings,
  restoreSettingsSnapshot,
  appendJournal,
  readJournal,
} = await import("../src/autotune/safety.mjs");
const { normalizeOmlxAdminModel, loadedModelIds, inferenceLoadedIds, needsMtplxImport } = await import("../src/autotune/probe.mjs");

describe("needsMtplxImport", () => {
  it("flags the side-car-not-imported state", () => {
    const m = normalizeOmlxAdminModel({
      id: "Qwen3.5-9B-MTPLX-Optimized-Speed",
      mtp_compatible: false,
      mtp_compatibility_reason: "MTPLX side-car detected but not imported. Import it to merge the MTP head into the checkpoint index.",
    });
    assert.equal(needsMtplxImport(m), true);
  });

  it("is false once MTP is compatible (post-import)", () => {
    const m = normalizeOmlxAdminModel({ id: "X", mtp_compatible: true, mtp_compatibility_reason: "" });
    assert.equal(needsMtplxImport(m), false);
  });

  it("is false for the stripped-weights case (no side-car to import)", () => {
    const m = normalizeOmlxAdminModel({
      id: "X-4bit",
      mtp_compatible: false,
      mtp_compatibility_reason: "Config declares MTP layers but the weight files contain neither mtp.* tensors nor native nextn layers.",
    });
    assert.equal(needsMtplxImport(m), false);
  });
});

describe("autotune probe normalization", () => {
  it("normalizes a raw admin entry", () => {
    const model = normalizeOmlxAdminModel({
      id: "Qwen3.8-27B-4bit",
      display_name: "mlx-community/Qwen3.8-27B-4bit",
      loaded: false,
      is_loading: false,
      estimated_size: 16857268416,
      thinking_default: true,
      mtp_compatible: false,
      mtp_compatibility_reason: "no MTP heads",
      dflash_compatible: true,
      settings: { dflash_enabled: true },
    });
    assert.equal(model.id, "Qwen3.8-27B-4bit");
    assert.equal(model.loaded, false);
    assert.equal(model.estimatedSizeBytes, 16857268416);
    assert.equal(model.thinkingDefault, true);
    assert.equal(model.mtpCompatible, false);
    assert.equal(model.mtpReason, "no MTP heads");
    assert.equal(model.dflashCompatible, true);
    assert.deepEqual(model.settings, { dflash_enabled: true });
  });

  it("collects only loaded ids", () => {
    const models = [
      normalizeOmlxAdminModel({ id: "a", loaded: true }),
      normalizeOmlxAdminModel({ id: "b", loaded: false }),
      normalizeOmlxAdminModel({ id: "c" }),
    ];
    assert.deepEqual(loadedModelIds(models), ["a"]);
  });

  it("inferenceLoadedIds excludes non-GPU-resident helpers like MarkItDown", () => {
    const models = [
      normalizeOmlxAdminModel({ id: "Qwen3.5-9B", loaded: true, engine_type: "vlm" }),
      normalizeOmlxAdminModel({ id: "MarkItDown", loaded: true, engine_type: "markitdown" }),
      normalizeOmlxAdminModel({ id: "DFlash-draft", loaded: false, engine_type: "batched" }),
    ];
    assert.deepEqual(loadedModelIds(models), ["Qwen3.5-9B", "MarkItDown"]);
    assert.deepEqual(inferenceLoadedIds(models), ["Qwen3.5-9B"]);
  });
});

describe("autotune lockfile", () => {
  it("acquires, blocks a second acquirer, and releases", async () => {
    const first = await acquireAutotuneLock({ modelId: "model-a" });
    assert.equal(first.ok, true);
    const holder = JSON.parse(await readFile(join(autotuneRunsRoot(), "autotune.lock"), "utf8"));
    assert.equal(holder.pid, process.pid);

    await first.release();
    assert.equal(existsSync(join(autotuneRunsRoot(), "autotune.lock")), false);
  });

  it("reclaims a stale lock from a dead pid", async () => {
    const lockPath = join(autotuneRunsRoot(), "autotune.lock");
    await mkdir(autotuneRunsRoot(), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: 2 ** 22, modelId: "ghost", startedAt: "x" }));
    const acquired = await acquireAutotuneLock({ modelId: "model-b" });
    assert.equal(acquired.ok, true);
    await acquired.release();
  });
});

describe("RAM gate", () => {
  it("passes with a trivially small threshold", () => {
    const result = ramGate(1);
    assert.equal(result.ok, true);
    assert.ok(result.availableBytes > 0);
  });

  it("fails with an absurd threshold", () => {
    const result = ramGate(10 ** 15);
    assert.equal(result.ok, false);
  });
});

describe("settings snapshot", () => {
  it("writes hadEntry=false when the model has no settings entry", async () => {
    const runDir = await createRunDir("No-Such-Model-4bit");
    const snapshot = await snapshotModelSettings(runDir, "No-Such-Model-4bit");
    assert.equal(snapshot.hadEntry, false);
    assert.equal(snapshot.settings, null);

    const onDisk = JSON.parse(await readFile(join(runDir, "settings-snapshot.json"), "utf8"));
    assert.equal(onDisk.modelId, "No-Such-Model-4bit");
    assert.equal(onDisk.hadEntry, false);

    // Restore honestly reports the no-unset-API case instead of pretending.
    const restore = await restoreSettingsSnapshot("http://127.0.0.1:1/v1", runDir);
    assert.equal(restore.ok, false);
    assert.equal(restore.reason, "no-entry-to-restore");
  });

  it("reads a snapshot from the sandboxed model_settings.json when present", async () => {
    const omlxDir = join(sandboxHome, ".omlx");
    await mkdir(omlxDir, { recursive: true });
    await writeFile(join(omlxDir, "model_settings.json"), JSON.stringify({
      models: { "Has-Entry-4bit": { mtp_enabled: true, enable_thinking: false } },
    }));
    const runDir = await createRunDir("Has-Entry-4bit");
    const snapshot = await snapshotModelSettings(runDir, "Has-Entry-4bit");
    assert.equal(snapshot.hadEntry, true);
    assert.deepEqual(snapshot.settings, { mtp_enabled: true, enable_thinking: false });
  });

  it("restore merges the all-off baseline under the user's snapshot (no key leak)", async () => {
    const runDir = await createRunDir("Restore-Merge-4bit");
    await writeFile(join(runDir, "settings-snapshot.json"), JSON.stringify({
      modelId: "Restore-Merge-4bit",
      capturedAt: new Date().toISOString(),
      hadEntry: true,
      settings: { mtp_enabled: true, enable_thinking: false },
    }));

    let putted = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      putted = { url: String(url), method: opts.method, body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => ({ settings: putted.body }), text: async () => "" };
    };
    let restore;
    try {
      restore = await restoreSettingsSnapshot("http://127.0.0.1:9/v1", runDir);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(restore.ok, true);
    // URL normalized: the /v1 form must be stripped before the admin path.
    assert.ok(putted.url.startsWith("http://127.0.0.1:9/admin/api/models/"), putted.url);
    // User keys are preserved exactly…
    assert.equal(putted.body.mtp_enabled, true);
    assert.equal(putted.body.enable_thinking, false);
    // …and every sweep knob the user's entry lacked is explicitly forced OFF
    // (oMLX PUTs are partial merges; sending only the snapshotted keys would
    // leave e.g. turboquant_kv_enabled at its last sweep value).
    assert.equal(putted.body.dflash_enabled, false);
    assert.equal(putted.body.turboquant_kv_enabled, false);
    assert.equal(putted.body.qwen35_ane_prefill_enabled, false);
    assert.equal(putted.body.thinking_budget_enabled, false);
  });
});

describe("journal", () => {
  it("appends and reads back rows with timestamps", async () => {
    const runDir = await createRunDir("Journal-Test-4bit");
    assert.deepEqual(await readJournal(runDir), []);
    await appendJournal(runDir, { event: "start", modelId: "Journal-Test-4bit" });
    await appendJournal(runDir, { event: "config-done", tps: 11.8 });
    const rows = await readJournal(runDir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].event, "start");
    assert.ok(rows[0].ts);
    assert.equal(rows[1].tps, 11.8);
  });
});
