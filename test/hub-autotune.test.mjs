// Hub autotune tests (Phase 5): the sweep job lifecycle (probe → grid →
// snapshot → sweep → recommendation → apply → reclaim), mid-sweep cancel
// (settings restored, lock released), and the plan/start API contracts.
//
// Runs against a stub oMLX server: admin models probe, echo-verified
// settings PUTs, and chat completions that append real "Chat completion:"
// lines to the sandboxed ~/.omlx/logs/server.log (the engine's throughput
// accounting). HOME + MINIMAL_DIR point at temp dirs before any import.

import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// ── sandbox ─────────────────────────────────────────────────────────────────
const DATA = mkdtempSync(join(tmpdir(), "minimal-hub-data-"));
const HOME = mkdtempSync(join(tmpdir(), "minimal-hub-home-"));
process.env.MINIMAL_DIR = DATA;
process.env.HOME = HOME;
// The stub oMLX server writes its throughput log here (serverLogPath()).
mkdirSync(join(HOME, ".omlx", "logs"), { recursive: true });
const SERVER_LOG = join(HOME, ".omlx", "logs", "server.log");
// A model on disk so the catalog (scanOmlxModelSizes) finds it for the API tests.
const MODEL_ID = "Qwen3.5-4B-Stub";
const MLX_DIR = join(HOME, ".omlx", "models", MODEL_ID);
mkdirSync(MLX_DIR, { recursive: true });
writeFileSync(join(MLX_DIR, "config.json"), JSON.stringify({ model_type: "qwen3", arch: "qwen3" }));
writeFileSync(join(MLX_DIR, "model.safetensors"), "stub");

const { JobStore } = await import("../src/hub/jobs/store.ts");
const { JobRunner } = await import("../src/hub/jobs/runner.ts");
const { autotuneExecutor } = await import("../src/hub/jobs/autotune-executors.ts");
const { createApp } = await import("../src/hub/server.ts");

const dbPath = (name) => join(DATA, `${name}.db`);
const logDir = join(DATA, "logs");

function waitFor(predicate, timeoutMs = 20_000, stepMs = 25) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await predicate()) return resolve();
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

function newRunner(name, executors = {}) {
  const runner = new JobRunner({ store: new JobStore(dbPath(name), logDir) });
  for (const [type, exec] of Object.entries(executors)) runner.registerExecutor(type, exec);
  return runner;
}

// ── stub oMLX server ───────────────────────────────────────────────────────

let completionsDelayMs = 0;
let putSettings = []; // every settings PUT (body) — for restore/apply assertions
let tpsCounter = 40;

function stubModel(loaded = false) {
  return {
    id: MODEL_ID,
    display_name: MODEL_ID,
    model_path: MLX_DIR,
    loaded,
    is_loading: false,
    estimated_size: 4e9,
    estimated_size_formatted: "4.00 GB",
    engine_type: "batched",
    thinking_default: false,
    mtp_compatible: true,
    dflash_compatible: false,
    settings: {},
  };
}

function startOmlxStub() {
  const server = createServer((req, res) => {
    const url = req.url;
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.endsWith("/admin/api/models")) {
      return send(200, { models: [stubModel(), { id: "MarkItDown", loaded: true, engine_type: "markitdown" }] });
    }
    if (req.method === "GET" && url.endsWith("/v1/models")) {
      return send(200, { data: [{ id: MODEL_ID }] }); // serverReady probes this
    }
    if (req.method === "PUT" && /\/admin\/api\/models\/[^/]+\/settings$/.test(url)) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const settings = JSON.parse(body);
        putSettings.push(settings);
        send(200, { settings }); // echo — putOmlxModelSettings verifies against this
      });
      return;
    }
    if (req.method === "POST" && url.endsWith("/v1/chat/completions")) {
      setTimeout(() => {
        tpsCounter += 3.7; // every config measures slightly faster than vanilla
        appendFileSync(
          SERVER_LOG,
          `Chat completion: model=${MODEL_ID}, 170 tokens in ${(170 / tpsCounter).toFixed(2)}s (${tpsCounter.toFixed(1)} tok/s), prompt: 12, finish_reason=stop, max_tokens=300, request_max_tokens=300\n`
        );
        send(200, { choices: [{ message: { content: "ok" } }] });
      }, completionsDelayMs);
      return;
    }
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function saveOmlxProfile(id, port) {
  const dir = join(DATA, "profiles", id);
  mkdirSync(dir, { recursive: true });
  const profile = {
    id,
    label: `Stub ${id}`,
    backend: "omlx",
    providerId: "omlx",
    modelAlias: MODEL_ID,
    omlxModel: MODEL_ID,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    capabilities: {},
  };
  writeFileSync(join(dir, "profile.json"), JSON.stringify(profile));
  return profile;
}

const exec = (opts = {}) =>
  autotuneExecutor({
    reclaim: async (ctx) => ctx.log("[test] reclaim skipped"),
    ...opts,
  });

// ── lifecycle ───────────────────────────────────────────────────────────────

test("autotune job: sweep → journal → recommendation → apply → reclaim", async () => {
  assert.equal(homedir(), HOME, "HOME sandbox not in effect — refusing to run");
  const server = await startOmlxStub();
  const port = server.address().port;
  saveOmlxProfile("auto-stub", port);

  const runner = newRunner("autotune-lifecycle", { autotune: exec() });
  const ref = `omlx:${encodeURIComponent(MODEL_ID)}`;
  const job = await runner.enqueue({
    type: "autotune",
    ref,
    title: `Autotune ${MODEL_ID}`,
    payload: { apply: true },
  });
  await waitFor(() => ["completed", "failed"].includes(runner.get(job.id).status), 60_000);
  const done = runner.get(job.id);
  const log = readFileSync(done.logPath, "utf8");
  server.close();

  assert.equal(done.status, "completed", `autotune failed: ${done.error}\n${log}`);
  const metrics = done.metrics;
  assert.ok(metrics.total >= 5, "expected a real grid");
  assert.equal(metrics.results.length, metrics.total);
  assert.ok(metrics.recommendation, "no recommendation");
  assert.equal(metrics.applied, true);
  assert.match(log, /applied/);
  assert.match(log, /reclaim skipped/);

  // Journal + optimal.json landed where autotuneFor() reads them.
  const slugDir = join(DATA, "autotune");
  const { readdir } = await import("node:fs/promises");
  const entries = existsSync(slugDir) ? await readdir(slugDir, { withFileTypes: true }) : [];
  const slugName = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().at(-1);
  assert.ok(slugName, "no autotune run dir");
  const runs = await readdir(join(slugDir, slugName), { withFileTypes: true });
  const runDir = join(slugDir, slugName, runs.filter((e) => e.isDirectory()).map((e) => e.name).sort().at(-1));
  assert.ok(existsSync(join(runDir, "optimal.json")), "no optimal.json");
  const journal = readFileSync(join(runDir, "sweep.jsonl"), "utf8");
  assert.ok(journal.includes("config-done"), "journal has no config rows");

  // The recommendation was PUT (echo-verified) — the apply PUT is the last one.
  assert.ok(putSettings.length >= metrics.total, "grid PUTs happened");
  const last = putSettings[putSettings.length - 1];
  assert.equal(last.mtp_enabled, false);
  assert.equal(last.enable_thinking, false);

  // Lock released.
  assert.ok(!existsSync(join(slugDir, "autotune.lock")), "lock not released");
});

test("autotune cancel mid-sweep: restores settings, releases lock, job cancelled", async () => {
  const server = await startOmlxStub();
  const port = server.address().port;
  saveOmlxProfile("auto-cancel", port);
  // Slow completions so the cancel lands between configs.
  completionsDelayMs = 1500;
  putSettings = [];

  const runner = newRunner("autotune-cancel", { autotune: exec() });
  const ref = `omlx:${encodeURIComponent(MODEL_ID)}`;
  const job = await runner.enqueue({
    type: "autotune",
    ref,
    title: `Autotune ${MODEL_ID}`,
    payload: { apply: true },
  });

  // Wait for the live matrix to appear (metrics.plan set), then cancel.
  await waitFor(() => {
    const j = runner.get(job.id);
    return j.status === "running" && j.metrics && j.metrics.plan;
  }, 30_000);
  assert.ok(runner.cancel(job.id));
  await waitFor(() => runner.get(job.id).status === "cancelled", 60_000);
  const done = runner.get(job.id);
  completionsDelayMs = 0;
  server.close();
  const log = readFileSync(done.logPath, "utf8");

  assert.equal(done.status, "cancelled");
  assert.equal(done.error, null);
  // Cancel discards: settings restore ran (no-entry → all-off baseline PUT).
  assert.match(log, /restoring original settings|no prior settings entry|original settings restored/);
  // Lock released even on cancel.
  assert.ok(!existsSync(join(DATA, "autotune", "autotune.lock")), "lock not released after cancel");
});

test("autotune job refuses non-omlx backends", async () => {
  const runner = newRunner("autotune-backend", { autotune: exec() });
  const job = await runner.enqueue({
    type: "autotune",
    ref: `llama-cpp:${encodeURIComponent("/tmp/nope.gguf")}`,
    title: "bad backend",
    payload: {},
  });
  await waitFor(() => ["failed", "completed"].includes(runner.get(job.id).status));
  const done = runner.get(job.id);
  assert.equal(done.status, "failed");
  assert.match(done.error, /omlx workflow|no saved profile/);
});

// ── API contracts ───────────────────────────────────────────────────────────

test("autotune plan + start endpoints validate and enqueue", async () => {
  const server = await startOmlxStub();
  const port = server.address().port;
  saveOmlxProfile("auto-api", port);

  const runner = newRunner("autotune-api", { autotune: async (ctx) => {
    ctx.progress(100, "stubbed");
    return {};
  } });
  const app = createApp({ runner });
  const ref = `omlx:${encodeURIComponent(MODEL_ID)}`;

  // Wrong backend → 400.
  const gguf = await app.request(`/api/models/llama-cpp:${encodeURIComponent("/tmp/x.gguf")}/autotune/plan`);
  assert.equal(gguf.status, 400);

  // Plan: probe + grid, read-only.
  const planRes = await app.request(`/api/models/${encodeURIComponent(ref)}/autotune/plan`);
  assert.equal(planRes.status, 200);
  const plan = await planRes.json();
  assert.equal(plan.model.id, MODEL_ID);
  assert.ok(Array.isArray(plan.rows) && plan.rows.length >= 5);
  assert.equal(plan.testedCount, plan.rows.filter((r) => r.tested).length);

  // Start: Zod body (bad type 400), enqueues 201.
  assert.equal(
    (await app.request(`/api/models/${encodeURIComponent(ref)}/autotune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apply: "yes" }),
    })).status,
    400
  );
  const started = await app.request(`/api/models/${encodeURIComponent(ref)}/autotune`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apply: true }),
  });
  assert.equal(started.status, 201);
  const job = await started.json();
  assert.equal(job.type, "autotune");
  assert.equal(job.ref, ref);
  server.close();
});