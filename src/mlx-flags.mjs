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

/** Overhead multiplier for mlx-vlm: weights × 1.5 (covers KV cache, activations, APC cache; benchmark-validated). */
const MLX_VLM_OVERHEAD_MULTIPLIER = 1.5;

/** Server process overhead in MB. */
const PROCESS_OVERHEAD_MB = 200;

/**
 * Estimate mlx-vlm memory usage (MB): model weights × 1.5 + process overhead.
 *
 * The 1.5 multiplier covers KV cache, activations, and APC cache overhead
 * (benchmark-validated; see sidequests/mlx-backend-benchmark/RESULTS.md).
 * GGUF/llama-server estimation uses the detailed path in estimate.mjs.
 *
 * @param {number} fileSizeBytes - model size on disk (sum of MLX safetensors).
 * @returns {number} estimated memory in MB.
 */
export function estimateMemoryMb(fileSizeBytes) {
  return Math.round((fileSizeBytes / MB) * MLX_VLM_OVERHEAD_MULTIPLIER + PROCESS_OVERHEAD_MB);
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
 * The wrapper script (resources/mlxvlm-server-wrapper.py) applies strict=False
 * model loading + the BatchRotatingKVCache.merge() fix, both required for
 * shared-KV architectures (Gemma 4-class). It is resolved to a real path via
 * MLX_VLM_WRAPPER; there is intentionally no raw-mlx_vlm.server path.
 *
 * @param {string} modelPath - path to the MLX model directory.
 * @param {object} [options]
 * @param {number} [options.port] - port (default DEFAULT_PORT).
 * @param {number} [options.ctxSize] - context window (passed as --max-kv-size).
 * @param {boolean} [options.thinkingEnabled=true] - whether to enable thinking.
 * @returns {{ args: string[], port: number }}
 */
export function computeMlxVlmFlags(modelPath, options = {}) {
  const port = options.port ?? DEFAULT_PORT;
  const ctxSize = options.ctxSize;
  const thinkingEnabled = options.thinkingEnabled ?? true;

  // The binary is "python3" (resolved by backendBinaryFor in backends.mjs); the
  // wrapper path is the first arg.
  const args = [
    MLX_VLM_WRAPPER,
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

  // Default max output tokens — used when the client doesn't specify max_tokens
  // in the request. Pi's OpenAI completions provider never sends max_tokens
  // (it doesn't fall back to model.maxTokens like the Anthropic provider does).
  // llama-server defaults high; mlx-vlm defaults to 2048 which is too low for
  // coding tasks. Set a generous server-side default.
  args.push("--max-tokens", "16384");

  return { args, port };
}