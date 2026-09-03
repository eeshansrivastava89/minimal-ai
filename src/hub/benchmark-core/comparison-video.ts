import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isPathInside } from "./asset-paths.ts";
import { listRunMetadata } from "./runs.ts";
import { stackTone } from "./stack-tones.ts";
import type { RunMetadata } from "./types.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_WIDTH = 1920;
const DEFAULT_DURATION_SECONDS = 20;
const BRAND_TITLE = "Local AI benchmarks collection";

export interface ExportComparisonVideoInput {
  runsRoot?: string;
  runDirectories: string[];
  now?: Date;
  durationSeconds?: number;
  outputRoot?: string;
}

export interface ExportComparisonVideoResult {
  path: string;
  runCount: number;
  layout: string;
}

interface ComparisonItem {
  run: RunMetadata;
  videoPath: string;
  title: string;
  modelLabel: string;
  backendLabel: string;
  harnessLabel: string;
}

export async function exportComparisonVideo(input: ExportComparisonVideoInput): Promise<ExportComparisonVideoResult> {
  const runDirectories = uniqueStrings(input.runDirectories).map((item) => resolve(item));
  if (runDirectories.length < 2 || runDirectories.length > 6) {
    throw new Error("Select 2 to 6 runs for comparison video export.");
  }

  const runsRoot = resolve(input.runsRoot ?? join(process.cwd(), "runs"));
  for (const directory of runDirectories) {
    if (!isPathInside(directory, runsRoot)) {
      throw new Error("Selected run is outside the configured runs folder.");
    }
  }

  const allRuns = await listRunMetadata(runsRoot);
  const byDirectory = new Map(allRuns.map((run) => [resolve(run.runDirectory), run]));
  const items = runDirectories.map((directory) => {
    const run = byDirectory.get(directory);
    if (!run) throw new Error(`Run not found: ${directory}`);
    const videoAsset = run.assets?.videoMp4 ?? run.assets?.video;
    if (!videoAsset) throw new Error(`Run has no captured video: ${run.model?.id ?? basename(directory)}`);
    return {
      run,
      videoPath: join(run.runDirectory, videoAsset),
      title: run.benchmark?.title ?? run.benchmark?.id ?? "Visual benchmark",
      ...comparisonStackParts(run)
    } satisfies ComparisonItem;
  });

  await assertFfmpegAvailable();
  const now = input.now ?? new Date();
  const benchmarkId = sharedBenchmarkId(items) ?? "mixed-prompts";
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const outputDirectory = join(input.outputRoot ?? join(process.cwd(), "comparison-exports"), safeFilenamePart(benchmarkId));
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = join(outputDirectory, `${safeFilenamePart(benchmarkId)}-${timestamp}-${items.length}runs.mp4`);
  const title = sharedBenchmarkTitle(items) ?? "Visual comparison";
  const layout = layoutFor(items.length);
  const { filterFile, backgroundPath, tempDirectory } = await writeFilterFile({ items, title, layout, generatedAt: now });

  const argv = [
    ...items.flatMap((item) => ["-i", item.videoPath]),
    "-loop", "1", "-i", backgroundPath,
    "-filter_complex_script", filterFile,
    "-map", "[v]",
    "-t", String(input.durationSeconds ?? DEFAULT_DURATION_SECONDS),
    "-an",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-y",
    outputPath
  ];

  try {
    await execFileAsync("ffmpeg", argv, { maxBuffer: 1024 * 1024 * 20 });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
  return {
    path: outputPath,
    runCount: items.length,
    layout: `${layout.cols}x${layout.rows}`
  };
}

async function writeFilterFile(input: {
  items: ComparisonItem[];
  title: string;
  layout: ReturnType<typeof layoutFor>;
  generatedAt: Date;
}): Promise<{ filterFile: string; backgroundPath: string; tempDirectory: string }> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "llm-comparison-video-"));
  const filterPath = join(tempDirectory, "filter.txt");
  const backgroundPath = join(tempDirectory, "background.png");
  const { cols, rows } = input.layout;
  const headerH = 104;
  const tileW = Math.floor(DEFAULT_WIDTH / cols);
  const labelH = 88;
  const padX = 16;
  const padY = 14;
  const mediaW = tileW - padX * 2;
  const mediaH = even(Math.round(mediaW * 9 / 16));
  const tileH = padY + mediaH + labelH;
  const outputHeight = even(headerH + rows * tileH);
  await renderBackgroundImage({ ...input, backgroundPath, headerH, tileW, tileH, labelH, padX, padY, mediaH, outputHeight });

  const filters: string[] = [];
  for (const [index] of input.items.entries()) {
    filters.push(
      `[${index}:v]setpts=PTS-STARTPTS,scale=${mediaW}:${mediaH}:force_original_aspect_ratio=increase,crop=${mediaW}:${mediaH},setsar=1[media${index}]`
    );
  }

  const backgroundInput = input.items.length;
  let previous = `[${backgroundInput}:v]`;
  for (const [index] of input.items.entries()) {
    const x = (index % cols) * tileW + padX;
    const y = headerH + Math.floor(index / cols) * tileH + padY;
    const next = index === input.items.length - 1 ? "[v]" : `[base${index}]`;
    filters.push(`${previous}[media${index}]overlay=x=${x}:y=${y}${next}`);
    previous = next;
  }

  await writeFile(filterPath, filters.join(";\n"), "utf8");
  return { filterFile: filterPath, backgroundPath, tempDirectory };
}

function layoutFor(count: number): { cols: number; rows: number } {
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  return { cols: 3, rows: 2 };
}

async function renderBackgroundImage(input: {
  items: ComparisonItem[];
  backgroundPath: string;
  title: string;
  headerH: number;
  tileW: number;
  tileH: number;
  labelH: number;
  padX: number;
  padY: number;
  mediaH: number;
  outputHeight: number;
  layout: ReturnType<typeof layoutFor>;
  generatedAt: Date;
}): Promise<void> {
  const htmlDirectory = await mkdtemp(join(tmpdir(), "llm-comparison-bg-"));
  const htmlPath = join(htmlDirectory, "background.html");
  const html = comparisonBackgroundHtml(input);
  await writeFile(htmlPath, html, "utf8");
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: DEFAULT_WIDTH, height: input.outputHeight }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.screenshot({ path: input.backgroundPath, fullPage: false });
  } finally {
    await browser.close();
    await rm(htmlDirectory, { recursive: true, force: true });
  }
}

function comparisonBackgroundHtml(input: {
  items: ComparisonItem[];
  title: string;
  headerH: number;
  tileW: number;
  tileH: number;
  labelH: number;
  padX: number;
  padY: number;
  mediaH: number;
  outputHeight: number;
  layout: ReturnType<typeof layoutFor>;
  generatedAt: Date;
}): string {
  const subtitle = `${input.title} · ${input.items.length} model comparison`;
  const dateLabel = formatExportDate(input.generatedAt);
  const cards = input.items.map((item, index) => {
    const x = (index % input.layout.cols) * input.tileW;
    const y = input.headerH + Math.floor(index / input.layout.cols) * input.tileH;
    return `
      <section class="tile" style="left:${x}px;top:${y}px;width:${input.tileW}px;height:${input.tileH}px;">
        <div class="media"></div>
        <div class="label" style="height:${input.labelH}px;">
          <strong>${escapeHtml(item.modelLabel)}</strong>
          ${renderExportStackSummary(item)}
        </div>
      </section>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; width: ${DEFAULT_WIDTH}px; height: ${input.outputHeight}px; overflow: hidden; background: #f8f5ee; color: #332d27; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Helvetica Neue", Arial, sans-serif; }
      .brand { position: absolute; left: 36px; top: 20px; right: 36px; height: ${input.headerH - 20}px; border-bottom: 1px solid #d8d0c4; }
      .brand h1 { margin: 0; max-width: 1300px; font-size: 34px; line-height: 1.1; letter-spacing: -0.03em; font-weight: 780; }
      .brand p { margin: 8px 0 0; color: #6b6258; font-size: 22px; line-height: 1.1; font-weight: 600; }
      .brand time { position: absolute; top: 8px; right: 0; color: #6b6258; font-size: 22px; line-height: 1.1; font-weight: 650; }
      .tile { position: absolute; padding: 14px 16px 0; }
      .media { width: 100%; height: ${input.mediaH}px; border: 1px solid #cfc6ba; border-radius: 18px; background: #050505; box-shadow: 0 10px 26px rgba(66, 55, 43, 0.08); }
      .label { display: grid; align-content: start; gap: 4px; padding: 14px 0 0; }
      .label strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 28px; line-height: 1.1; letter-spacing: -0.025em; font-weight: 780; }
      .stack-summary { display: flex; align-items: center; gap: 8px; min-width: 0; color: #6b6258; font-size: 22px; line-height: 1.1; font-weight: 650; }
      .stack-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .stack-model::after { content: "·"; margin-left: 8px; color: #8b8177; }
      .stack-pill { display: inline-flex; align-items: center; justify-content: center; min-height: 26px; border: 1px solid transparent; border-radius: 999px; padding: 2px 10px 3px; font-size: 16px; font-weight: 850; line-height: 1; white-space: nowrap; }
      .stack-pill[data-stack-role="harness"] { border-style: dashed; }
      .stack-pill[data-stack-tone="omlx"] { border-color: #9f7aea66; background: #f0e8ff; color: #5f3bb4; }
      .stack-pill[data-stack-tone="llamacpp"] { border-color: #d9903d77; background: #fff0dc; color: #8a4d0d; }
      .stack-pill[data-stack-tone="lmstudio"] { border-color: #2f9eaf66; background: #ddf7fb; color: #136977; }
      .stack-pill[data-stack-tone="cloud"] { border-color: #4f7ee866; background: #e8efff; color: #2853b8; }
      .stack-pill[data-stack-tone="pi"] { border-color: #35a86b77; background: #e3f8ec; color: #197044; }
      .stack-pill[data-stack-tone="opencode"] { border-color: #dc5d8a77; background: #ffe7f0; color: #a82d5b; }
      .stack-pill[data-stack-tone="hermes"] { border-color: #8c6be877; background: #eee8ff; color: #5b3bc0; }
      .stack-pill[data-stack-tone="manual"] { border-color: #8f7b6655; background: #f2ede7; color: #62513f; }
      .stack-pill[data-stack-tone="unknown"] { border-color: #9b948b55; background: #eeeae3; color: #675e55; }
      .stack-pill[data-stack-tone="backend"], .stack-pill[data-stack-tone="harness"] { border-color: #85786b55; background: #efeae2; color: #332d27; }
    </style></head><body>
      <header class="brand"><h1>${escapeHtml(BRAND_TITLE)}</h1><p>${escapeHtml(subtitle)}</p><time>${escapeHtml(dateLabel)}</time></header>
      ${cards}
    </body></html>`;
}

function even(value: number): number {
  return value % 2 === 0 ? value : value + 1;
}

function formatExportDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderExportStackSummary(item: ComparisonItem): string {
  return '<span class="stack-summary">' +
    '<span class="stack-model">' + escapeHtml(item.title) + '</span>' +
    renderExportStackPill(item.backendLabel, "backend") +
    renderExportStackPill(item.harnessLabel, "harness") +
  '</span>';
}

function renderExportStackPill(label: string, role: "backend" | "harness"): string {
  return '<span class="stack-pill" data-stack-role="' + role + '" data-stack-tone="' + stackTone(label, role) + '">' + escapeHtml(label) + '</span>';
}

function comparisonStackParts(run: RunMetadata): Pick<ComparisonItem, "modelLabel" | "backendLabel" | "harnessLabel"> {
  return {
    modelLabel: run.model?.id ?? run.runner?.model ?? "Unknown model",
    backendLabel: run.runner?.backendLabel ?? inferredBackendLabel(run),
    harnessLabel: run.runner?.harnessLabel ?? run.runner?.actualRunner ?? run.runner?.intendedRunner ?? run.tool ?? "manual"
  };
}

function inferredBackendLabel(run: RunMetadata): string {
  if (run.runner?.modelSource === "ollama") return "Ollama";
  if (run.runner?.modelSource === "omlx") return "oMLX";
  if (run.runner?.modelSource === "llama-cpp") return "llama.cpp";
  if (run.runner?.modelSource === "llama-cpp-mtp") return "llama.cpp MTP";
  if (run.runner?.modelSource === "cloud") return "Cloud";
  return "source unrecorded";
}



function sharedBenchmarkId(items: ComparisonItem[]): string | undefined {
  const ids = new Set(items.map((item) => item.run.benchmark?.id).filter(Boolean));
  return ids.size === 1 ? Array.from(ids)[0] : undefined;
}

function sharedBenchmarkTitle(items: ComparisonItem[]): string | undefined {
  const titles = new Set(items.map((item) => item.title).filter(Boolean));
  return titles.size === 1 ? Array.from(titles)[0] : undefined;
}

function safeFilenamePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "comparison";
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

async function assertFfmpegAvailable(): Promise<void> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch {
    throw new Error("ffmpeg is required to export comparison videos. Install ffmpeg and try again.");
  }
}

