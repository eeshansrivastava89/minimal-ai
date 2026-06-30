// MLX model discovery + metadata — scans configured model directories for MLX
// model directories and parses their config.json.
// Ported from deprecated-offgrid-desktop/src/main/model-discovery.ts +
// mlx-metadata.ts (MLX subset only).
//
// This runs ALONGSIDE offgrid-ai's existing GGUF scan (scan.mjs scanGgufModels)
// — it does not replace it. The picker (main.mjs) will merge GGUF + MLX lists.
//
// An MLX model directory is one containing config.json + one or more
// *.safetensors files. HuggingFace Hub cache layout (models--org--name) is
// detected and scanned specially.

import { readdir, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { getModelScanDirs } from "./config.mjs";
import { inferSourceLabel, MIN_MODEL_SIZE_BYTES, EMBEDDING_MODEL_TYPES } from "./discovery-shared.mjs";
import { parseModelName } from "./model-name.mjs";

// ── Folder → backend mapping ──────────────────────────────────────────────
// The oMLX folder is oMLX-exclusive: models there are served by the oMLX
// managed backend, NOT by mlx-vlm. Every OTHER scan dir is format-based
// (GGUF → llama.cpp, MLX → mlx-vlm). So mlx-vlm scans all configured dirs
// EXCEPT the oMLX folder.
const OMLX_MODELS_DIR = join(homedir(), ".omlx", "models");
function isOmlxFolder(p) {
  return p === OMLX_MODELS_DIR || p.startsWith(OMLX_MODELS_DIR + "/");
}

// ── MLX directory detection ───────────────────────────────────────────────

/** True if dir contains config.json + at least one .safetensors file. */
async function isMlxModelDir(dir) {
  if (!existsSync(join(dir, "config.json"))) return false;
  try {
    const entries = await readdir(dir);
    return entries.some((f) => f.endsWith(".safetensors"));
  } catch {
    return false;
  }
}

/** Sum the size of all .safetensors files in an MLX model dir (bytes). */
async function getMlxDirSizeBytes(dir) {
  try {
    const entries = await readdir(dir);
    const sizes = await Promise.all(
      entries.filter((f) => f.endsWith(".safetensors")).map(async (f) => {
        const s = await stat(join(dir, f));
        return s.size;
      }),
    );
    return sizes.reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}

// ── Recursive MLX scanner ─────────────────────────────────────────────────

/**
 * Recursively scan a directory for MLX model directories.
 * Searches up to maxDepth levels deep. Does NOT collect GGUF (that's scan.mjs).
 */
async function scanDirRecursiveForMlx(rootDir, sourceLabel, maxDepth = 3) {
  if (!existsSync(rootDir)) return [];
  const models = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Is this directory itself an MLX model dir? (don't recurse into it)
    if (depth > 0 && await isMlxModelDir(dir)) {
      const sizeBytes = await getMlxDirSizeBytes(dir);
      if (sizeBytes < MIN_MODEL_SIZE_BYTES) return;
      if (await isEmbeddingMlxModel(join(dir, "config.json"))) return;
      const caps = await detectMlxCapabilities(dir);
      const { display, quant } = parseModelName(basename(dir), sourceLabel);
      models.push(makeMlxModel(dir, display, sizeBytes, sourceLabel, rootDir, caps.contextLength, quant));
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "README.md" || entry.name === ".gitattributes") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await isMlxModelDir(fullPath)) {
          const sizeBytes = await getMlxDirSizeBytes(fullPath);
          if (sizeBytes < MIN_MODEL_SIZE_BYTES) continue;
          if (await isEmbeddingMlxModel(join(fullPath, "config.json"))) continue;
          const caps = await detectMlxCapabilities(fullPath);
          // Extract publisher from parent dir (LM Studio: publisher/model-dir)
          const relParts = fullPath.slice(rootDir.length + 1).split("/");
          const publisher = (sourceLabel === "lmstudio" && relParts.length >= 2) ? relParts[0] : null;
          const rawLabel = publisher ? `${publisher}/${entry.name}` : entry.name;
          const { display, quant } = parseModelName(rawLabel, sourceLabel);
          models.push(makeMlxModel(fullPath, display, sizeBytes, sourceLabel, rootDir, caps.contextLength, quant));
        } else {
          await walk(fullPath, depth + 1);
        }
      }
    }
  }

  await walk(rootDir, 0);
  return models;
}

// ── HuggingFace Hub layout ────────────────────────────────────────────────

/** True if dir looks like an HF Hub cache (has models--* subdirs). */
async function looksLikeHfHub(dir) {
  if (!existsSync(dir)) return false;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.some((e) => e.isDirectory() && e.name.startsWith("models--"));
  } catch {
    return false;
  }
}

/**
 * Scan an HF Hub cache dir for MLX model dirs.
 * HF layout: models--org--name/snapshots/hash/files
 */
async function scanHfHubForMlx(dir, sourceLabel) {
  if (!existsSync(dir)) return [];
  const models = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("models--")) continue;
      const parts = entry.name.slice("models--".length).split("--");
      const label = parts.join("/");
      const snapshotsDir = join(dir, entry.name, "snapshots");
      if (!existsSync(snapshotsDir)) continue;
      const snapshots = await readdir(snapshotsDir, { withFileTypes: true });
      // Follow symlinks (HF hub uses them; test imports use them too). A model
      // dir can have several snapshots — some incomplete/empty. Check EACH
      // snapshot and use the first that is a valid MLX model dir, rather than
      // giving up on the whole model if the first snapshot happens to be empty.
      const candidates = snapshots.filter((s) => s.isDirectory() || s.isSymbolicLink());
      let snapshotPath = null;
      for (const snap of candidates) {
        const sp = join(snapshotsDir, snap.name);
        const st = await stat(sp).catch(() => null);
        if (st?.isDirectory() && await isMlxModelDir(sp)) { snapshotPath = sp; break; }
      }

      if (!snapshotPath) continue;
      const sizeBytes = await getMlxDirSizeBytes(snapshotPath);
      if (sizeBytes < MIN_MODEL_SIZE_BYTES) continue;
      if (await isEmbeddingMlxModel(join(snapshotPath, "config.json"))) continue;
      const caps = await detectMlxCapabilities(snapshotPath);
      const { display, quant } = parseModelName(label, sourceLabel);
      models.push({
        id: `${sourceLabel}:${entry.name}`,
        label: display,
        path: snapshotPath,
        filePath: snapshotPath,
        sizeBytes,
        contextLength: caps.contextLength,
        quant,
        backend: "mlx-vlm",
        format: "mlx",
        source: sourceLabel,
      });
    }
  } catch {
    // Can't read — return what we have.
  }
  return models;
}

// ── Embedding model filtering for MLX ─────────────────────────────────────

async function isEmbeddingMlxModel(configPath) {
  if (!existsSync(configPath)) return false;
  try {
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    const textConfig = config.text_config ?? config;
    const modelType = String(textConfig.model_type ?? "").toLowerCase();
    if (EMBEDDING_MODEL_TYPES.has(modelType)) return true;
    const arch = Array.isArray(config.architectures) ? config.architectures[0] : "";
    const lowerArch = String(arch).toLowerCase();
    return EMBEDDING_MODEL_TYPES.has(lowerArch) || lowerArch.includes("bert");
  } catch {
    return false;
  }
}

// ── MLX model entry builder ───────────────────────────────────────────────

function makeMlxModel(dir, label, sizeBytes, sourceLabel, rootDir, contextLength = null, quant = null) {
  return {
    id: `${sourceLabel}:${dir.replace(rootDir + "/", "")}`,
    label,
    path: dir,
    filePath: dir,
    sizeBytes,
    contextLength,
    quant,
    backend: "mlx-vlm",
    format: "mlx",
    source: sourceLabel,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Discover all MLX models across the configured scan directories.
 * Reads scan dirs from config.mjs getModelScanDirs() — same paths GGUF uses
 * (LM Studio, HF hub, user-added). Returns a flat, deduplicated list.
 */
export async function scanMlxModels(dirs) {
  // mlx-vlm scans every configured dir EXCEPT the oMLX folder (oMLX-exclusive).
  const scanDirs = (dirs ?? await getModelScanDirs()).filter((d) => !isOmlxFolder(d));
  const results = await Promise.all(
    scanDirs.map(async (dir) => {
      const label = inferSourceLabel(dir);
      if (await looksLikeHfHub(dir)) return scanHfHubForMlx(dir, label);
      return scanDirRecursiveForMlx(dir, label);
    }),
  );
  const all = results.flat();
  // Deduplicate by filePath (same model may appear in multiple paths).
  const seen = new Set();
  return all.filter((m) => {
    if (seen.has(m.filePath)) return false;
    seen.add(m.filePath);
    return true;
  });
}

// ── MLX capability detection ─────────────────────────────────────────────

/**
 * Detect MLX model capabilities from its config.json.
 * Returns { architecture, thinking, vision, contextLength }.
 */
export async function detectMlxCapabilities(modelDir) {
  const configPath = join(modelDir, "config.json");
  if (!existsSync(configPath)) return { thinking: false, vision: false, contextLength: null, architecture: null };
  try {
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    return detectMlxCapabilitiesFromConfig(config, modelDir);
  } catch {
    return { thinking: false, vision: false, contextLength: null, architecture: null };
  }
}

export function detectMlxCapabilitiesFromConfig(config, modelDir) {
  const textConfig = config.text_config ?? config;
  const rawName = config._name_or_path ?? basename(modelDir ?? "");
  const name = String(rawName).toLowerCase();
  const label = String(rawName);

  const modelType = String(config.model_type ?? "").toLowerCase();
  const textModelType = String(textConfig.model_type ?? "").toLowerCase();

  const vision = Boolean(
    config.vision_config ||
    config.image_token_id != null ||
    config.video_token_id != null ||
    config.vision_start_token_id != null ||
    modelType.includes("vl") ||
    modelType.includes("vision") ||
    textModelType.includes("vl") ||
    textModelType.includes("vision")
  );

  const thinking = /qwen3|gemma-4|gemma4|deepseek-r[12]/i.test(name + " " + label);

  const architectures = Array.isArray(config.architectures) ? config.architectures : [];
  const architecture = architectures[0] ?? null;

  const candidates = [
    textConfig.max_position_embeddings,
    textConfig.sliding_window,
    config.max_position_embeddings,
    config.sliding_window,
  ].filter((v) => typeof v === "number" && v > 0);
  const contextLength = candidates.length > 0 ? Math.max(...candidates) : null;

  return { thinking, vision, contextLength, architecture };
}

/**
 * Pick a sensible default context length for an MLX model, capping by RAM.
 */
export function defaultMlxContextLength(trainedCtx, ramGb) {
  if (!trainedCtx || trainedCtx <= 0) return 8192;
  if (ramGb < 12) return Math.min(trainedCtx, 4096);
  if (ramGb < 16) return Math.min(trainedCtx, 8192);
  if (ramGb < 32) return Math.min(trainedCtx, 16384);
  return trainedCtx;
}

// ── oMLX model size lookup (from disk) ────────────────────────────────────

/**
 * Scan the oMLX models directory (~/.omlx/models/) for MLX model directories
 * and return a Map of basename → { sizeBytes, publisher }.  The oMLX API
 * doesn't return model sizes or publishers, so we compute them from disk.
 */
export async function scanOmlxModelSizes() {
  if (!existsSync(OMLX_MODELS_DIR)) return new Map();
  const infoByBasename = new Map();

  async function walk(dir, publisher) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(dir, entry.name);
      if (await isMlxModelDir(fullPath)) {
        const sizeBytes = await getMlxDirSizeBytes(fullPath);
        if (sizeBytes > 0) infoByBasename.set(entry.name, { sizeBytes, publisher });
      } else {
        // First-level directories under ~/.omlx/models/ are publishers
        await walk(fullPath, publisher ?? entry.name);
      }
    }
  }

  await walk(OMLX_MODELS_DIR, null);
  return infoByBasename;
}

/**
 * Look up a model's info by its oMLX API id.  Tries exact match, then the
 * segment after `--` (oMLX org--name format), then after `/` (HF format).
 */
export function lookupOmlxModelInfo(modelId, infoMap) {
  if (infoMap.has(modelId)) return infoMap.get(modelId);
  const dashIdx = modelId.indexOf("--");
  if (dashIdx >= 0 && infoMap.has(modelId.slice(dashIdx + 2))) return infoMap.get(modelId.slice(dashIdx + 2));
  const slashIdx = modelId.indexOf("/");
  if (slashIdx >= 0 && infoMap.has(modelId.slice(slashIdx + 1))) return infoMap.get(modelId.slice(slashIdx + 1));
  return null;
}