// Minimal Intelligence Hub — one localhost process serving the API and the
// built web client. Run: npm run hub (client must be built: npm run build:web).
// Localhost-only bind; no cloud, no accounts.

import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import {
  allAutotune,
  allBenchmarks,
  allRuns,
  autotuneFor,
  catalog,
  logsFor,
  machineInfo,
  modelDetail,
  resolveRunsRoot,
  runsFor,
  setupInfo,
} from "./api/data.ts";
import { parseModelRef } from "./api/model-ref.ts";

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
    const fh = await open(absPath, "r");
    const buf = Buffer.alloc(end - start + 1);
    await fh.read(buf, 0, buf.length, start);
    await fh.close();
    headers["Content-Range"] = `bytes ${start}-${end}/${s.size}`;
    headers["Content-Length"] = String(buf.length);
    return new Response(buf, { status: 206, headers });
  }

  headers["Content-Length"] = String(s.size);
  const fh = await open(absPath, "r");
  const stream = new ReadableStream({
    async pull(controller) {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) {
        controller.close();
        await fh.close();
      } else {
        controller.enqueue(buf.subarray(0, bytesRead));
      }
    },
    async cancel() {
      await fh.close();
    },
  });
  return new Response(stream as unknown as BodyInit, { status: 200, headers });
}

// Resolve a request path safely inside root; null = escape attempt.
function safeJoin(root: string, ...segments: string[]): string | null {
  const target = normalize(join(root, ...segments));
  const resolvedRoot = resolve(root);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) return null;
  return target;
}

export function createApp(): Hono {
  const app = new Hono();

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

// Boot only when run directly (tests import createApp instead).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  serve({ fetch: createApp().fetch, hostname: "127.0.0.1", port: PORT }, (info) => {
    console.log(`Minimal Intelligence Hub → http://127.0.0.1:${info.port}`);
  });
}
