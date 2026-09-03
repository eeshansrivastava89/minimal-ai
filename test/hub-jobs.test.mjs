// Hub job-runner tests (Phase 3): SQLite store + boot recovery, runner
// lifecycle (enqueue → progress → metrics → completed), cancel/abort with
// child-process ownership, restart, and launch read-back (exit code +
// metrics from a real spawned stub pi against a stub model server).
//
// Runs fully sandboxed: MINIMAL_DIR/HOME point at temp dirs and a stub `pi`
// sits on PATH before any hub import (config.mjs snapshots the env).

import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// ── sandbox ─────────────────────────────────────────────────────────────────
const DATA = mkdtempSync(join(tmpdir(), "minimal-hub-data-"));
const HOME = mkdtempSync(join(tmpdir(), "minimal-hub-home-"));
const BIN = mkdtempSync(join(tmpdir(), "minimal-hub-bin-"));
process.env.MINIMAL_DIR = DATA;
process.env.HOME = HOME;
writeFileSync(
  join(BIN, "pi"),
  "#!/bin/bash\necho 'pi-stub: launched'\necho 'pi-stub done'\nexit 0\n"
);
chmodSync(join(BIN, "pi"), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;

const { JobStore } = await import("../src/hub/jobs/store.ts");
const { JobRunner } = await import("../src/hub/jobs/runner.ts");
const { launchExecutor, buildTerminalScript, setupExecutor } = await import("../src/hub/jobs/executors.ts");
const { createApp } = await import("../src/hub/server.ts");

const dbPath = (name) => join(DATA, `${name}.db`);
const logDir = join(DATA, "logs");

function waitFor(predicate, timeoutMs = 15_000, stepMs = 25) {
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

// ── store: boot recovery ────────────────────────────────────────────────────

test("JobStore boot recovery flips orphaned running rows to interrupted", () => {
  const path = dbPath("boot");
  const s1 = new JobStore(path, logDir);
  s1.insert({
    id: "orphan",
    type: "launch",
    ref: null,
    title: "was running when the hub died",
    payload: { keep: true },
    createdAt: new Date().toISOString(),
    status: "running",
  });
  s1.insert({
    id: "queued-one",
    type: "download",
    ref: null,
    title: "still queued",
    payload: {},
    createdAt: new Date().toISOString(),
  });
  const s2 = new JobStore(path, logDir);
  assert.equal(s2.get("orphan").status, "interrupted");
  assert.equal(s2.get("orphan").message, "hub restarted — job not resumed");
  // queued rows are untouched — they run on the next pump.
  assert.equal(s2.get("queued-one").status, "queued");
});

// ── runner lifecycle ────────────────────────────────────────────────────────

test("runner: enqueue → run → progress → metrics → completed, with log file", async () => {
  const runner = newRunner("lifecycle", {
    stub: async (ctx) => {
      ctx.log("working");
      ctx.progress(50, "halfway");
      await new Promise((r) => setTimeout(r, 30));
      return { answer: 42 };
    },
  });
  const events = [];
  runner.onJobs((jobs) => events.push(jobs));
  const job = await runner.enqueue({ type: "stub", title: "stub job", payload: { x: 1 } });
  assert.equal(job.status, "queued");
  await waitFor(() => runner.get(job.id).status === "completed");
  const done = runner.get(job.id);
  assert.equal(done.progress, 100);
  assert.equal(done.metrics.answer, 42);
  assert.equal(done.ref, null);
  const log = readFileSync(done.logPath, "utf8");
  assert.match(log, /working/);
  assert.match(log, /job completed after/);
  // jobs notifications fired along the way (initial + transitions)
  assert.ok(events.length >= 2);
});

test("runner: failing executor records status failed + error", async () => {
  const runner = newRunner("failure", {
    stub: async () => {
      throw new Error("boom");
    },
  });
  const job = await runner.enqueue({ type: "stub", title: "fails", payload: {} });
  await waitFor(() => runner.get(job.id).status === "failed");
  assert.equal(runner.get(job.id).error, "boom");
});

test("runner: cancel kills the owned child and marks cancelled", async () => {
  const runner = newRunner("cancel", {
    stub: async (ctx) => {
      ctx.progress(10, "spawning");
      await ctx.spawnOwned("sleep", ["30"]);
      return {};
    },
  });
  const job = await runner.enqueue({ type: "stub", title: "sleeper", payload: {} });
  await waitFor(() => runner.get(job.id).status === "running");
  assert.ok(runner.cancel(job.id));
  await waitFor(() => runner.get(job.id).status === "cancelled", 8000);
  const done = runner.get(job.id);
  assert.equal(done.status, "cancelled");
  assert.equal(done.error, null);
});

test("runner: queued jobs run serially and cancel-before-start works", async () => {
  const order = [];
  const runner = newRunner("serial", {
    stub: async (ctx) => {
      order.push(`start:${ctx.job.id}`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`end:${ctx.job.id}`);
    },
  });
  const a = await runner.enqueue({ type: "stub", title: "a", payload: {} });
  const b = await runner.enqueue({ type: "stub", title: "b", payload: {} });
  assert.ok(runner.cancel(b.id)); // still queued → cancelled without running
  await waitFor(() => runner.get(a.id).status === "completed");
  assert.equal(runner.get(b.id).status, "cancelled");
  assert.deepEqual(order, [`start:${a.id}`, `end:${a.id}`]);
});

test("runner: restart copies type/ref/payload into a fresh queued job", async () => {
  const runner = newRunner("restart", {
    stub: async () => ({}),
  });
  const job = await runner.enqueue({
    type: "stub",
    ref: "omlx:test-model",
    title: "original",
    payload: { a: 1 },
  });
  await waitFor(() => runner.get(job.id).status === "completed");
  const again = await runner.restart(job.id);
  assert.notEqual(again.id, job.id);
  assert.equal(again.type, job.type);
  assert.equal(again.ref, job.ref);
  assert.deepEqual(again.payload, job.payload);
  assert.equal(again.status, "queued");
  assert.equal(await runner.restart("nope"), null);
});

// ── launch read-back ────────────────────────────────────────────────────────

test("launch executor: server chain → pi spawn → exit-code read-back in metrics", async () => {
  assert.equal(homedir(), HOME, "HOME sandbox not in effect — refusing to run");

  // Stub OpenAI-compatible server: /models + /chat/completions.
  const server = createServer((req, res) => {
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
    } else if (req.url.endsWith("/chat/completions")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  // A saved llama.cpp profile pointing at the stub server.
  const profilesDir = join(DATA, "profiles", "stub-llama");
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(
    join(profilesDir, "profile.json"),
    JSON.stringify({
      id: "stub-llama",
      label: "Stub GGUF",
      backend: "llama-cpp",
      providerId: "llama-cpp",
      modelAlias: "stub-model",
      modelPath: "/tmp/stub.gguf",
      baseUrl: `http://127.0.0.1:${port}`,
      capabilities: { thinking: false },
      flags: { ctxSize: 4096, host: "127.0.0.1", port },
    })
  );

  const runner = newRunner("launch", {
    launch: launchExecutor({ piBin: join(BIN, "pi") }),
  });
  const ref = `llama-cpp:${encodeURIComponent("/tmp/stub.gguf")}`;
  const job = await runner.enqueue({
    type: "launch",
    ref,
    title: "Run Stub GGUF",
    payload: { message: "say hi" },
  });
  await waitFor(() => ["completed", "failed"].includes(runner.get(job.id).status), 20_000);
  const done = runner.get(job.id);
  const log = readFileSync(done.logPath, "utf8");
  server.close();

  assert.equal(done.status, "completed", `launch failed: ${done.error}\n${log}`);
  assert.equal(done.metrics.exitCode, 0);
  assert.equal(done.metrics.piDurationMs > 0, true);
  assert.match(log, /preflight ok/);
  assert.match(log, /pi-stub: launched/);
  assert.match(log, /pi-stub done/);
});

test("setup executor: form overrides land on the saved profile", async () => {
  // Self-contained seed: a saved llama.cpp profile the form overrides.
  const profilesDir = join(DATA, "profiles", "stub-setup");
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(
    join(profilesDir, "profile.json"),
    JSON.stringify({
      id: "stub-setup",
      label: "Setup Stub",
      backend: "llama-cpp",
      providerId: "llama-cpp",
      modelAlias: "setup-model",
      modelPath: "/tmp/setup-stub.gguf",
      baseUrl: "http://127.0.0.1:1",
      capabilities: { thinking: false },
      flags: { ctxSize: 4096, host: "127.0.0.1", port: 1 },
    })
  );
  const runner = newRunner("setup", { setup: setupExecutor });
  const ref = `llama-cpp:${encodeURIComponent("/tmp/setup-stub.gguf")}`;
  const job = await runner.enqueue({
    type: "setup",
    ref,
    title: "Reconfigure Stub GGUF",
    payload: {
      ctxSize: 8192,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      nGpuLayers: 99,
      samplers: { temperature: 0.6, topP: 0.95 },
      batchSize: 512,
      parallel: 2,
      flashAttention: true,
      jinja: true,
      mtp: false,
      vision: false,
      thinkingDefaults: false,
      thinkingLevel: "low",
    },
  });
  await waitFor(() => ["completed", "failed"].includes(runner.get(job.id).status));
  const done = runner.get(job.id);
  assert.equal(done.status, "completed", `setup failed: ${done.error}`);
  assert.equal(done.metrics.profileId, "stub-setup");
  assert.equal(done.metrics.created, false);
  const saved = JSON.parse(readFileSync(join(profilesDir, "profile.json"), "utf8"));
  assert.equal(saved.flags.ctxSize, 8192);
  assert.equal(saved.flags.cacheTypeK, "q8_0");
  assert.equal(saved.flags.cacheTypeV, "q8_0");
  assert.equal(saved.flags.parallel, 2);
  assert.equal(saved.flags.temperature, 0.6);
  assert.equal(saved.thinkingLevel, "low");
  assert.equal(saved.flags.flashAttention, "on");
});

test("launch executor without a profile fails with a setup hint", async () => {
  const runner = newRunner("launch-noprofile", {
    launch: launchExecutor({ piBin: join(BIN, "pi") }),
  });
  const ref = `llama-cpp:${encodeURIComponent("/tmp/never-scanned.gguf")}`;
  const job = await runner.enqueue({ type: "launch", ref, title: "no profile", payload: {} });
  await waitFor(() => ["completed", "failed"].includes(runner.get(job.id).status));
  const done = runner.get(job.id);
  assert.equal(done.status, "failed");
  assert.match(done.error, /no saved profile|model not found/);
});

test("buildTerminalScript generates a pi script (managed: no server block)", async () => {
  const script = await buildTerminalScript({
    id: "stub-omlx",
    label: "Stub oMLX",
    backend: "omlx",
    providerId: "omlx",
    modelAlias: "stub-mlx",
  });
  assert.ok(script.startsWith("#!/bin/bash"));
  assert.match(script, /pi --model omlx\/stub-mlx/);
  assert.ok(!script.includes("SERVER_PID"), "managed backends must not start a server");
  // The pi config sync landed inside the sandboxed HOME, not the real one.
  assert.ok(existsSync(join(HOME, ".pi", "agent", "models.json")));
});

// ── API contracts (Zod DTOs at the write seam) ─────────────────────────────

test("POST /api/jobs validates the typed payload (400s + 201)", async () => {
  const runner = newRunner("api", { stub: async () => ({}) });
  const app = createApp({ runner });
  const post = (body) =>
    app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  assert.equal((await post({ type: "bogus", payload: {} })).status, 400);
  assert.equal((await post({ type: "download", payload: { repo: "not a repo" } })).status, 400);
  assert.equal((await post({ type: "launch", payload: { thinking: "ultra" } })).status, 400);
  assert.equal(
    (await post({ type: "launch", payload: { message: "hi", keepServer: true } })).status,
    201
  );
  const res = await post({
    type: "launch",
    ref: "omlx:test",
    title: "queued launch",
    payload: {},
  });
  assert.equal(res.status, 201);
  const job = await res.json();
  assert.equal(job.status, "queued");
  assert.equal(job.ref, "omlx:test");
  // logPath must not leak through the DTO
  assert.equal("logPath" in job, false);
});

test("GET /api/jobs lists; cancel/restart endpoints behave", async () => {
  const runner = newRunner("api2", { stub: async () => ({}) });
  const app = createApp({ runner });
  const job = await runner.enqueue({ type: "stub", title: "listed", payload: {} });

  const list = await (await app.request("/api/jobs")).json();
  assert.ok(Array.isArray(list) && list.some((j) => j.id === job.id));
  assert.equal((await app.request(`/api/jobs/${job.id}/log`)).status, 200);
  assert.equal((await app.request("/api/jobs/missing/log")).status, 200); // empty text, unknown job

  const restarted = await (
    await app.request(`/api/jobs/${job.id}/restart`, { method: "POST" })
  ).json();
  assert.equal(restarted.status, "queued");
  assert.notEqual(restarted.id, job.id);
  assert.equal((await app.request("/api/jobs/missing/restart", { method: "POST" })).status, 404);
});