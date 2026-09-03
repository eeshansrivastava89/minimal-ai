// Hub API contract tests — one per endpoint. Asserts response *shape*, not
// data, so the suite passes on a fresh machine (no backends, no profiles,
// no runs) and on a live one. Uses app.request directly: no port binding.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/hub/server.ts";
import { formatModelRef, parseModelRef } from "../src/hub/api/model-ref.ts";

const app = createApp();
const get = (path) => app.request(path);

test("ModelRef round-trips and rejects junk", () => {
  const ref = { backend: "omlx", id: "mlx-community/Qwen3-8B" };
  const formatted = formatModelRef(ref);
  assert.equal(formatted, "omlx:mlx-community%2FQwen3-8B");
  assert.deepEqual(parseModelRef(formatted), ref);
  assert.equal(parseModelRef("nonsense"), null);
  assert.equal(parseModelRef("bogus:x"), null);
  assert.equal(parseModelRef("omlx:"), null);
});

test("GET /api/machine → MachineInfo", async () => {
  const res = await get("/api/machine");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.version, "string");
  assert.equal(typeof body.devMode, "boolean");
  assert.equal(typeof body.chip, "string");
  assert.equal(typeof body.ramBytes, "number");
  assert.equal(typeof body.ramLabel, "string");
  assert.equal(typeof body.platform, "string");
});

test("GET /api/backends → BackendStatus[] (all three, any state)", async () => {
  const res = await get("/api/backends");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.map((b) => b.id).sort(), ["llama-cpp", "ollama", "omlx"]);
  for (const b of body) {
    assert.equal(typeof b.label, "string");
    assert.equal(typeof b.port, "number");
    assert.equal(typeof b.up, "boolean");
    assert.equal(typeof b.modelCount, "number");
  }
});

test("GET /api/models → ModelsResponse with valid refs", async () => {
  const res = await get("/api/models");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.backends));
  assert.ok(Array.isArray(body.models));
  for (const m of body.models) {
    assert.match(m.ref, /^(omlx|ollama|llama-cpp):.+/);
    assert.ok(["ready", "setup", "draft", "helper"].includes(m.status));
    assert.equal(typeof m.title, "string");
    assert.equal(typeof m.capabilities, "object");
  }
});

test("GET /api/models/:id → detail, 400 on bad ref, 404 on unknown", async () => {
  const bad = await get("/api/models/nonsense");
  assert.equal(bad.status, 400);
  const missing = await get("/api/models/omlx:definitely-not-a-model");
  assert.equal(missing.status, 404);

  const { models } = await (await get("/api/models")).json();
  if (models.length === 0) return; // fresh machine: nothing to detail
  const first = models[0];
  const res = await get(`/api/models/${first.ref}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ref, first.ref);
  assert.equal(body.backend, first.backend);
  assert.equal(typeof body.capabilities, "object");
});

test("GET /api/models/:id/setup → ref + nullable heatmap", async () => {
  const { models } = await (await get("/api/models")).json();
  if (models.length === 0) return;
  const res = await get(`/api/models/${models[0].ref}/setup`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ref, models[0].ref);
  assert.ok(body.heatmap === null || Array.isArray(body.heatmap.grid));
});

test("GET /api/models/:id/autotune → null or AutotuneRun", async () => {
  const { models } = await (await get("/api/models")).json();
  if (models.length === 0) return;
  const res = await get(`/api/models/${models[0].ref}/autotune`);
  assert.equal(res.status, 200);
  const body = await res.json();
  if (body !== null) {
    assert.equal(typeof body.runId, "string");
    assert.ok(Array.isArray(body.configs));
    assert.equal(typeof body.recommended, "string");
  }
});

test("GET /api/models/:id/runs and /logs → arrays", async () => {
  const { models } = await (await get("/api/models")).json();
  if (models.length === 0) return;
  const runs = await get(`/api/models/${models[0].ref}/runs`);
  assert.equal(runs.status, 200);
  assert.ok(Array.isArray(await runs.json()));
  const logs = await get(`/api/models/${models[0].ref}/logs`);
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(await logs.json()));
});

test("GET /api/runs → Run[] (empty without a runs tree)", async () => {
  const res = await get("/api/runs");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body));
  for (const r of body.slice(0, 5)) {
    assert.equal(typeof r.id, "string");
    assert.equal(typeof r.bench, "string");
    assert.equal(typeof r.status, "string");
  }
});

test("GET /api/media/run/... → 404 for missing, rejects bad names", async () => {
  const bad = await get("/api/media/run/b/s/r/..%2F..%2Fetc");
  assert.ok([400, 404].includes(bad.status));
  const missing = await get("/api/media/run/b/s/r/preview.png");
  assert.equal(missing.status, 404);
});

test("GET / → built client or 503 build hint", async () => {
  const res = await get("/");
  assert.ok([200, 503].includes(res.status));
});
