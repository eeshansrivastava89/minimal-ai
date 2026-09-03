/**
 * Capture media validation utilities.
 *
 * Extracted from capture-media.ts to separate validation/FFmpeg helpers
 * from the capture orchestration logic.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AnimationFrameRateMeasurement {
  frames: number;
  durationMs: number;
  fps: number;
  minFps: number;
  maxFrameGapMs?: number;
}

export type CapturePage = {
  evaluate<T, Arg>(pageFunction: (arg: Arg) => T | Promise<T>, arg: Arg): Promise<T>;
};

export function isAnimationFrameRateAcceptable(
  measurement: AnimationFrameRateMeasurement
): boolean {
  return measurement.fps >= measurement.minFps;
}

export function captureFrameRateErrorMessage(
  measurement: AnimationFrameRateMeasurement,
  viewport: { width: number; height: number }
): string {
  return (
    `Captured animation rendered too slowly: ${measurement.fps.toFixed(1)} FPS ` +
    `at ${viewport.width}x${viewport.height}. Minimum is ${measurement.minFps} FPS. ` +
    "Open the HTML to inspect the live version, then optimize the generated animation or recapture after editing it."
  );
}

export function parseFrameRateFromError(message: string): {
  measuredFps: number;
  minFps: number;
  viewport: { width: number; height: number };
} | undefined {
  const match = /rendered too slowly:\s*([0-9.]+)\s*FPS\s*at\s*(\d+)x(\d+).*Minimum is\s*([0-9.]+)\s*FPS/iu.exec(message);
  if (!match) return undefined;

  return {
    measuredFps: Number(match[1]),
    viewport: {
      width: Number(match[2]),
      height: Number(match[3])
    },
    minFps: Number(match[4])
  };
}

export function captureChromiumLaunchArgs(platform = process.platform): string[] {
  const args = [
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization"
  ];

  if (platform === "darwin") {
    args.push("--use-gl=angle", "--use-angle=metal");
  }

  return args;
}

export async function isVideoMostlyBlack(path: string): Promise<boolean | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        path,
        "-vf",
        "fps=1,scale=64:64:flags=area,format=rgb24",
        "-frames:v",
        "3",
        "-f",
        "rawvideo",
        "pipe:1"
      ],
      {
        encoding: "buffer",
        maxBuffer: 1024 * 1024
      }
    );
    const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    if (bytes.length === 0) {
      throw new Error("ffmpeg produced no sample frames.");
    }

    let maxChannel = 0;
    let lumaTotal = 0;
    let visiblePixels = 0;
    for (let index = 0; index < bytes.length; index += 3) {
      const red = bytes[index] ?? 0;
      const green = bytes[index + 1] ?? 0;
      const blue = bytes[index + 2] ?? 0;
      const brightestChannel = Math.max(red, green, blue);
      const darkestChannel = Math.min(red, green, blue);
      const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      maxChannel = Math.max(maxChannel, brightestChannel);
      lumaTotal += luma;
      if (brightestChannel >= 24 || (brightestChannel >= 16 && brightestChannel - darkestChannel >= 10)) {
        visiblePixels += 1;
      }
    }

    const averageLuma = lumaTotal / (bytes.length / 3);
    return visiblePixels === 0 && maxChannel < 24 && averageLuma < 8;
  } catch (error) {
    if (isMissingCommandError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function convertWebmToMp4IfAvailable(
  inputPath: string,
  outputPath: string,
  durationMs: number
): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-t",
      (durationMs / 1000).toFixed(3),
      "-an",
      "-movflags",
      "+faststart",
      "-pix_fmt",
      "yuv420p",
      outputPath
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function assertVideoHasVisibleFrames(path: string): Promise<void> {
  const mostlyBlack = await isVideoMostlyBlack(path);
  if (mostlyBlack === undefined) {
    console.warn("[capture] video validation skipped; ffmpeg is not available");
    return;
  }

  if (mostlyBlack) {
    const { rm } = await import("node:fs/promises");
    await rm(path, { force: true });
    throw new Error("Captured video appears to be black. The run was not marked video-ready.");
  }
}

export async function assertFileExists(path: string): Promise<void> {
  const result = await stat(path);
  if (!result.isFile()) {
    throw new Error(`Expected file at ${path}.`);
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    const result = await stat(path);
    return result.isFile();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

export function isMissingCommandError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function toRunError(error: unknown) {
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