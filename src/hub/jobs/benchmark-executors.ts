// Benchmark-family job executors: benchmark (prepare slot + pi headless,
// then chain), capture, score, comparison-video, export/publish. They reuse
// the CLI's prepareBenchmarkRun (same run-slot layout as today, zero
// migration) and benchmark-core's capture/scoring/export libs.

import { dirname, relative } from "node:path";

import { DATA_DIR } from "../../config.mjs";
import { prepareBenchmarkRun } from "../../benchmark.mjs";
import { configuredHarness } from "../../harnesses.mjs";

import { allBenchmarks, resolveRunsRoot } from "../api/data.ts";
import { parseModelRef } from "../api/model-ref.ts";
import { captureSingleRunMedia } from "../benchmark-core/capture-media.ts";
import { exportComparisonVideo } from "../benchmark-core/comparison-video.ts";
import { generateStaticExport } from "../benchmark-core/export.ts";
import { scoreDsRun } from "../benchmark-core/score-ds-run.ts";
import { baseProfileFor, runModelHeadless, type LaunchOptions } from "./executors.ts";
import type { JobContext } from "./runner.ts";

export interface RunRef {
  bench: string;
  slug: string;
  runId: string;
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

    ctx.progress(5, "preparing run slot");
    const runDirectory = await prepareBenchmarkRun({
      repoPath: gallery.root,
      benchmark,
      profile,
      harness: await configuredHarness(),
    });
    const [bench, slug, runId] = relative(gallery.runsRoot, runDirectory).split("/");
    ctx.log(`[hub] run slot: ${bench}/${slug}/${runId}`);
    ctx.progress(10, "run slot prepared");

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

    ctx.progress(100, "agent run complete");
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
    ctx.progress(20, "capturing preview + video");
    const result = await (options.capture ?? captureSingleRunMedia)({
      runsRoot,
      runDirectory,
      force: force ?? false,
      logger: { log: ctx.log, warn: ctx.log, error: ctx.log },
    });
    ctx.progress(100, `${result.captured} captured, ${result.skipped} skipped, ${result.failed} failed`);
    return { ...result, runs: undefined };
  };
}

// ── score (data-science runs: deterministic scorer → scorecard) ─────────────

export function scoreExecutor() {
  return async function score(ctx: JobContext) {
    const { bench, slug, runId } = ctx.job.payload as unknown as RunRef;
    const { runsRoot } = await galleryRoot();
    const runDirectory = `${runsRoot}/${bench}/${slug}/${runId}`;
    ctx.progress(30, "running deterministic scorer");
    const { scorecard } = await scoreDsRun({ runsRoot, runDirectory });
    ctx.progress(100, `scored ${scorecard.earned}/${scorecard.total} (${scorecard.pct}%)`);
    return { earned: scorecard.earned, total: scorecard.total, pct: scorecard.pct };
  };
}

// ── comparison video (2–6 captured runs → one ffmpeg grid) ──────────────────

export function comparisonVideoExecutor() {
  return async function comparisonVideo(ctx: JobContext) {
    const { runs } = ctx.job.payload as unknown as { runs: RunRef[] };
    const { runsRoot } = await galleryRoot();
    const runDirectories = runs.map((r) => `${runsRoot}/${r.bench}/${r.slug}/${r.runId}`);
    ctx.progress(30, "composing comparison video (ffmpeg)");
    const result = await exportComparisonVideo({
      runsRoot,
      runDirectories,
      outputRoot: `${DATA_DIR}/hub/comparison-exports`,
    });
    ctx.progress(100, `comparison video ready (${result.runCount} runs, ${result.layout})`);
    return { ...result };
  };
}

// ── export / publish (gallery snapshot; publish = commit + push, dev-gated) ──

export function exportExecutor() {
  return async function exportGallery(ctx: JobContext) {
    const { publish } = ctx.job.payload as { publish?: boolean };
    const { runsRoot, root } = await galleryRoot();
    ctx.progress(10, "building gallery snapshot");
    const manifest = await generateStaticExport({
      benchmarkDirectory: `${root}/benchmarks`,
      runsRoot,
      publicExportDirectory: `${root}/public/export`,
    });
    ctx.log(`[hub] snapshot: ${manifest.runs.length} runs, ${manifest.benchmarks.length} benchmarks`);
    if (!publish) {
      ctx.progress(100, "snapshot built");
      return { runs: manifest.runs.length, published: false };
    }

    ctx.progress(60, "committing snapshot");
    const git = (args: string[]) => ctx.spawnOwned("git", args, { cwd: root });
    await git(["add", "public/export"]);
    const diff = await git(["diff", "--cached", "--quiet"]);
    if (diff.code === 0) {
      ctx.log("[hub] no changes since the last published snapshot");
    } else {
      const commit = await git(["commit", "-m", `Publish benchmark export ${new Date().toISOString()}`]);
      if (commit.code !== 0) throw new Error(`git commit exited with code ${commit.code}`);
      ctx.progress(80, "pushing");
      const push = await git(["push"]);
      if (push.code !== 0) throw new Error(`git push exited with code ${push.code}`);
    }
    ctx.progress(100, "published");
    return { runs: manifest.runs.length, published: true };
  };
}