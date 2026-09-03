import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listRunMetadata } from "./runs.ts";
import type { RunCaptureAsset, RunMetadata, ViewportSettings } from "./types.ts";
import {
  assertFileExists,
  assertVideoHasVisibleFrames,
  captureChromiumLaunchArgs,
  captureFrameRateErrorMessage,
  convertWebmToMp4IfAvailable,
  fileExists,
  isAnimationFrameRateAcceptable,
  parseFrameRateFromError,
  toRunError
} from "./capture-validation.ts";
import type { AnimationFrameRateMeasurement, CapturePage } from "./capture-validation.ts";

export { isAnimationFrameRateAcceptable, isVideoMostlyBlack } from "./capture-validation.ts";

const DEFAULT_VIEWPORT: ViewportSettings = {
  width: 1600,
  height: 900
};
const DEFAULT_CAPTURE_AT_MS = 5000;
const DEFAULT_VIDEO_DURATION_MS = 20_000;
const DEFAULT_MIN_CAPTURE_RENDER_FPS = 12;
const DEFAULT_FRAME_RATE_SAMPLE_MS = 1600;
const DEFAULT_FRAME_RATE_WARMUP_MS = 400;
const DEFAULT_HTML_ASSET = "index.html";
const DEFAULT_PREVIEW_ASSET = "preview.png";
const DEFAULT_VIDEO_ASSET = "preview.webm";
const DEFAULT_MP4_ASSET = "preview.mp4";

export interface CaptureLogger {
  log(message?: unknown, ...optionalParams: unknown[]): void;
  warn(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
}

export interface CaptureMissingRunMediaOptions {
  runsRoot?: string;
  now?: Date;
  videoDurationMs?: number;
  captureRunMedia?: (run: RunMetadata, options: CaptureRunMediaOptions) => Promise<CaptureRunMediaResult>;
  logger?: CaptureLogger;
}

export interface CaptureSingleRunMediaOptions extends CaptureMissingRunMediaOptions {
  runDirectory: string;
  force?: boolean;
}

export interface CaptureMissingRunMediaResult {
  captured: number;
  skipped: number;
  failed: number;
  runs: RunMetadata[];
}

export interface CaptureRunMediaOptions {
  now: Date;
  videoDurationMs: number;
  force?: boolean;
}

export interface CaptureRunMediaResult {
  captured: boolean;
  run: RunMetadata;
}

export async function captureMissingRunMedia(
  options: CaptureMissingRunMediaOptions = {}
): Promise<CaptureMissingRunMediaResult> {
  const runsRoot = options.runsRoot;
  const captureRunMedia = options.captureRunMedia ?? captureRunMediaWithPlaywright;
  const videoDurationMs = options.videoDurationMs ?? DEFAULT_VIDEO_DURATION_MS;
  const logger = options.logger ?? console;
  const runs = await listRunMetadata(runsRoot);
  let captured = 0;
  let skipped = 0;
  let failed = 0;

  logger.log(`[capture] scanning ${runs.length} saved run(s) for missing media`);

  for (const run of runs) {
    const result = await captureOne(run, {
      captureRunMedia,
      logger,
      now: options.now ?? new Date(),
      videoDurationMs
    });
    captured += result.captured;
    skipped += result.skipped;
    failed += result.failed;
  }

  logger.log(`[capture] complete: ${captured} captured, ${skipped} skipped, ${failed} failed`);

  return {
    captured,
    skipped,
    failed,
    runs: await listRunMetadata(runsRoot)
  };
}

export async function captureSingleRunMedia(
  options: CaptureSingleRunMediaOptions
): Promise<CaptureMissingRunMediaResult> {
  const runsRoot = options.runsRoot;
  const logger = options.logger ?? console;
  const captureRunMedia = options.captureRunMedia ?? captureRunMediaWithPlaywright;
  const requestedDirectory = resolve(options.runDirectory);
  const runs = await listRunMetadata(runsRoot);
  const run = runs.find((item) => resolve(item.runDirectory) === requestedDirectory);

  if (!run) {
    throw new Error("Run directory was not found inside the configured runs folder.");
  }

  const result = await captureOne(run, {
    captureRunMedia,
    force: options.force,
    logger,
    now: options.now ?? new Date(),
    videoDurationMs: options.videoDurationMs ?? DEFAULT_VIDEO_DURATION_MS
  });

  return {
    ...result,
    runs: await listRunMetadata(runsRoot)
  };
}

async function captureOne(
  run: RunMetadata,
  options: {
    captureRunMedia: (run: RunMetadata, options: CaptureRunMediaOptions) => Promise<CaptureRunMediaResult>;
    force?: boolean;
    logger: CaptureLogger;
    now: Date;
    videoDurationMs: number;
  }
): Promise<Omit<CaptureMissingRunMediaResult, "runs">> {
  if (!shouldCaptureRun(run, options.force)) {
    options.logger.log(`[capture] skipped ${runLabel(run)}: preview media already exists or source HTML is missing`);
    return { captured: 0, skipped: 1, failed: 0 };
  }

  options.logger.log(`[capture] starting ${runLabel(run)}`);

  try {
    const result = await options.captureRunMedia(run, {
      force: options.force,
      now: options.now,
      videoDurationMs: options.videoDurationMs
    });
    if (result.captured) {
      await markCaptureCompleted(result.run, options.now);
      options.logger.log(`[capture] finished ${runLabel(run)}`);
      return { captured: 1, skipped: 0, failed: 0 };
    }

    options.logger.log(`[capture] skipped ${runLabel(run)}: capture produced no changes`);
    return { captured: 0, skipped: 1, failed: 0 };
  } catch (error) {
    options.logger.error(`[capture] failed ${runLabel(run)}:`, error);
    await markCaptureFailed(run, error, options.now);
    return { captured: 0, skipped: 0, failed: 1 };
  }
}

function shouldCaptureRun(run: RunMetadata, force = false): boolean {
  if (run.kind && run.kind !== "visual") return false;
  return Boolean(run.assets?.html && (force || !run.assets?.preview || !hasCapturedVideo(run)));
}

function hasCapturedVideo(run: RunMetadata): boolean {
  return Boolean(run.assets?.video || run.assets?.videoMp4);
}

function runLabel(run: RunMetadata): string {
  return `${run.benchmark?.id ?? "unknown-prompt"}/${run.model?.slug ?? run.model?.id ?? "unknown-model"}/${run.runId}`;
}

async function captureRunMediaWithPlaywright(
  run: RunMetadata,
  options: CaptureRunMediaOptions
): Promise<CaptureRunMediaResult> {
  const { chromium } = await import("@playwright/test");
  const viewport = run.settings?.preview?.viewport ?? DEFAULT_VIEWPORT;
  const captureAtMs = Math.min(
    run.settings?.preview?.captureAtMs ?? DEFAULT_CAPTURE_AT_MS,
    options.videoDurationMs
  );
  const needsPreview = Boolean(options.force || !run.assets?.preview);
  const needsVideo = Boolean(options.force || !hasCapturedVideo(run));
  const htmlAsset = run.assets?.html ?? DEFAULT_HTML_ASSET;
  const previewAsset = run.assets?.preview ?? DEFAULT_PREVIEW_ASSET;
  const videoAsset = run.assets?.video ?? DEFAULT_VIDEO_ASSET;
  const mp4Asset = run.assets?.videoMp4 ?? DEFAULT_MP4_ASSET;
  const htmlPath = join(run.runDirectory, htmlAsset);
  const previewPath = join(run.runDirectory, previewAsset);
  const videoPath = join(run.runDirectory, videoAsset);
  const mp4Path = join(run.runDirectory, mp4Asset);
  const previewCapturePath = options.force ? join(run.runDirectory, ".capture-preview.png") : previewPath;
  const videoCapturePath = options.force ? join(run.runDirectory, ".capture-preview.webm") : videoPath;
  const mp4CapturePath = options.force ? join(run.runDirectory, ".capture-preview.mp4") : mp4Path;
  const videoDirectory = join(run.runDirectory, ".capture-video");
  let convertedMp4 = false;

  if (!needsPreview && !needsVideo) {
    return { captured: false, run };
  }

  await assertFileExists(htmlPath);
  await mkdir(run.runDirectory, { recursive: true });
  if (options.force) {
    await Promise.all([
      rm(previewCapturePath, { force: true }),
      rm(videoCapturePath, { force: true }),
      rm(mp4CapturePath, { force: true })
    ]);
  }
  if (needsVideo) {
    await rm(videoDirectory, { recursive: true, force: true });
    await mkdir(videoDirectory, { recursive: true });
  }

  const launchArgs = captureChromiumLaunchArgs();
  console.log(`[capture] chromium launch args: ${launchArgs.join(" ")}`);
  const browser = await chromium.launch({
    headless: true,
    args: launchArgs
  });
  let video;
  let frameRate: AnimationFrameRateMeasurement | undefined;
  let context;

  try {
    context = await browser.newContext({
      viewport,
      ...(needsVideo
        ? {
            recordVideo: {
              dir: videoDirectory,
              size: viewport
            }
          }
        : {})
    });
    const page = await context.newPage();
    video = page.video() ?? undefined;

    await page.goto(pathToFileURL(htmlPath).href, {
      waitUntil: "load",
      timeout: 30000
    });

    if (captureAtMs > 0) {
      await page.waitForTimeout(captureAtMs);
    }

    if (needsPreview) {
      await page.screenshot({
        path: previewCapturePath,
        fullPage: false
      });
      console.log(`[capture] preview saved: ${previewCapturePath}`);
    }

    if (needsVideo) {
      frameRate = await measureAnimationFrameRate(page, {
        minFps: DEFAULT_MIN_CAPTURE_RENDER_FPS,
        sampleMs: DEFAULT_FRAME_RATE_SAMPLE_MS,
        warmupMs: DEFAULT_FRAME_RATE_WARMUP_MS
      });
      console.log(
        `[capture] measured render FPS: ${frameRate.fps.toFixed(1)} ` +
          `(${frameRate.frames} frame(s) over ${Math.round(frameRate.durationMs)}ms, ` +
          `minimum ${frameRate.minFps})`
      );
      if (!isAnimationFrameRateAcceptable(frameRate)) {
        console.warn(`[capture] ${captureFrameRateErrorMessage(frameRate, viewport)}`);
      }
    }

    const remainingMs = Math.max(0, options.videoDurationMs - captureAtMs);
    if (needsVideo && remainingMs > 0) {
      await page.waitForTimeout(remainingMs);
    }

    await context.close();
    context = undefined;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    await browser.close();
  }

  if (needsVideo && video) {
    const recordedVideoPath = await video.path();
    await rename(recordedVideoPath, videoCapturePath);
    console.log(`[capture] webm saved: ${videoCapturePath}`);
    await assertVideoHasVisibleFrames(videoCapturePath);
    await rm(videoDirectory, { recursive: true, force: true });
    convertedMp4 = await convertWebmToMp4IfAvailable(videoCapturePath, mp4CapturePath, options.videoDurationMs);
    if (convertedMp4) {
      console.log(`[capture] mp4 saved: ${mp4CapturePath}`);
    } else {
      console.warn("[capture] mp4 conversion skipped or failed; install ffmpeg for Safari-friendly MP4 output");
    }
  }

  if (options.force) {
    if (needsPreview) {
      await rename(previewCapturePath, previewPath);
    }
    if (needsVideo) {
      await rename(videoCapturePath, videoPath);
    }
    if (convertedMp4) {
      await rename(mp4CapturePath, mp4Path);
    } else if (needsVideo) {
      await rm(mp4Path, { force: true });
    }
  }

  const timestamp = options.now.toISOString();
  const nextAssets = {
    ...run.assets,
    html: htmlAsset,
    ...(needsPreview ? { preview: previewAsset } : {}),
    ...(needsVideo ? { video: videoAsset } : {}),
    ...(convertedMp4 ? { videoMp4: mp4Asset } : {})
  };
  if (options.force && needsVideo && !convertedMp4) {
    delete nextAssets.videoMp4;
  }
  const nextRun = await writeUpdatedRunMetadata(run, {
    assets: nextAssets,
    capture: {
      ...run.capture,
      ...(needsPreview
        ? {
            preview: {
              status: "ready",
              path: previewAsset,
              capturedAt: timestamp
            } satisfies RunCaptureAsset
          }
        : {}),
      ...(needsVideo
        ? {
            video: {
              status: "ready",
              path: videoAsset,
              capturedAt: timestamp,
              ...(frameRate
                ? {
                    quality: {
                      measuredFps: Number(frameRate.fps.toFixed(1)),
                      minFps: frameRate.minFps,
                      sampleMs: Math.round(frameRate.durationMs),
                      frames: frameRate.frames,
                      viewport,
                      launchArgs
                    }
                  }
                : {})
            } satisfies RunCaptureAsset
          }
        : {})
    },
    updatedAt: timestamp
  });

  return {
    captured: true,
    run: nextRun
  };
}

async function markCaptureFailed(
  run: RunMetadata,
  error: unknown,
  now: Date
): Promise<void> {
  const timestamp = now.toISOString();
  const runError = toRunError(error);
  const frameRate = parseFrameRateFromError(runError.message);
  const previewAsset = run.assets?.preview ?? DEFAULT_PREVIEW_ASSET;
  const videoAsset = run.assets?.video ?? DEFAULT_VIDEO_ASSET;
  const previewReady = await fileExists(join(run.runDirectory, previewAsset));
  const preview = previewReady
    ? {
        status: "ready" as const,
        path: previewAsset,
        capturedAt: timestamp
      }
    : !run.assets?.preview
    ? {
        status: "failed" as const,
        path: previewAsset,
        capturedAt: timestamp,
        error: runError
      }
    : run.capture?.preview;
  const video = {
    status: "failed" as const,
    path: videoAsset,
    capturedAt: timestamp,
    error: runError,
    ...(frameRate
      ? {
          quality: {
            measuredFps: frameRate.measuredFps,
            minFps: frameRate.minFps,
            viewport: frameRate.viewport
          }
        }
      : {})
  };
  const nextAssets = {
    ...run.assets,
    ...(previewReady ? { preview: previewAsset } : {}),
    video: undefined,
    videoMp4: undefined
  };

  await writeUpdatedRunMetadata(run, {
    status: "failed",
    failedAt: timestamp,
    completedAt: undefined,
    error: runError,
    assets: nextAssets,
    capture: {
      ...run.capture,
      ...(preview ? { preview } : {}),
      video
    },
    updatedAt: timestamp
  });
}

async function markCaptureCompleted(run: RunMetadata, now: Date): Promise<void> {
  const timestamp = now.toISOString();
  await writeUpdatedRunMetadata(run, {
    status: "completed",
    completedAt: timestamp,
    failedAt: undefined,
    error: undefined,
    updatedAt: timestamp
  });
}

async function writeUpdatedRunMetadata(
  run: RunMetadata,
  update: Partial<RunMetadata>
): Promise<RunMetadata> {
  const metadataAsset = run.assets?.metadata ?? "metadata.json";
  const metadataPath = join(run.runDirectory, metadataAsset);
  const current = JSON.parse(await readFile(metadataPath, "utf8")) as RunMetadata;
  const next: RunMetadata = {
    ...current,
    ...update,
    assets: {
      ...current.assets,
      ...update.assets,
      metadata: current.assets?.metadata ?? metadataAsset
    },
    capture: {
      ...current.capture,
      ...update.capture
    }
  };

  await writeFile(metadataPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

async function measureAnimationFrameRate(
  page: CapturePage,
  options: {
    minFps: number;
    sampleMs: number;
    warmupMs: number;
  }
): Promise<AnimationFrameRateMeasurement> {
  return page.evaluate(
    ({ minFps, sampleMs, warmupMs }) =>
      new Promise<AnimationFrameRateMeasurement>((resolve) => {
        let frameCount = 0;
        let sampleStart = 0;
        let previousFrame = 0;
        let maxFrameGapMs = 0;
        let settled = false;

        function finish(now: number) {
          if (settled) return;
          settled = true;
          const durationMs = Math.max(1, now - sampleStart);
          resolve({
            frames: frameCount,
            durationMs,
            fps: frameCount / (durationMs / 1000),
            minFps,
            maxFrameGapMs
          });
        }

        function sample(now: number) {
          if (frameCount > 0) {
            maxFrameGapMs = Math.max(maxFrameGapMs, now - previousFrame);
          }
          frameCount += 1;
          previousFrame = now;

          if (now - sampleStart >= sampleMs) {
            finish(now);
            return;
          }

          requestAnimationFrame(sample);
        }

        function begin(now: number) {
          sampleStart = now;
          previousFrame = now;
          requestAnimationFrame(sample);
          window.setTimeout(
            () => finish(performance.now()),
            sampleMs + Math.max(1000, sampleMs)
          );
        }

        requestAnimationFrame((firstFrame) => {
          if (warmupMs <= 0) {
            begin(firstFrame);
            return;
          }

          const warmupStart = firstFrame;
          function warmup(now: number) {
            if (now - warmupStart >= warmupMs) {
              begin(now);
              return;
            }
            requestAnimationFrame(warmup);
          }
          requestAnimationFrame(warmup);
        });
      }),
    options
  );
}