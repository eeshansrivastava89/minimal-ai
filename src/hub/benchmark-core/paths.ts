import { createHash } from "node:crypto";
import { join } from "node:path";

const DEFAULT_MAX_SLUG_LENGTH = 80;
const BENCHMARK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;

export interface BuildRunPathsInput {
  runsRoot?: string;
  benchmarkId: string;
  modelId: string;
  runId: string;
}

export interface RunPaths {
  runsRoot: string;
  benchmarkId: string;
  modelId: string;
  modelSlug: string;
  runId: string;
  benchmarkDirectory: string;
  modelDirectory: string;
  runDirectory: string;
  metadataPath: string;
  promptPath: string;
  rawResponsePath: string;
  requestPath: string;
  streamPath: string;
  responsePath: string;
  commandPath: string;
  htmlPath: string;
  previewPath: string;
  videoPath: string;
}

export function slugModelId(
  modelId: string,
  maxLength = DEFAULT_MAX_SLUG_LENGTH
): string {
  const hash = createHash("sha256").update(modelId).digest("hex").slice(0, 10);
  const normalized = modelId
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  const needsHash = slug.length === 0 || slug !== normalized || slug.length > maxLength;

  if (!needsHash) {
    return slug;
  }

  const hashSuffixLength = hash.length + 1;
  const baseMaxLength = Math.max(1, maxLength - hashSuffixLength);
  const base = slug
    .slice(0, baseMaxLength)
    .replace(/^-+|-+$/g, "") || "model";

  return `${base}-${hash}`;
}

export function createRunId(date = new Date()): string {
  return date.toISOString().replace(/:/g, "-").replace(".", "-");
}

export function buildRunPaths(input: BuildRunPathsInput): RunPaths {
  assertBenchmarkId(input.benchmarkId);
  assertRunId(input.runId);

  const runsRoot = input.runsRoot ?? join(process.cwd(), "runs");
  const modelSlug = slugModelId(input.modelId);
  const benchmarkDirectory = join(runsRoot, input.benchmarkId);
  const modelDirectory = join(benchmarkDirectory, modelSlug);
  const runDirectory = join(modelDirectory, input.runId);

  return {
    runsRoot,
    benchmarkId: input.benchmarkId,
    modelId: input.modelId,
    modelSlug,
    runId: input.runId,
    benchmarkDirectory,
    modelDirectory,
    runDirectory,
    metadataPath: join(runDirectory, "metadata.json"),
    promptPath: join(runDirectory, "prompt.md"),
    rawResponsePath: join(runDirectory, "response.raw.txt"),
    requestPath: join(runDirectory, "request.json"),
    streamPath: join(runDirectory, "stream.ndjson"),
    responsePath: join(runDirectory, "response.txt"),
    commandPath: join(runDirectory, "command.txt"),
    htmlPath: join(runDirectory, "index.html"),
    previewPath: join(runDirectory, "preview.png"),
    videoPath: join(runDirectory, "preview.webm")
  };
}

function assertBenchmarkId(benchmarkId: string): void {
  if (!BENCHMARK_ID_PATTERN.test(benchmarkId)) {
    throw new Error("Benchmark ID must be a filesystem-safe slug.");
  }
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("Run ID must be filesystem-safe.");
  }
}
