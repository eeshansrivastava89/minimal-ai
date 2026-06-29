// mlx-vlm server flag computation — pure functions, no side effects.
// Ported from deprecated-offgrid-desktop/src/main/server-flags.ts (MLX subset).
//
// Benchmark-informed decisions (see sidequests/mlx-backend-benchmark/RESULTS.md):
// - mlx-vlm requires APC_ENABLED=1 env var (86x TTFT improvement) — set at spawn
//   time in process.mjs, NOT here (this module only computes args).
// - mlx-vlm uses a strict=False wrapper script for shared-KV architectures
//   (Gemma 4-class). Safe for all models — strict=False is a no-op for models
//   that load fine with strict=True.
// - mlx-vlm uses --enable-thinking for thinking-mode control.
// - mlx-vlm uses --max-kv-size for the KV cache / context window.
//
// Only the mlx-vlm-relevant logic is ported here. offgrid-ai's existing GGUF
// flag logic (autodetect.mjs / profile-setup.mjs / estimate.mjs) is unchanged.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MB = 1024 ** 2;

/** Default port for the local model server. Matches the desktop's DEFAULT_PORT. */
export const DEFAULT_PORT = 18080;

/** Resolved path to the bundled strict=False wrapper script (sibling of src/). */
export const MLX_VLM_WRAPPER = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "mlxvlm-server-wrapper.py");

/** Overhead multiplier for mlx-vlm: llama-server 1.25 + APC cache ~0.25 → 1.5. */
const MLX_VLM_OVERHEAD_MULTIPLIER = 1.5;

/** Overhead multiplier for llama-server (covers KV cache, activations, runtime). */
const LLAMA_SERVER_OVERHEAD_MULTIPLIER = 1.25;

/** Server process overhead in MB. */
const PROCESS_OVERHEAD_MB = 200;

/**
 * Detect the appropriate backend for the platform + model format.
 *
 * - macOS Apple Silicon + MLX format → mlx-vlm (best Metal throughput + memory
 *   efficiency, benchmark-validated).
 * - Everything else → llama-server.
 *
 * @param {object} hardware - from detectHardware() (platform, arch, totalRamBytes).
 * @param {"gguf"|"mlx"} modelFormat - the model's format.
 * @returns {"llama-server"|"mlx-vlm"}
 */
export function selectBackend(hardware, modelFormat) {
  if (hardware.platform === "darwin" && hardware.arch === "arm64" && modelFormat === "mlx") {
    return "mlx-vlm";
  }
  return "llama-server";
}

/**
 * Estimate the memory usage of running a model (in MB).
 *
 * Generic overhead-multiplier approach (Osaurus-style): fileSize × multiplier.
 * - llama-server: 1.25 (covers KV cache, activations, runtime buffers).
 * - mlx-vlm: 1.5 (same + APC cache overhead).
 *
 * @param {number} fileSizeBytes - model size on disk (GGUF file or sum of MLX safetensors).
 * @param {"llama-server"|"mlx-vlm"} backend - which server backend will be used.
 * @returns {number} estimated memory in MB.
 */
export function estimateMemoryMb(fileSizeBytes, backend) {
  const weightsMb = fileSizeBytes / MB;
  const multiplier = backend === "mlx-vlm" ? MLX_VLM_OVERHEAD_MULTIPLIER : LLAMA_SERVER_OVERHEAD_MULTIPLIER;
  return Math.round(weightsMb * multiplier + PROCESS_OVERHEAD_MB);
}

/**
 * Compute mlx-vlm server arguments.
 *
 * mlx-vlm is the MLX-native server (benchmark-validated best throughput + memory
 * efficiency on Apple Silicon). Invoked via the strict=False wrapper script for
 * compatibility with shared-KV architectures (Gemma 4-class).
 *
 * The APC_ENABLED=1 env var is MANDATORY but is set at spawn time in
 * process.mjs, not in args.
 *
 * The wrapper path "resources/mlxvlm-server-wrapper.py" is a PLACEHOLDER — the
 * spawner (process.mjs) resolves it to the real path relative to the package.
 *
 * @param {string} modelPath - path to the MLX model directory.
 * @param {object} [options]
 * @param {number} [options.port] - port (default DEFAULT_PORT).
 * @param {number} [options.ctxSize] - context window (passed as --max-kv-size).
 * @param {number} [options.memoryEstimateMb] - precomputed memory estimate.
 * @param {boolean} [options.thinkingEnabled=true] - whether to enable thinking.
 * @param {boolean} [options.useWrapper=true] - use the strict=False wrapper (vs raw mlx_vlm.server).
 * @returns {{ args: string[], port: number, memoryEstimateMb: number }}
 */
export function computeMlxVlmFlags(modelPath, options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const ctxSize = options.ctxSize;
  const memoryEstimateMb = options.memoryEstimateMb ?? 0;
  const thinkingEnabled = options.thinkingEnabled ?? true;
  const useWrapper = options.useWrapper ?? true;

  // The binary is "python3" (resolved by backendBinaryFor in backends.mjs).
  // The args start with the wrapper path (useWrapper) or "-m mlx_vlm.server" (raw).
  const cmdPrefix = useWrapper ? [MLX_VLM_WRAPPER] : ["-m", "mlx_vlm.server"];

  const args = [
    ...cmdPrefix,
    "--model", modelPath,
    "--host", "127.0.0.1",
    "--port", String(port),
  ];

  if (thinkingEnabled) {
    args.push("--enable-thinking");
  }

  // Context size: mlx-vlm uses --max-kv-size for the KV cache / context window.
  if (ctxSize && ctxSize > 0) {
    args.push("--max-kv-size", String(ctxSize));
  }

  return { args, port, memoryEstimateMb };
}