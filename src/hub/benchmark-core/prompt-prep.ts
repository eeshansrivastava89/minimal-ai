import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildRunPaths, createRunId } from "./paths.ts";

// Load .env from project root so process.env picks up SUPABASE_URL etc.
// Does not override already-set env vars (e.g. from shell or CI).
(function loadDotEnv() {
  try {
    const content = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!process.env[key]) {
        process.env[key] = trimmed.slice(eq + 1).trim();
      }
    }
  } catch {
    /* no .env file — that's fine */
  }
})();

import { writePromptMarkdown, writeRunMetadata } from "./runs.ts";
import type {
  BenchmarkRecord,
  ModelSourceId,
  PreparedRun,
  RunnerMode,
  RunKind,
  RunMetadata,
} from "./types.ts";

export type PrepareRunRunner = "manual" | "pi" | "opencode" | "hermes";

export interface PrepareRunInput {
  benchmark: BenchmarkRecord;
  modelId: string;
  modelSource?: ModelSourceId;
  runner?: PrepareRunRunner;
  kind?: RunKind;
  baseUrl?: string;
  backendLabel?: string;
  runsRoot?: string;
  now?: Date;
}

export async function prepareRun(input: PrepareRunInput): Promise<PreparedRun> {
  const now = input.now ?? new Date();
  const runner = input.runner ?? "manual";
  const kind = input.kind ?? "visual";
  const paths = buildRunPaths({
    runsRoot: input.runsRoot,
    benchmarkId: input.benchmark.id,
    modelId: input.modelId,
    runId: createRunId(now),
  });
  const prompt = buildToolPrompt({
    benchmark: input.benchmark,
    kind,
  });
  const timestamp = now.toISOString();
  const modelSource = input.modelSource;
  const backendLabel = modelSource
    ? modelSourceLabel(modelSource, input.backendLabel)
    : undefined;
  const isDs = kind === "data-science";
  const run: RunMetadata = {
    schemaVersion: 1,
    kind,
    runId: paths.runId,
    benchmark: input.benchmark,
    model: {
      id: input.modelId,
      slug: paths.modelSlug,
    },
    status: "prepared",
    createdAt: timestamp,
    updatedAt: timestamp,
    preparedAt: timestamp,
    runDirectory: paths.runDirectory,
    assets: isDs
      ? {
          metadata: "metadata.json",
          prompt: "prompt.md",
          rawResponse: "response.raw.txt",
          ds: {
            notebook: "analysis.ipynb",
            summary: "summary.json",
            chartDistribution: "chart-distribution.png",
            chartTreatmentEffect: "chart-treatment-effect.png",
            chartCompletionRates: "chart-completion-rates.png",
          },
        }
      : {
          metadata: "metadata.json",
          prompt: "prompt.md",
          html: "index.html",
          preview: "preview.png",
          video: "preview.webm",
          rawResponse: "response.raw.txt",
        },
    runner: {
      mode: runnerModeFor(runner),
      ...(modelSource ? { modelSource } : {}),
      intendedRunner: runnerLabel(runner),
      backendLabel,
      baseUrl: normalizeOptionalString(input.baseUrl),
      model: input.modelId,
      retries: 0,
      tokenMetrics: {
        reported: false,
      },
    },
    ...(runner === "manual" ? {} : { tool: runner }),
  };

  await mkdir(paths.runDirectory, { recursive: true });

  const writes: Promise<unknown>[] = [
    writeRunMetadata(paths, run),
    writeSupabaseConfig(paths.runDirectory),
  ];
  if (prompt) {
    writes.push(writePromptMarkdown(paths, prompt));
  }
  await Promise.all(writes);

  return {
    run,
    prompt,
    paths: {
      runDirectory: paths.runDirectory,
      promptPath: paths.promptPath,
      commandPath: paths.commandPath,
      htmlPath: paths.htmlPath,
      metadataPath: paths.metadataPath,
      previewPath: paths.previewPath,
    },
  };
}

export function buildToolPrompt(input: {
  benchmark: BenchmarkRecord;
  kind?: RunKind;
}): string {
  return input.benchmark.prompt.trim();
}

function runnerModeFor(runner: PrepareRunRunner): RunnerMode {
  if (runner === "manual") return "manual";
  return "external";
}

function runnerLabel(runner: PrepareRunRunner): string {
  if (runner === "hermes") return "Hermes";
  if (runner === "opencode") return "OpenCode";
  if (runner === "pi") return "Pi";
  return "manual";
}

function modelSourceLabel(source: ModelSourceId, customLabel?: string): string {
  if (source === "ollama") return "Ollama";
  if (source === "omlx") return "oMLX";
  if (source === "llama-cpp") return "llama.cpp";
  if (source === "llama-cpp-mtp") return "llama.cpp MTP";
  if (source === "cloud") return customLabel ?? "Cloud";
  return source;
}

function normalizeOptionalString(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function writeSupabaseConfig(runDirectory: string): Promise<void> {
  const baseUrl = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!baseUrl || !anonKey) return;

  const config = {
    url: `${baseUrl}/rest/v1/posthog_events?select=*&session_id=not.is.null&variant=not.is.null`,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
  };

  return writeFile(
    join(runDirectory, "supabase.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
}
