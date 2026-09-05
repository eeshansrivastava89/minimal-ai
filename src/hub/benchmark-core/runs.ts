import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isPathInside, resolveRunAssetPath } from "./asset-paths.ts";
import type { RunPaths } from "./paths.ts";
import type { DsScorecard, DsSummary, RunError, RunMetadata } from "./types.ts";

export type RunMetadataUpdate = Partial<Omit<RunMetadata, "runId">>;

export async function writeRunMetadata(
  paths: RunPaths,
  metadata: RunMetadata
): Promise<void> {
  await mkdir(paths.runDirectory, { recursive: true });
  await writePrettyJson(paths.metadataPath, metadata);
}

export async function writeRawResponse(
  paths: RunPaths,
  rawResponse: string
): Promise<void> {
  await mkdir(paths.runDirectory, { recursive: true });
  await writeFile(paths.rawResponsePath, rawResponse, "utf8");
}

export async function writePromptMarkdown(
  paths: RunPaths,
  prompt: string
): Promise<void> {
  await mkdir(paths.runDirectory, { recursive: true });
  await writeFile(paths.promptPath, prompt, "utf8");
}

export async function writeRunHtml(paths: RunPaths, html: string): Promise<void> {
  await mkdir(paths.runDirectory, { recursive: true });
  await writeFile(paths.htmlPath, html, "utf8");
}

export async function readRunMetadata(paths: RunPaths): Promise<RunMetadata> {
  return JSON.parse(await readFile(paths.metadataPath, "utf8")) as RunMetadata;
}

export interface DeleteRunDirectoryInput {
  runsRoot?: string;
  runDirectory: string;
}

export async function deleteRunDirectory(input: DeleteRunDirectoryInput): Promise<void> {
  const runsRoot = resolve(input.runsRoot ?? join(process.cwd(), "runs"));
  const runDirectory = resolve(input.runDirectory);

  if (runDirectory === runsRoot || !isPathInside(runDirectory, runsRoot)) {
    throw new Error("Run directory is outside the configured runs folder.");
  }

  await rm(runDirectory, { recursive: true, force: false });
  await pruneEmptyParents(dirname(runDirectory), runsRoot);
}

export async function listRunMetadata(
  runsRoot = join(process.cwd(), "runs"),
  /** Skip reading prompt.md per run (the hub's Run DTO never uses it).
   *  Default false keeps the gallery-faithful behavior. */
  options: { skipPromptText?: boolean } = {}
): Promise<RunMetadata[]> {
  const metadataPaths = await findMetadataFiles(runsRoot);
  const runMetadata = (
    await Promise.all(metadataPaths.map((path) => readMetadataIfPresent(path, options)))
  ).filter((metadata): metadata is RunMetadata => Boolean(metadata));

  return runMetadata.sort((left, right) =>
    sortTimestamp(right).localeCompare(sortTimestamp(left))
  );
}

export async function updateRunMetadata(
  paths: RunPaths,
  update: RunMetadataUpdate
): Promise<RunMetadata> {
  const current = await readRunMetadata(paths);
  const next: RunMetadata = {
    ...current,
    ...update
  };

  await writeRunMetadata(paths, next);
  return next;
}

export async function markRunFailed(
  paths: RunPaths,
  error: unknown,
  now = new Date()
): Promise<RunMetadata> {
  const timestamp = now.toISOString();

  return updateRunMetadata(paths, {
    status: "failed",
    updatedAt: timestamp,
    failedAt: timestamp,
    error: toRunError(error)
  });
}

function toRunError(error: unknown): RunError {
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {})
    };
  }

  return {
    message: String(error)
  };
}

async function writePrettyJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function findMetadataFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  await collectMetadataFiles(root, result, 0);
  return result.sort((left, right) => left.localeCompare(right));
}

async function collectMetadataFiles(
  directory: string,
  result: string[],
  depth: number
): Promise<void> {
  const entries = await readDirentsIfPresent(directory);
  const hasMetadata = entries.some(
    (entry) => entry.isFile() && entry.name === "metadata.json"
  );

  if (hasMetadata) {
    result.push(join(directory, "metadata.json"));
    return;
  }

  if (depth >= 5) {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      await collectMetadataFiles(join(directory, entry.name), result, depth + 1);
    }
  }
}

async function readDirentsIfPresent(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }

    throw error;
  }
}

async function readMetadataIfPresent(
  path: string,
  options: { skipPromptText?: boolean }
): Promise<RunMetadata | undefined> {
  try {
    const metadata = JSON.parse(await readFile(path, "utf8")) as RunMetadata;
    if (metadata.kind && !isKnownRunKind(metadata.kind)) {
      return undefined;
    }
    return hydrateAssetAvailability(metadata, options);
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) {
      return undefined;
    }

    throw error;
  }
}

async function hydrateAssetAvailability(
  metadata: RunMetadata,
  options: { skipPromptText?: boolean }
): Promise<RunMetadata> {
  const declared = metadata.assets ?? {};
  const kind = metadata.kind ?? "visual";
  const isDs = kind === "data-science";
  const visualCandidates = {
    prompt: declared.prompt ?? "prompt.md",
    rawResponse: declared.rawResponse ?? "response.raw.txt",
    request: declared.request ?? "request.json",
    stream: declared.stream ?? "stream.ndjson",
    response: declared.response ?? "response.txt",
    command: declared.command ?? "command.txt",
    html: declared.html ?? "index.html",
    preview: declared.preview ?? "preview.png",
    video: declared.video ?? "preview.webm",
    videoMp4: declared.videoMp4 ?? "preview.mp4"
  };
  const dsCandidates = {
    notebook: declared.ds?.notebook ?? "analysis.ipynb",
    summary: declared.ds?.summary ?? "summary.json",
    scorecard: declared.ds?.scorecard ?? "scorecard.json",
    chartDistribution: declared.ds?.chartDistribution ?? "chart-distribution.png",
    chartTreatmentEffect: declared.ds?.chartTreatmentEffect ?? "chart-treatment-effect.png",
    chartCompletionRates: declared.ds?.chartCompletionRates ?? "chart-completion-rates.png"
  };
  const visualChecks = await Promise.all(
    Object.values(visualCandidates).map((c) => assetExists(metadata, c))
  );
  const dsChecks = isDs
    ? await Promise.all(Object.values(dsCandidates).map((c) => assetExists(metadata, c)))
    : Object.values(dsCandidates).map(() => false);

  const assets: RunMetadata["assets"] = {
    metadata: declared.metadata ?? "metadata.json"
  };

  const visualKeys = Object.keys(visualCandidates) as (keyof typeof visualCandidates)[];
  for (let i = 0; i < visualKeys.length; i++) {
    if (visualChecks[i]) assets[visualKeys[i]] = visualCandidates[visualKeys[i]];
  }

  const dsKeys = Object.keys(dsCandidates) as (keyof typeof dsCandidates)[];
  const dsAssets: NonNullable<RunMetadata["assets"]["ds"]> = {};
  let hasDs = false;
  for (let i = 0; i < dsKeys.length; i++) {
    if (dsChecks[i]) {
      dsAssets[dsKeys[i]] = dsCandidates[dsKeys[i]];
      hasDs = true;
    }
  }
  if (hasDs) assets.ds = dsAssets;

  const promptText = options.skipPromptText
    ? undefined
    : assets.prompt
      ? await readAssetTextIfPresent(metadata, assets.prompt)
      : undefined;

  const dsSummary = isDs && assets.ds?.summary
    ? await readDsSummaryIfPresent(metadata, assets.ds.summary)
    : undefined;

  const dsScorecard = isDs && assets.ds?.scorecard
    ? await readDsScorecardIfPresent(metadata, assets.ds.scorecard)
    : undefined;

  return {
    ...metadata,
    kind: metadata.kind ?? "visual",
    assets,
    ...(promptText !== undefined ? { promptText } : {}),
    ...(dsSummary !== undefined ? { dsSummary } : {}),
    ...(dsScorecard !== undefined ? { dsScorecard } : {})
  };
}

async function readAssetTextIfPresent(
  metadata: RunMetadata,
  asset: string
): Promise<string | undefined> {
  try {
    return await readFile(resolveRunAssetPath(metadata.runDirectory, asset), "utf8");
  } catch (error) {
    if (isMissingPathError(error) || isUnsafeAssetPathError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function readDsSummaryIfPresent(
  metadata: RunMetadata,
  asset: string
): Promise<DsSummary | undefined> {
  try {
    const raw = await readFile(resolveRunAssetPath(metadata.runDirectory, asset), "utf8");
    const parsed = JSON.parse(raw);
    return {
      status: parsed.status ?? undefined,
      recommended_variant: parsed.recommended_variant === "A" || parsed.recommended_variant === "B" ? parsed.recommended_variant : null,
      decision: parsed.decision ?? undefined,
      metrics: Array.isArray(parsed.metrics) ? parsed.metrics : undefined,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : undefined
    };
  } catch {
    return undefined;
  }
}

async function readDsScorecardIfPresent(
  metadata: RunMetadata,
  asset: string
): Promise<DsScorecard | undefined> {
  try {
    const raw = await readFile(resolveRunAssetPath(metadata.runDirectory, asset), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.earned !== "number" || typeof parsed.total !== "number") return undefined;
    return {
      total: parsed.total,
      earned: parsed.earned,
      pct: parsed.pct ?? Math.round(parsed.earned / parsed.total * 1000) / 10,
      checks: typeof parsed.checks === "object" ? parsed.checks : undefined
    };
  } catch {
    return undefined;
  }
}

async function assetExists(metadata: RunMetadata, asset?: string): Promise<boolean> {
  if (!asset || !metadata.runDirectory) {
    return false;
  }

  try {
    const result = await stat(resolveRunAssetPath(metadata.runDirectory, asset));
    return result.isFile() || result.isDirectory();
  } catch (error) {
    if (isMissingPathError(error) || isUnsafeAssetPathError(error)) {
      return false;
    }

    throw error;
  }
}

function sortTimestamp(metadata: RunMetadata): string {
  return metadata.updatedAt || metadata.createdAt || metadata.runId;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isUnsafeAssetPathError(error: unknown): boolean {
  return error instanceof Error && /Asset path must stay inside a run folder/u.test(error.message);
}

async function pruneEmptyParents(directory: string, stopAt: string): Promise<void> {
  let current = resolve(directory);

  while (current !== stopAt && isPathInside(current, stopAt)) {
    try {
      await rmdir(current);
    } catch (error) {
      if (isNonEmptyDirectoryError(error) || isMissingPathError(error)) {
        return;
      }

      throw error;
    }

    current = dirname(current);
  }
}

function isNonEmptyDirectoryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOTEMPTY" || error.code === "EEXIST")
  );
}

const KNOWN_RUN_KINDS = new Set(["visual", "data-science"]);

function isKnownRunKind(kind: string): boolean {
  return KNOWN_RUN_KINDS.has(kind);
}
