// Minimal Intelligence Hub — one localhost process serving the API and the
// built web client. Run: npm run hub (client must be built: npm run build:web).
// Localhost-only bind; no cloud, no accounts.

import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { extname, join, normalize, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";

import { deleteProfile } from "../profiles.mjs";
import { configuredHarness } from "../harnesses.mjs";
import { getHfTree, listGgufFiles } from "../huggingface.mjs";

import {
  allAutotune,
  allBenchmarks,
  allRuns,
  autotuneFor,
  catalog,
  logsFor,
  machineInfo,
  modelDetail,
  profileMatchesModel,
  resolveRunsRoot,
  runsFor,
  settingsInfo,
  setupInfo,
} from "./api/data.ts";
import { parseModelRef } from "./api/model-ref.ts";
import {
  BenchmarkLaunchDto,
  AutotuneStartDto,
  CaptureDto,
  ComparisonVideoDto,
  DownloadDto,
  ExportDto,
  JobEnqueueDto,
  RunRefDto,
  SetupFormDto,
} from "./api/dto.ts";
import { downloadExecutor, setupExecutor } from "./jobs/executors.ts";
import {
  benchmarkExecutor,
  captureExecutor,
  comparisonVideoExecutor,
  exportExecutor,
  scoreExecutor,
} from "./jobs/benchmark-executors.ts";
import { autotuneExecutor, omlxDefaultBaseUrl, probeForSweep } from "./jobs/autotune-executors.ts";
import { JobRunner } from "./jobs/runner.ts";
import { toJobDto } from "./jobs/store.ts";
import { deleteRunDirectory } from "./benchmark-core/runs.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST_DIR = join(REPO_ROOT, "src", "web", "dist");
const PORT = Number(process.env.HUB_PORT ?? 7700);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

// One static responder for the client and run media. Range-aware so media
// previews stream (plan: constrained media, HTTP range from day one).
async function fileResponse(absPath: string, rangeHeader: string | undefined): Promise<Response> {
  const s = await stat(absPath);
  const type = MIME[extname(absPath).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
  };

  const range = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, s.size - Number(range[2]));
    const end = range[1] ? Math.min(range[2] ? Number(range[2]) : s.size - 1, s.size - 1) : s.size - 1;
    if (start >= s.size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${s.size}` } });
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${s.size}`;
    headers["Content-Length"] = String(end - start + 1);
    // createReadStream owns its fd lifecycle (destroyed on end/error/cancel)
    // — a hand-rolled FileHandle leaks under aborts and Node 26 kills the
    // process when a leaked handle is collected.
    return new Response(Readable.toWeb(createReadStream(absPath, { start, end })) as unknown as BodyInit, {
      status: 206,
      headers,
    });
  }

  headers["Content-Length"] = String(s.size);
  return new Response(Readable.toWeb(createReadStream(absPath)) as unknown as BodyInit, {
    status: 200,
    headers,
  });
}

// Resolve a request path safely inside root; null = escape attempt.
function safeJoin(root: string, ...segments: string[]): string | null {
  const target = normalize(join(root, ...segments));
  const resolvedRoot = resolve(root);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) return null;
  return target;
}

export function createApp(opts: { runner?: JobRunner } = {}): Hono {
  const app = new Hono();
  const runner = opts.runner;

  app.onError((err, c) => {
    console.error("[hub]", err);
    return c.json({ error: err.message ?? "internal error" }, 500);
  });

  app.get("/api/machine", async (c) => c.json(await machineInfo()));

  app.get("/api/backends", async (c) => c.json((await catalog()).backends));

  app.get("/api/models", async (c) => {
    const { backends, models, profiles } = await catalog();
    return c.json({ backends, models, profiles });
  });

  app.get("/api/runs", async (c) => c.json(await allRuns()));

  app.get("/api/autotune", async (c) => c.json(await allAutotune()));

  app.get("/api/benchmarks", async (c) => c.json(await allBenchmarks()));

  function refParam(c: { req: { param: (k: string) => string } }) {
    const ref = parseModelRef(c.req.param("id"));
    return ref;
  }

  app.get("/api/settings", async (c) => c.json(await settingsInfo()));

  app.get("/api/models/:id", async (c) => {
    const ref = refParam(c);
    if (!ref) return c.json({ error: "invalid model ref (want backend:id)" }, 400);
    const detail = await modelDetail(ref);
    if (!detail) return c.json({ error: "model not found" }, 404);
    return c.json(detail);
  });

  app.get("/api/models/:id/setup", async (c) => {
    const ref = refParam(c);
    if (!ref) return c.json({ error: "invalid model ref (want backend:id)" }, 400);
    const info = await setupInfo(ref);
    if (!info) return c.json({ error: "model not found" }, 404);
    return c.json(info);
  });

  app.get("/api/models/:id/autotune", async (c) => {
    const ref = refParam(c);
    if (!ref) return c.json({ error: "invalid model ref (want backend:id)" }, 400);
    return c.json(await autotuneFor(ref)); // null = no sweeps yet
  });

  app.get("/api/models/:id/runs", async (c) => {
    const ref = refParam(c);
    if (!ref) return c.json({ error: "invalid model ref (want backend:id)" }, 400);
    return c.json(await runsFor(ref));
  });

  app.get("/api/models/:id/logs", async (c) => {
    const ref = refParam(c);
    if (!ref) return c.json({ error: "invalid model ref (want backend:id)" }, 400);
    return c.json(await logsFor(ref));
  });

  // Run media (previews/videos) streamed from the runs tree.
  app.get("/api/media/run/:bench/:slug/:runId/:file", async (c) => {
    const { bench, slug, runId, file } = c.req.param();
    if (!/^[a-zA-Z0-9._-]+$/.test(file)) return c.json({ error: "bad file" }, 400);
    const runsRoot = await resolveRunsRoot();
    if (!runsRoot) return c.json({ error: "runs not available" }, 404);
    const target = safeJoin(runsRoot, bench, slug, runId, file);
    if (!target || !existsSync(target)) return c.json({ error: "not found" }, 404);
    return fileResponse(target, c.req.header("Range"));
  });

  // ── Jobs (Phase 3) ───────────────────────────────────────────────────────

  const zodError = (c: { json: (b: unknown, s: 400) => Response }, issues: { message?: string }[]) =>
    c.json({ error: issues[0]?.message ?? "invalid body" }, 400);

  if (runner) {
    app.get("/api/jobs", (c) => c.json(runner.list()));

    // Live jobs snapshot: initial list + every change (SSE). Registered
    // BEFORE /api/jobs/:id so the literal path wins over the param route.
    app.get("/api/jobs/stream", (c) =>
      streamSSE(c, async (stream) => {
        const send = (jobs: unknown) => stream.writeSSE({ event: "jobs", data: JSON.stringify(jobs) });
        await send(runner.list());
        const unsub = runner.onJobs((jobs) => void send(jobs));
        stream.onAbort(unsub);
        while (!stream.aborted) {
          await stream.sleep(20_000);
          await stream.writeSSE({ event: "ping", data: "" });
        }
      })
    );

    app.get("/api/jobs/:id", (c) => {
      const job = runner.get(c.req.param("id"));
      if (!job) return c.json({ error: "job not found" }, 404);
      return c.json(toJobDto(job));
    });

    app.get("/api/jobs/:id/log", async (c) => {
      const log = await runner.readLog(c.req.param("id"));
      return c.text(log ?? "");
    });

    // Live jobs snapshot: initial list + every change (SSE) — see /api/jobs/stream above.

    // Live log tail for one job (SSE): existing content, then lines as written.
    app.get("/api/jobs/:id/stream", (c) => {
      const id = c.req.param("id");
      if (!runner.get(id)) return c.json({ error: "job not found" }, 404);
      return streamSSE(c, async (stream) => {
        const unsub = await runner.onLog(id, (line) => void stream.writeSSE({ event: "log", data: line }));
        stream.onAbort(unsub);
        while (!stream.aborted) {
          await stream.sleep(20_000);
          await stream.writeSSE({ event: "ping", data: "" });
        }
      });
    });

    app.post("/api/jobs", async (c) => {
      const body = await c.req.json().catch(() => null);
      const dto = JobEnqueueDto.safeParse(body);
      if (!dto.success) return zodError(c, dto.error.issues);
      const { type, ref, title, payload } = dto.data;
      const typed =
        type === "download"
          ? DownloadDto.safeParse(payload)
          : type === "benchmark"
            ? BenchmarkLaunchDto.safeParse(payload)
            : type === "capture"
              ? CaptureDto.safeParse(payload)
              : type === "score"
                ? RunRefDto.safeParse(payload)
                : type === "comparison-video"
                  ? ComparisonVideoDto.safeParse(payload)
                  : type === "export"
                    ? ExportDto.safeParse(payload)
                    : type === "autotune"
                      ? AutotuneStartDto.safeParse(payload)
                      : SetupFormDto.safeParse(payload);
      if (!typed.success) return zodError(c, typed.error.issues);
      const job = await runner.enqueue({
        type,
        ref: ref ?? null,
        title: title ?? `${type} job`,
        payload: typed.data as Record<string, unknown>,
      });
      return c.json(toJobDto(job), 201);
    });

    app.post("/api/jobs/:id/cancel", (c) => {
      if (!runner.cancel(c.req.param("id"))) return c.json({ error: "job cannot be cancelled" }, 409);
      return c.json({ cancelled: true });
    });

    app.post("/api/jobs/:id/restart", async (c) => {
      const job = await runner.restart(c.req.param("id"));
      if (!job) return c.json({ error: "job not found" }, 404);
      return c.json(toJobDto(job), 201);
    });
  }

  // ── Model write actions (Phase 3) ─────────────────────────────────────────

  app.get("/api/hf/quants", async (c) => {
    const repo = c.req.query("repo");
    const parsed = DownloadDto.safeParse({ repo, filename: null });
    if (!parsed.success) return zodError(c, parsed.error.issues);
    try {
      const tree = await getHfTree(parsed.data.repo);
      const files = await listGgufFiles(parsed.data.repo, { tree });
      return c.json({ repo: parsed.data.repo, files });
    } catch (err) {
      return c.json({ error: String((err as Error).message ?? err) }, 502);
    }
  });

  // Setup/reconfigure: a job (it touches the network for HF sampler recs
  // and the oMLX server), tracked like everything long-running.
  app.put("/api/models/:id/profile", async (c) => {
    if (!runner) return c.json({ error: "job runner not started" }, 503);
    const ref = refParam(c);
    if (!ref) return c.json({ error: "invalid model ref (want backend:id)" }, 400);
    const detail = await modelDetail(ref);
    if (!detail) return c.json({ error: "model not found" }, 404);
    const dto = SetupFormDto.safeParse(await c.req.json().catch(() => ({})));
    if (!dto.success) return zodError(c, dto.error.issues);
    const job = await runner.enqueue({
      type: "setup",
      ref: detail.ref,
      title: `${detail.profile ? "Reconfigure" : "Set up"} ${detail.profile?.label ?? detail.title}`,
      payload: dto.data as Record<string, unknown>,
    });
    return c.json(toJobDto(job), 201);
  });

  app.delete("/api/models/:id/profile", async (c) => {
    const ref = refParam(c);
    if (!ref) return c.json({ error: "invalid model ref (want backend:id)" }, 400);
    const { profiles } = await catalog();
    const profile = profiles.find((p) => profileMatchesModel(p, ref.backend, ref.id));
    if (!profile) return c.json({ error: "no saved profile for this model" }, 404);
    const harness = await configuredHarness();
    try {
      await harness.removeModel(profile);
    } catch {
      /* harness config already clean */
    }
    await deleteProfile(profile.id);
    return c.json({ removed: profile.id });
  });

  // ── Benchmark engine (Phase 4) ─────────────────────────────────────────────

  // Prepare + launch a benchmark run for a model: one job; the executor
  // writes the run slot, launches pi headless in it, and chains capture
  // (visual) or score (data-science) when the agent finishes.
  app.post("/api/models/:id/benchmark", async (c) => {
    if (!runner) return c.json({ error: "job runner not started" }, 503);
    const ref = refParam(c);
    if (!ref) return c.json({ error: "invalid model ref (want backend:id)" }, 400);
    const detail = await modelDetail(ref);
    if (!detail) return c.json({ error: "model not found" }, 404);
    const dto = BenchmarkLaunchDto.safeParse(await c.req.json().catch(() => ({})));
    if (!dto.success) return zodError(c, dto.error.issues);
    const benchmarks = await allBenchmarks();
    const bench = benchmarks.find((b) => b.id === dto.data.benchmarkId);
    if (!bench) return c.json({ error: `unknown benchmark: ${dto.data.benchmarkId}` }, 404);
    const job = await runner.enqueue({
      type: "benchmark",
      ref: detail.ref,
      title: `Benchmark ${bench.title} — ${detail.profile?.label ?? detail.title}`,
      payload: dto.data as Record<string, unknown>,
    });
    return c.json(toJobDto(job), 201);
  });

  // Run-scoped path params: safe segments + the run must exist on disk.
  // Returns the run directory, or an error Response the caller returns.
  const runDir = async (
    c: Context
  ): Promise<{ dir: string; runsRoot: string } | { error: Response }> => {
    const { bench, slug, runId } = c.req.param();
    for (const seg of [bench, slug, runId]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(seg)) {
        return { error: c.json({ error: "invalid run path segment" }, 400) };
      }
    }
    const runsRoot = await resolveRunsRoot();
    if (!runsRoot) return { error: c.json({ error: "runs not available" }, 404) };
    const target = safeJoin(runsRoot, bench, slug, runId);
    if (!target || !existsSync(join(target, "metadata.json"))) {
      return { error: c.json({ error: "run not found" }, 404) };
    }
    return { dir: target, runsRoot };
  };

  app.post("/api/runs/:bench/:slug/:runId/capture", async (c) => {
    if (!runner) return c.json({ error: "job runner not started" }, 503);
    const found = await runDir(c);
    if ("error" in found) return found.error;
    const { bench, slug, runId } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const force = typeof body?.force === "boolean" ? body.force : undefined;
    const job = await runner.enqueue({
      type: "capture",
      title: `Capture ${bench}/${slug}`,
      payload: { bench, slug, runId, ...(force !== undefined ? { force } : {}) },
    });
    return c.json(toJobDto(job), 201);
  });

  app.post("/api/runs/:bench/:slug/:runId/score", async (c) => {
    if (!runner) return c.json({ error: "job runner not started" }, 503);
    const found = await runDir(c);
    if ("error" in found) return found.error;
    const { bench, slug, runId } = c.req.param();
    const job = await runner.enqueue({
      type: "score",
      title: `Score ${bench}/${slug}`,
      payload: { bench, slug, runId },
    });
    return c.json(toJobDto(job), 201);
  });

  app.delete("/api/runs/:bench/:slug/:runId", async (c) => {
    const found = await runDir(c);
    if ("error" in found) return found.error;
    await deleteRunDirectory({ runsRoot: found.runsRoot, runDirectory: found.dir });
    return c.json({ deleted: c.req.param("runId") });
  });

  app.post("/api/runs/comparison-video", async (c) => {
    if (!runner) return c.json({ error: "job runner not started" }, 503);
    const dto = ComparisonVideoDto.safeParse(await c.req.json().catch(() => null));
    if (!dto.success) return zodError(c, dto.error.issues);
    const job = await runner.enqueue({
      type: "comparison-video",
      title: `Comparison video — ${dto.data.runs.length} runs`,
      payload: dto.data as Record<string, unknown>,
    });
    return c.json(toJobDto(job), 201);
  });

  // Publish (dev-mode gated): build the gallery snapshot, commit, push.
  // Hidden in the UI unless machine.devMode; refused here as the backstop.
  app.post("/api/publish", async (c) => {
    if (!runner) return c.json({ error: "job runner not started" }, 503);
    const machine = await machineInfo();
    if (!machine.devMode) {
      return c.json({ error: "publishing needs a git checkout (dev mode)" }, 403);
    }
    const dto = ExportDto.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!dto.success) return zodError(c, dto.error.issues);
    const job = await runner.enqueue({
      type: "export",
      title: "Publish benchmark gallery",
      payload: { publish: true },
    });
    return c.json(toJobDto(job), 201);
  });

  // ── Autotune (Phase 5) ─────────────────────────────────────────────────────

  // Plan preview: probe + grid, read-only (the MTPLX side-car import the real
  // sweep performs is skipped so a preview never mutates the server).
  app.get("/api/models/:id/autotune/plan", async (c) => {
    const ref = refParam(c);
    if (!ref) return c.json({ error: "invalid model ref (want backend:id)" }, 400);
    if (ref.backend !== "omlx") return c.json({ error: `autotune is an oMLX workflow — this model runs on ${ref.backend}` }, 400);
    const detail = await modelDetail(ref);
    if (!detail) return c.json({ error: "model not found" }, 404);
    const { profiles } = await catalog();
    const profile = profiles.find((p) => profileMatchesModel(p, ref.backend, ref.id));
    const baseUrl = profile?.baseUrl ?? omlxDefaultBaseUrl();
    try {
      const { model, rows } = await probeForSweep(baseUrl, ref.id, { importSidecar: false });
      return c.json({
        model: {
          id: model.id,
          displayName: model.displayName,
          mtpCompatible: model.mtpCompatible,
          dflashCompatible: model.dflashCompatible,
          thinkingDefault: model.thinkingDefault,
        },
        rows: rows.map((r: any) => ({
          id: r.id,
          label: r.label,
          family: r.family,
          settings: r.settings,
          tested: r.tested,
          ...(r.skipReason ? { skipReason: r.skipReason } : {}),
          ...(r.estMinutes ? { estMinutes: r.estMinutes } : {}),
        })),
        testedCount: rows.filter((r: any) => r.tested).length,
      });
    } catch (err) {
      return c.json({ error: String((err as Error).message ?? err) }, 502);
    }
  });

  // Start the sweep: one job — probe, snapshot, sweep, recommend, apply (or
  // discard), reclaim. Progress + the live matrix ride the jobs SSE.
  app.post("/api/models/:id/autotune", async (c) => {
    if (!runner) return c.json({ error: "job runner not started" }, 503);
    const ref = refParam(c);
    if (!ref) return c.json({ error: "invalid model ref (want backend:id)" }, 400);
    if (ref.backend !== "omlx") return c.json({ error: `autotune is an oMLX workflow — this model runs on ${ref.backend}` }, 400);
    const detail = await modelDetail(ref);
    if (!detail) return c.json({ error: "model not found" }, 404);
    const dto = AutotuneStartDto.safeParse(await c.req.json().catch(() => ({})));
    if (!dto.success) return zodError(c, dto.error.issues);
    const job = await runner.enqueue({
      type: "autotune",
      ref: detail.ref,
      title: `Autotune ${detail.profile?.label ?? detail.title}`,
      payload: dto.data as Record<string, unknown>,
    });
    return c.json(toJobDto(job), 201);
  });

  // Built web client + SPA fallback.
  app.get("*", async (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname);
    const target = safeJoin(DIST_DIR, path === "/" ? "index.html" : path);
    if (target && existsSync(target) && (await stat(target)).isFile()) {
      return fileResponse(target, c.req.header("Range"));
    }
    const index = join(DIST_DIR, "index.html");
    if (!existsSync(index)) {
      return c.text("Web client not built — run: npm run build:web", 503);
    }
    return fileResponse(index, undefined);
  });

  return app;
}

// Boot only when run directly (tests import createApp instead). The
// JobStore constructor runs boot recovery (orphaned running → interrupted).
function createRunner(): JobRunner {
  const runner = new JobRunner();
  runner.registerExecutor("download", downloadExecutor);
  runner.registerExecutor("setup", setupExecutor);
  runner.registerExecutor("benchmark", benchmarkExecutor());
  runner.registerExecutor("capture", captureExecutor());
  runner.registerExecutor("score", scoreExecutor());
  runner.registerExecutor("comparison-video", comparisonVideoExecutor());
  runner.registerExecutor("export", exportExecutor());
  runner.registerExecutor("autotune", autotuneExecutor());
  return runner;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const runner = createRunner();
  serve({ fetch: createApp({ runner }).fetch, hostname: "127.0.0.1", port: PORT }, (info) => {
    console.log(`Minimal Intelligence Hub → http://127.0.0.1:${info.port}`);
  });
}
