// Hub benchmark-engine tests (Phase 4): the benchmark job (prepare slot →
// pi headless → chained capture/score), capture/score executor wiring, and
// the run/publish API contracts. Fully sandboxed like hub-jobs.test.mjs:
// MINIMAL_DIR/HOME point at temp dirs, a stub pi sits on PATH, and the
// benchmark gallery repo is a temp tree (benchmarks/ + runs/) wired in via
// config.json before any hub import.

import assert from "node:assert/strict";
import { after, test } from "node:test";
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

// Stub pi: writes the benchmark artifacts into the run dir (cwd) and exits 0.
// Visual runs produce index.html; the DS variant also writes summary.json.
const DS_SUMMARY = JSON.stringify({
  status: "no_difference",
  recommended_variant: "A",
  raw_stats: {
    p_value: 0.42,
    cohens_d: 0.01,
    mean_a: 30.2,
    mean_b: 30.4,
    completion_rate_a: 0.51,
    completion_rate_b: 0.52,
    srm_p_value: 0.9,
  },
});
writeFileSync(
  join(BIN, "pi"),
  `#!/bin/bash
echo '${DS_SUMMARY}' > summary.json
echo '<!doctype html><html><body>scene</body></html>' > index.html
echo 'pi-stub done'
exit 0\n`
);
chmodSync(join(BIN, "pi"), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;

// The stub gallery repo: benchmarks/ + runs/, linked via config.json.
const GALLERY = mkdtempSync(join(tmpdir(), "minimal-hub-gallery-"));
mkdirSync(join(GALLERY, "benchmarks"), { recursive: true });
mkdirSync(join(GALLERY, "runs"), { recursive: true });
writeFileSync(
  join(GALLERY, "benchmarks", "sakura.md"),
  "---\nid: sakura\ntitle: Sakura Tree\ndescription: Cherry blossom animation.\n---\n\nPaint a sakura tree.\n"
);
writeFileSync(
  join(GALLERY, "benchmarks", "ab-test-analysis.md"),
  "---\nid: ab-test-analysis\ntitle: A/B Test Production Analysis\ndescription: Full production A/B analysis.\n---\n\nAnalyze the A/B test.\n"
);
writeFileSync(join(DATA, "config.json"), JSON.stringify({ benchmarkRepoPath: GALLERY }));

const { JobStore } = await import("../src/hub/jobs/store.ts");
const { JobRunner } = await import("../src/hub/jobs/runner.ts");
const {
  benchmarkExecutor,
  captureExecutor,
  scoreExecutor,
} = await import("../src/hub/jobs/benchmark-executors.ts");
const { createApp } = await import("../src/hub/server.ts");

const dbPath = (name) => join(DATA, `${name}.db`);
const logDir = join(DATA, "logs");
const RUNS = join(GALLERY, "runs");

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

// Stub OpenAI-compatible model server (same shape as the hub-jobs test).
// Every stub server is tracked and closed after the whole file — a test
// that fails mid-way must never leak a listening server (one leak keeps
// the node --test child process alive and hangs the suite).
const stubServers = [];
after(() => { for (const s of stubServers) s.close(); });

async function stubModelServer() {
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    stubServers.push(server);
    resolve(server);
  }));
  return { server, port: server.address().port };
}

function saveProfile(id, port) {
  const dir = join(DATA, "profiles", id);
  mkdirSync(dir, { recursive: true });
  const profile = {
    id,
    label: `Stub ${id}`,
    backend: "llama-cpp",
    providerId: "llama-cpp",
    modelAlias: "stub-model",
    modelPath: `/tmp/${id}.gguf`,
    baseUrl: `http://127.0.0.1:${port}`,
    capabilities: { thinking: false },
    flags: { ctxSize: 4096, host: "127.0.0.1", port },
  };
  writeFileSync(join(dir, "profile.json"), JSON.stringify(profile));
  return profile;
}

// ── benchmark job: prepare slot → pi headless → chained follow-up ──────────

test("benchmark job (visual): writes the run slot, launches pi, chains capture", async () => {
  assert.equal(homedir(), HOME, "HOME sandbox not in effect — refusing to run");
  const { server, port } = await stubModelServer();
  saveProfile("bench-visual", port);

  const chained = [];
  const runner = newRunner("bench-visual", {
    benchmark: benchmarkExecutor({ piBin: join(BIN, "pi") }),
    capture: async (ctx) => {
      chained.push(ctx.job.payload);
      return { captured: 1 };
    },
  });

  const ref = `llama-cpp:${encodeURIComponent("/tmp/bench-visual.gguf")}`;
  const job = await runner.enqueue({
    type: "benchmark",
    ref,
    title: "Benchmark Sakura — Stub bench-visual",
    payload: { benchmarkId: "sakura" },
  });
  await waitFor(() => runner.get(job.id)?.status === "completed", 20_000);
  const done = runner.get(job.id);
  server.close();
  const log = readFileSync(done.logPath, "utf8");
  assert.equal(done.status, "completed", `benchmark failed: ${done.error}\n${log}`);

  // The chained capture job ran with the new run's identity.
  await waitFor(() => chained.length === 1);
  const { bench, slug, runId } = chained[0];
  assert.equal(bench, "sakura");
  const dir = join(RUNS, bench, slug, runId);
  assert.equal(done.metrics.runDirectory, dir);
  assert.ok(existsSync(join(dir, "metadata.json")));
  assert.ok(existsSync(join(dir, "prompt.md")));
  assert.ok(existsSync(join(dir, "index.html")));
  const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
  assert.equal(metadata.kind, "visual");
  assert.equal(metadata.status, "prepared"); // status flips on capture, not on launch
  assert.equal(metadata.benchmark.id, "sakura");
  assert.equal(metadata.model.slug, slug);
  assert.match(metadata.prompt ?? metadata.benchmark.prompt, /sakura tree/i);
  assert.equal(done.metrics.exitCode, 0);
});

test("benchmark job (data-science): chains score, which writes a real scorecard", async () => {
  const { server, port } = await stubModelServer();
  saveProfile("bench-ds", port);

  const runner = newRunner("bench-ds", {
    benchmark: benchmarkExecutor({ piBin: join(BIN, "pi") }),
    score: scoreExecutor(),
  });

  const ref = `llama-cpp:${encodeURIComponent("/tmp/bench-ds.gguf")}`;
  const job = await runner.enqueue({
    type: "benchmark",
    ref,
    title: "Benchmark A/B — Stub bench-ds",
    payload: { benchmarkId: "ab-test-analysis" },
  });
  await waitFor(() => runner.get(job.id)?.status === "completed", 20_000);
  const done = runner.get(job.id);
  assert.equal(done.status, "completed", `benchmark failed: ${done.error}`);

  // The chained score job completed and scored the run for real.
  const scoreId = runner.list().find((j) => j.type === "score")?.id;
  assert.ok(scoreId, "no score job was chained");
  await waitFor(() => ["completed", "failed"].includes(runner.get(scoreId).status));
  const scoreJob = runner.get(scoreId);
  assert.equal(scoreJob.status, "completed", `score failed: ${scoreJob.error}`);
  server.close();

  const { bench, slug, runId } = done.metrics;
  const dir = join(RUNS, bench, slug, runId);
  const scorecard = JSON.parse(readFileSync(join(dir, "scorecard.json"), "utf8"));
  assert.equal(typeof scorecard.earned, "number");
  assert.equal(typeof scorecard.total, "number");
  const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
  assert.equal(metadata.kind, "data-science");
  assert.equal(metadata.status, "completed"); // scoring flips DS run status
  assert.equal(scoreJob.metrics.total, scorecard.total);
});

test("benchmark job fails cleanly for an unknown benchmark id", async () => {
  saveProfile("bench-unknown", 1); // a saved profile exists; the benchmark id doesn't
  const runner = newRunner("bench-unknown", { benchmark: benchmarkExecutor({ piBin: join(BIN, "pi") }) });
  const job = await runner.enqueue({
    type: "benchmark",
    ref: `llama-cpp:${encodeURIComponent("/tmp/bench-unknown.gguf")}`,
    title: "nope",
    payload: { benchmarkId: "ghost-prompt" },
  });
  await waitFor(() => ["failed", "completed"].includes(runner.get(job.id).status));
  assert.equal(runner.get(job.id).status, "failed");
  assert.match(runner.get(job.id).error, /unknown benchmark/);
});

// ── capture executor wiring ─────────────────────────────────────────────────

test("capture executor resolves the run directory and passes options through", async () => {
  const runId = "2026-09-03T00-00-00-000Z";
  const dir = join(RUNS, "sakura", "stub-model", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "metadata.json"), JSON.stringify({ runId, kind: "visual" }));

  const seen = [];
  const runner = newRunner("capture-wiring", {
    capture: captureExecutor({
      capture: async (opts) => {
        seen.push(opts);
        return { captured: 1, skipped: 0, failed: 0 };
      },
    }),
  });
  const job = await runner.enqueue({
    type: "capture",
    title: "Capture sakura/stub-model",
    payload: { bench: "sakura", slug: "stub-model", runId, force: true },
  });
  await waitFor(() => ["completed", "failed"].includes(runner.get(job.id).status));
  const done = runner.get(job.id);
  assert.equal(done.status, "completed", `capture failed: ${done.error}`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].runDirectory, dir);
  assert.equal(seen[0].force, true);
  assert.equal(seen[0].runsRoot, RUNS);
  assert.equal(done.metrics.captured, 1);
});

// ── API contracts ───────────────────────────────────────────────────────────

test("run + publish endpoints: validation, enqueue, delete", async () => {
  const runner = newRunner("api", {
    capture: async () => ({ captured: 1 }),
    score: async () => ({ earned: 1, total: 1, pct: 100 }),
    "comparison-video": async () => ({ path: "/tmp/x.mp4", runCount: 2, layout: "1x2" }),
    export: async () => ({ runs: 0, published: true }),
    stub: async () => ({}),
  });
  const app = createApp({ runner });

  const runId = "2026-09-03T01-00-00-000Z";
  const dir = join(RUNS, "sakura", "api-model", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "metadata.json"), JSON.stringify({ runId, kind: "visual" }));

  // Benchmark launch endpoint: bad ref 400, unknown model 404.
  assert.equal(
    (await app.request("/api/models/not-a-ref/benchmark", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status,
    400
  );
  assert.equal(
    (await app.request("/api/models/omlx:ghost/benchmark", { method: "POST", body: JSON.stringify({ benchmarkId: "sakura" }), headers: { "Content-Type": "application/json" } })).status,
    404
  );

  // Run-scoped endpoints: unknown run 404, known run 201/200.
  assert.equal((await app.request(`/api/runs/sakura/api-model/${runId}/capture`, { method: "POST" })).status, 201);
  assert.equal((await app.request("/api/runs/sakura/api-model/missing/capture", { method: "POST" })).status, 404);
  assert.equal((await app.request(`/api/runs/sakura/api-model/${runId}/score`, { method: "POST" })).status, 201);
  assert.equal((await app.request("/api/runs/.hidden/api-model/x/capture", { method: "POST" })).status, 400);

  // Comparison video: 1 run 400, 2 runs 201.
  const post = (body) =>
    app.request("/api/runs/comparison-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post({ runs: [{ bench: "sakura", slug: "api-model", runId }] })).status,
    400
  );
  assert.equal(
    (await post({ runs: [{ bench: "sakura", slug: "a", runId: "r1" }, { bench: "sakura", slug: "b", runId: "r2" }] })).status,
    201
  );

  // Publish (dev mode: this repo is a git work tree) enqueues the export job.
  const published = await app.request("/api/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(published.status, 201);
  assert.equal((await published.json()).type, "export");

  // Delete the run: 200, then the directory is gone and a second call 404s.
  assert.equal((await app.request(`/api/runs/sakura/api-model/${runId}`, { method: "DELETE" })).status, 200);
  assert.ok(!existsSync(dir));
  assert.equal((await app.request(`/api/runs/sakura/api-model/${runId}`, { method: "DELETE" })).status, 404);
});
