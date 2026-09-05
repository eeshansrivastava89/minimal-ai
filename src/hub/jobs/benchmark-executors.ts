// Benchmark-family job executors: benchmark (prepare slot + pi headless,
// then chain), capture, score, comparison-video, export/publish. They reuse
// the CLI's prepareBenchmarkRun (same run-slot layout as today, zero
// migration) and benchmark-core's capture/scoring/export libs.

import { dirname, relative } from "node:path";

import { mkdir } from "node:fs/promises";

import { backendFor } from "../../backends.mjs";
import { DATA_DIR } from "../../config.mjs";
import { configuredHarness, harnessFor } from "../../harnesses.mjs";
import { stopOrUnload } from "../../process.mjs";
import { prepareBenchmarkRun } from "../../benchmark.mjs";

import { allBenchmarks, machineInfo, resolveRunsRoot } from "../api/data.ts";
import { parseModelRef } from "../api/model-ref.ts";
import { captureSingleRunMedia } from "../benchmark-core/capture-media.ts";
import { exportComparisonVideo } from "../benchmark-core/comparison-video.ts";
import { generateStaticExport } from "../benchmark-core/export.ts";
import { scoreDsRun } from "../benchmark-core/score-ds-run.ts";
import { baseProfileFor, ensureModelRunning } from "./executors.ts";
import type { JobContext } from "./runner.ts";

export interface RunRef {
  bench: string;
  slug: string;
  runId: string;
}

// ── launch (Run in browser: pi headless, owned by the runner) ────────────────

export interface LaunchOptions {
  piBin?: string; // test seam: stub pi binary
}

/** Stream pi's `--mode json` events into job-log lines: tool calls as they
 *  start/finish, assistant text as it types (flushed per newline). Non-JSON
 *  stdout (banners, stub bins) passes through untouched. */
function piEventLog() {
  let textBuf = "";
  let thinkingBuf = "";
  return (line: string): string | null => {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return line; // not an event line — log it raw
    }
    switch (ev.type) {
      case "session":
        return "[pi] session started";
      case "agent_start":
        return "[pi] agent started";
      case "tool_execution_start": {
        const args = ev.args ?? {};
        const detail =
          typeof args.command === "string" ? args.command.split("\n")[0].slice(0, 160)
          : typeof args.path === "string" ? args.path
          : typeof args.url === "string" ? args.url
          : typeof args.query === "string" ? args.query
          : typeof args.pattern === "string" ? args.pattern
          : "";
        return `[pi] → ${ev.toolName}${detail ? `: ${detail}` : ""}`;
      }
      case "tool_execution_end":
        return ev.isError ? `[pi] ✗ ${ev.toolName} failed` : null;
      case "message_update": {
        const delta = ev.assistantMessageEvent;
        // Model text streams as it types; thinking streams dimmed
        // ("… " prefix, like pi's TUI) as it thinks.
        if (delta?.type === "thinking_delta" && typeof delta.delta === "string") {
          thinkingBuf += delta.delta;
          const parts = thinkingBuf.split("\n");
          thinkingBuf = parts.pop() ?? "";
          const lines = parts.filter((l) => l.trim());
          return lines.length ? lines.map((l) => `[pi] … ${l.trim()}`).join("\n") : null;
        }
        if (delta?.type === "text_delta" && typeof delta.delta === "string") {
          textBuf += delta.delta;
          const parts = textBuf.split("\n");
          textBuf = parts.pop() ?? "";
          return parts.filter((l) => l.trim()).join("\n") || null;
        }
        return null;
      }
      case "message_end": {
        const out: string[] = [];
        if (thinkingBuf.trim()) out.push(`[pi] … ${thinkingBuf.trim()}`);
        if (textBuf.trim()) out.push(textBuf);
        thinkingBuf = "";
        textBuf = "";
        return out.length ? out.join("\n") : null;
      }
      case "agent_end":
        return "[pi] agent finished";
      default:
        return null;
    }
  };
}

/** The one headless launch path: server up → preflight → pi spawn (owned
 *  by the runner). Benchmark runs go through here — the deprecated
 *  Run-in-browser job used to share it. */
export async function runModelHeadless(
  ctx: JobContext,
  profile: any,
  opts: { piBin?: string; message?: string; thinking?: string; keepServer?: boolean; cwd: string }
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const backend = backendFor(profile.backend);
  ctx.log(`[hub] launching ${profile.label} (${backend.label})`);
  // Bring the model up (server + load + preflight) — the same path the
  // start job uses, minus the pi session that follows.
  await ensureModelRunning(ctx, profile);

  const harness = harnessFor((await configuredHarness()).id);
  if (!(await harness.detect())) throw new Error(`${harness.label} is not installed — npm install -g ${harness.npm}`);
  await harness.syncConfig(profile);

  const piBin = opts.piBin ?? harness.bin;
  const args = ["--model", `${profile.providerId}/${profile.modelAlias}`];
  const level = opts.thinking ?? profile.thinkingLevel;
  if (level) args.push("--thinking", level);
  if (opts.message) args.push(opts.message);
  // JSON mode streams live events (tool calls, text deltas) the job log
  // renders — plain text mode prints nothing until the run is over.
  args.unshift("--mode", "json");

  await mkdir(opts.cwd, { recursive: true });
  ctx.progress(null, "pi running");
  ctx.log(`[hub] ${piBin} ${args.join(" ")}`);
  const result = await ctx.spawnOwned(piBin, args, { cwd: opts.cwd, stdoutTransform: piEventLog() });

  const metrics = {
    exitCode: result.code,
    durationMs: Date.now() - started,
    piDurationMs: result.durationMs,
    keepServer: Boolean(opts.keepServer),
    workdir: opts.cwd,
  };
  if (!opts.keepServer) {
    ctx.log("[hub] unloading/stopping the server");
    await stopOrUnload(profile);
  }
  if (result.code !== 0) throw new Error(`pi exited with code ${result.code}`);
  return metrics;
}




async function galleryRoot(): Promise<{ runsRoot: string; root: string }> {
  const runsRoot = await resolveRunsRoot();
  if (!runsRoot) {
    throw new Error(
      "benchmark gallery repo not linked — clone local-llm-visual-benchmark (~/dev/local-llm-visual-benchmark) or set benchmarkRepoPath in config.json"
    );
  }
  return { runsRoot, root: dirname(runsRoot) };
}

// ── benchmark: prepare slot → launch pi in it → chain capture/score ────────

export function benchmarkExecutor(options: LaunchOptions = {}) {
  return async function benchmark(ctx: JobContext) {
    const ref = parseModelRef(ctx.job.ref ?? "");
    if (!ref) throw new Error("benchmark job is missing its model ref");
    const { benchmarkId, keepServer, thinking } = ctx.job.payload as {
      benchmarkId: string;
      keepServer?: boolean;
      thinking?: string;
    };
    const { profile } = await baseProfileFor(ref, false);
    if (!profile) throw new Error("no saved profile for this model — set it up first");

    const [benchmarks, gallery] = await Promise.all([allBenchmarks(), galleryRoot()]);
    const benchmark = benchmarks.find((b) => b.id === benchmarkId);
    if (!benchmark) throw new Error(`unknown benchmark: ${benchmarkId}`);

    ctx.progress(null, "preparing run slot");
    const runDirectory = await prepareBenchmarkRun({
      repoPath: gallery.root,
      benchmark,
      profile,
      harness: await configuredHarness(),
    });
    const [bench, slug, runId] = relative(gallery.runsRoot, runDirectory).split("/");
    ctx.log(`[hub] run slot: ${bench}/${slug}/${runId}`);
    ctx.progress(null, "run slot prepared");

    const metrics = await runModelHeadless(ctx, profile, {
      piBin: options.piBin,
      message: benchmark.prompt,
      thinking,
      keepServer,
      cwd: runDirectory,
    });

    // Chain the follow-up so the loop finishes without a second click:
    // visual runs get captured (which flips status to completed/failed),
    // data-science runs get scored (which writes the scorecard).
    const followUp =
      benchmark.kind === "data-science"
        ? { type: "score" as const, title: `Score ${bench}/${slug}` }
        : { type: "capture" as const, title: `Capture ${bench}/${slug}` };
    await ctx.enqueue({
      type: followUp.type,
      ref: ctx.job.ref,
      title: followUp.title,
      payload: { bench, slug, runId },
    });
    ctx.log(`[hub] queued ${followUp.type} job for the new run`);


    return { ...metrics, runDirectory, bench, slug, runId };
  };
}

// ── capture (Playwright: preview.* writes flip run status) ───────────────────

export interface CaptureOptions {
  capture?: typeof captureSingleRunMedia; // test seam
}

export function captureExecutor(options: CaptureOptions = {}) {
  return async function capture(ctx: JobContext) {
    const { bench, slug, runId, force } = ctx.job.payload as unknown as RunRef & { force?: boolean };
    const { runsRoot } = await galleryRoot();
    const runDirectory = `${runsRoot}/${bench}/${slug}/${runId}`;
    ctx.progress(null, "capturing preview + video");
    const result = await (options.capture ?? captureSingleRunMedia)({
      runsRoot,
      runDirectory,
      force: force ?? false,
      logger: { log: ctx.log, warn: ctx.log, error: ctx.log },
    });
    ctx.progress(null, `${result.captured} captured, ${result.skipped} skipped, ${result.failed} failed`);
    return { ...result, runs: undefined };
  };
}

// ── score (data-science runs: deterministic scorer → scorecard) ─────────────

export function scoreExecutor() {
  return async function score(ctx: JobContext) {
    const { bench, slug, runId } = ctx.job.payload as unknown as RunRef;
    const { runsRoot } = await galleryRoot();
    const runDirectory = `${runsRoot}/${bench}/${slug}/${runId}`;
    ctx.progress(null, "running deterministic scorer");
    const { scorecard } = await scoreDsRun({ runsRoot, runDirectory });
    ctx.progress(null, `scored ${scorecard.earned}/${scorecard.total} (${scorecard.pct}%)`);
    return { earned: scorecard.earned, total: scorecard.total, pct: scorecard.pct };
  };
}

// ── comparison video (2–6 captured runs → one ffmpeg grid) ──────────────────

export function comparisonVideoExecutor() {
  return async function comparisonVideo(ctx: JobContext) {
    const { runs } = ctx.job.payload as unknown as { runs: RunRef[] };
    const { runsRoot } = await galleryRoot();
    const runDirectories = runs.map((r) => `${runsRoot}/${r.bench}/${r.slug}/${r.runId}`);
    ctx.progress(null, "composing comparison video (ffmpeg)");
    const result = await exportComparisonVideo({
      runsRoot,
      runDirectories,
      outputRoot: `${DATA_DIR}/hub/comparison-exports`,
    });
    ctx.progress(null, `comparison video ready (${result.runCount} runs, ${result.layout})`);
    return { ...result };
  };
}

// ── export / publish (gallery snapshot; publish = commit + push, dev-gated) ──

export function exportExecutor() {
  return async function exportGallery(ctx: JobContext) {
    const { publish } = ctx.job.payload as { publish?: boolean };
    // The dev-mode backstop lives HERE, not only on /api/publish — the
    // generic jobs enqueue could otherwise reach this path on an installed
    // (non-git) copy and push a snapshot from a machine with no repo.
    if (publish && !(await machineInfo()).devMode) {
      throw new Error("publishing needs a git checkout (dev mode)");
    }
    const { runsRoot, root } = await galleryRoot();
    ctx.progress(null, "building gallery snapshot");
    const manifest = await generateStaticExport({
      benchmarkDirectory: `${root}/benchmarks`,
      runsRoot,
      publicExportDirectory: `${root}/public/export`,
    });
    ctx.log(`[hub] snapshot: ${manifest.runs.length} runs, ${manifest.benchmarks.length} benchmarks`);
    if (!publish) {
      ctx.progress(null, "snapshot built");
      return { runs: manifest.runs.length, published: false };
    }

    ctx.progress(null, "committing snapshot");
    const git = (args: string[]) => ctx.spawnOwned("git", args, { cwd: root });
    await git(["add", "public/export"]);
    const diff = await git(["diff", "--cached", "--quiet"]);
    if (diff.code === 0) {
      ctx.log("[hub] no changes since the last published snapshot");
    } else {
      const commit = await git(["commit", "-m", `Publish benchmark export ${new Date().toISOString()}`]);
      if (commit.code !== 0) throw new Error(`git commit exited with code ${commit.code}`);
      ctx.progress(null, "pushing");
      const push = await git(["push"]);
      if (push.code !== 0) throw new Error(`git push exited with code ${push.code}`);
    }
    ctx.progress(null, "published");
    return { runs: manifest.runs.length, published: true };
  };
}