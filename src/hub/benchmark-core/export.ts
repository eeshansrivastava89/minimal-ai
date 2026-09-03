import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { assertSafePathSegment, assertSafeRunAssetPath, isPathInside, resolveRunAssetPath } from "./asset-paths.ts";
import { loadBenchmarks } from "./benchmarks.ts";
import { listRunMetadata } from "./runs.ts";
import { getSystemStats, type SystemStats } from "./system-stats.ts";
import type { BenchmarkRecord, RunCaptureAsset, RunCaptureMetadata, RunMetadata, RunRunnerMetadata } from "./types.ts";

export interface StaticExportManifest {
  version: 1;
  generatedAt: string;
  benchmarks: BenchmarkRecord[];
  runs: RunMetadata[];
  machineProfile: SystemStats;
}

export interface GenerateStaticExportOptions {
  benchmarkDirectory?: string;
  runsRoot?: string;
  publicExportDirectory?: string;
  generatedAt?: Date;
}

const DEFAULT_BENCHMARK_DIRECTORY = join(process.cwd(), "benchmarks");
const DEFAULT_RUNS_ROOT = join(process.cwd(), "runs");
const DEFAULT_PUBLIC_EXPORT_DIRECTORY = join(process.cwd(), "public", "export");
const EXPORTED_RUNS_DIRECTORY = "runs";

export async function generateStaticExport(
  options: GenerateStaticExportOptions = {}
): Promise<StaticExportManifest> {
  const benchmarkDirectory =
    options.benchmarkDirectory ?? DEFAULT_BENCHMARK_DIRECTORY;
  const runsRoot = options.runsRoot ?? DEFAULT_RUNS_ROOT;
  const publicExportDirectory =
    options.publicExportDirectory ?? DEFAULT_PUBLIC_EXPORT_DIRECTORY;

  await rm(publicExportDirectory, { recursive: true, force: true });
  await mkdir(publicExportDirectory, { recursive: true });

  const [benchmarks, runs] = await Promise.all([
    loadBenchmarks(benchmarkDirectory),
    listRunMetadata(runsRoot)
  ]);
  const exportedRuns = await Promise.all(
    runs
      .filter((run) => isExportableKind(run.kind ?? "visual"))
      .map((run) => exportRunAssets(run, publicExportDirectory))
  );
  const manifest: StaticExportManifest = {
    version: 1,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    benchmarks: benchmarks.map(toStaticBenchmark),
    runs: exportedRuns,
    machineProfile: getSystemStats(options.generatedAt ?? new Date())
  };

  await writePrettyJson(join(publicExportDirectory, "manifest.json"), manifest);
  return manifest;
}

async function exportRunAssets(
  run: RunMetadata,
  publicExportDirectory: string
): Promise<RunMetadata> {
  const benchmarkId = assertSafePathSegment(run.benchmark.id, "Export path segment");
  const modelSlug = assertSafePathSegment(run.model.slug, "Export path segment");
  const runId = assertSafePathSegment(run.runId, "Export path segment");
  const exportRunDirectory = posix.join(
    "export",
    EXPORTED_RUNS_DIRECTORY,
    benchmarkId,
    modelSlug,
    runId
  );
  const outputDirectory = join(
    publicExportDirectory,
    EXPORTED_RUNS_DIRECTORY,
    benchmarkId,
    modelSlug,
    runId
  );
  assertPathInsideExportRoot(outputDirectory, publicExportDirectory);
  const assets: RunMetadata["assets"] = {
    metadata: safeAsset(run.assets.metadata ?? "metadata.json"),
    ...(run.assets.preview ? { preview: safeAsset(run.assets.preview) } : {}),
    ...(run.assets.videoMp4 ? { videoMp4: safeAsset(run.assets.videoMp4) } : {}),
    ...(run.assets.ds ? { ds: exportDsAssets(run.assets.ds) } : {})
  };
  const exportedRun: RunMetadata = {
    ...(run.schemaVersion ? { schemaVersion: run.schemaVersion } : {}),
    kind: run.kind ?? "visual",
    runId: run.runId,
    benchmark: toStaticBenchmark(run.benchmark),
    model: run.model,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.preparedAt ? { preparedAt: run.preparedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.failedAt ? { failedAt: run.failedAt } : {}),
    ...(run.cancelledAt ? { cancelledAt: run.cancelledAt } : {}),
    ...(run.skippedAt ? { skippedAt: run.skippedAt } : {}),
    runDirectory: exportRunDirectory,
    ...(run.settings ? { settings: run.settings } : {}),
    assets,
    ...(run.runner ? { runner: toPublicRunner(run.runner) } : {}),
    ...(run.capture ? { capture: toPublicCapture(run.capture) } : {}),
    ...(run.dsSummary ? { dsSummary: run.dsSummary } : {}),
    ...(run.dsScorecard ? { dsScorecard: run.dsScorecard } : {})
  };

  const dsAssetKeys = run.assets.ds
    ? [run.assets.ds.chartDistribution, run.assets.ds.chartTreatmentEffect, run.assets.ds.chartCompletionRates, run.assets.ds.summary, run.assets.ds.scorecard].filter(Boolean) as string[]
    : [];

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writePrettyJson(join(outputDirectory, assets.metadata), exportedRun),
    copyAssetIfPresent(run, outputDirectory, assets.preview),
    copyAssetIfPresent(run, outputDirectory, assets.videoMp4),
    ...dsAssetKeys.map((a) => copyAssetIfPresent(run, outputDirectory, a))
  ]);

  return exportedRun;
}

async function copyAssetIfPresent(
  run: RunMetadata,
  outputDirectory: string,
  asset?: string
): Promise<void> {
  if (!asset) {
    return;
  }

  try {
    await copyFile(resolveRunAssetPath(run.runDirectory, asset), resolveRunAssetPath(outputDirectory, asset));
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }

    throw error;
  }
}

function safeAsset(asset: string): string {
  return assertSafeRunAssetPath(asset);
}

function assertPathInsideExportRoot(path: string, root: string): void {
  if (!isPathInside(resolve(path), resolve(root))) {
    throw new Error("Export path must stay inside the public export directory.");
  }
}

function toStaticBenchmark(benchmark: BenchmarkRecord): BenchmarkRecord {
  return {
    id: benchmark.id,
    title: benchmark.title,
    description: benchmark.description,
    prompt: benchmark.prompt
  };
}

function toPublicRunner(runner: RunRunnerMetadata): RunRunnerMetadata {
  return {
    mode: runner.mode,
    ...(runner.modelSource ? { modelSource: runner.modelSource } : {}),
    ...(runner.intendedRunner ? { intendedRunner: runner.intendedRunner } : {}),
    ...(runner.actualRunner ? { actualRunner: runner.actualRunner } : {}),
    ...(isPublicSafeLabel(runner.harnessLabel) ? { harnessLabel: runner.harnessLabel } : {}),
    ...(isPublicSafeLabel(runner.harnessVersion) ? { harnessVersion: runner.harnessVersion } : {}),
    ...(runner.backendLabel ? { backendLabel: runner.backendLabel } : {}),
    ...(isPublicSafeLabel(runner.model) ? { model: runner.model } : {}),
    ...(typeof runner.retries === "number" ? { retries: runner.retries } : {}),
    ...(runner.fallbacksUsed ? { fallbacksUsed: runner.fallbacksUsed } : {}),
    ...(runner.tokenMetrics?.reported ? { tokenMetrics: runner.tokenMetrics } : {})
  };
}

function toPublicCapture(capture: RunCaptureMetadata): RunCaptureMetadata {
  return {
    ...(capture.preview ? { preview: toPublicCaptureAsset(capture.preview) } : {}),
    ...(capture.video ? { video: toPublicCaptureAsset(capture.video) } : {})
  };
}

function toPublicCaptureAsset(asset: RunCaptureAsset): RunCaptureAsset {
  return {
    status: asset.status,
    ...(asset.capturedAt ? { capturedAt: asset.capturedAt } : {}),
    ...(asset.reason ? { reason: asset.reason } : {}),
    ...(asset.error?.message ? { error: { message: toPublicErrorMessage(asset.error.message) } } : {}),
    ...(asset.quality
      ? {
          quality: {
            measuredFps: asset.quality.measuredFps,
            minFps: asset.quality.minFps,
            sampleMs: asset.quality.sampleMs,
            frames: asset.quality.frames,
            viewport: asset.quality.viewport
          }
        }
      : {})
  };
}

function isPublicSafeLabel(value: string | undefined): value is string {
  if (!value) return false;
  return !containsLocalPathOrUrl(value);
}

function toPublicErrorMessage(message: string): string {
  if (containsLocalPathOrUrl(message)) {
    return "Capture failed. See local run evidence for details.";
  }

  return message;
}

function containsLocalPathOrUrl(value: string): boolean {
  return (
    /\bfile:\/\//iu.test(value) ||
    /\bhttps?:\/\//iu.test(value) ||
    /(^|\s)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_. -]+)+/u.test(value) ||
    /[A-Za-z]:[\\/]/u.test(value) ||
    /\\\\[A-Za-z0-9_.-]+\\/u.test(value)
  );
}

async function writePrettyJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

const EXPORTABLE_RUN_KINDS = new Set(["visual", "data-science"]);

function isExportableKind(kind: string): boolean {
  return EXPORTABLE_RUN_KINDS.has(kind);
}

function exportDsAssets(ds: NonNullable<RunMetadata["assets"]["ds"]>): NonNullable<RunMetadata["assets"]["ds"]> {
  const result: NonNullable<RunMetadata["assets"]["ds"]> = {};
  if (ds.summary) result.summary = safeAsset(ds.summary);
  if (ds.chartDistribution) result.chartDistribution = safeAsset(ds.chartDistribution);
  if (ds.chartTreatmentEffect) result.chartTreatmentEffect = safeAsset(ds.chartTreatmentEffect);
  if (ds.chartCompletionRates) result.chartCompletionRates = safeAsset(ds.chartCompletionRates);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = await generateStaticExport();
  process.stdout.write(
    `Wrote static export manifest with ${manifest.benchmarks.length} benchmarks and ${manifest.runs.length} runs.\n`
  );
}
