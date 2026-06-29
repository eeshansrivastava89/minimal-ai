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
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { getModelScanDirs } from "./config.mjs";

// ── Folder → backend mapping ──────────────────────────────────────────────
// The oMLX folder is oMLX-exclusive: models there are served by the oMLX
// managed backend, NOT by mlx-vlm. Every OTHER scan dir is format-based
// (GGUF → llama.cpp, MLX → mlx-vlm). So mlx-vlm scans all configured dirs
// EXCEPT the oMLX folder.
const OMLX_MODELS_DIR = join(homedir(), ".omlx", "models");
function isOmlxFolder(p) {
  return p === OMLX_MODELS_DIR || p.startsWith(OMLX_MODELS_DIR + "/");
}

const MIN_MLX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB — skip tiny test/embedding MLX dirs

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

// ── Source label inference ────────────────────────────────────────────────

/** Infer a human-readable source label from a scan path. */
export function inferSourceLabel(scanPath) {
  const name = basename(scanPath).replace(/^\./, "");
  const parent = basename(dirname(scanPath));
  // Generic container folders (models, hub, cache) should use the parent name.
  if (name === "models" || name === "hub" || name === "cache") {
    return parent.replace(/^\./, "");
  }
  return name;
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
      if (sizeBytes < MIN_MLX_SIZE_BYTES) return;
      if (await isEmbeddingMlxModel(join(dir, "config.json"))) return;
      models.push(makeMlxModel(dir, basename(dir), sizeBytes, sourceLabel, rootDir));
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "README.md" || entry.name === ".gitattributes") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await isMlxModelDir(fullPath)) {
          const sizeBytes = await getMlxDirSizeBytes(fullPath);
          if (sizeBytes < MIN_MLX_SIZE_BYTES) continue;
          if (await isEmbeddingMlxModel(join(fullPath, "config.json"))) continue;
          models.push(makeMlxModel(fullPath, entry.name, sizeBytes, sourceLabel, rootDir));
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
      if (sizeBytes < MIN_MLX_SIZE_BYTES) continue;
      if (await isEmbeddingMlxModel(join(snapshotPath, "config.json"))) continue;
      models.push({
        id: `${sourceLabel}:${entry.name}`,
        label,
        path: snapshotPath,
        filePath: snapshotPath,
        sizeBytes,
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

const MLX_EMBEDDING_MODEL_TYPES = new Set([
  "bert",
  "roberta",
  "mpnet",
  "nomic_bert",
  "jina",
  "e5",
  "gte",
  "bge",
  "all_minilm",
  "sentence_transformers",
]);

async function isEmbeddingMlxModel(configPath) {
  if (!existsSync(configPath)) return false;
  try {
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    const textConfig = config.text_config ?? config;
    const modelType = String(textConfig.model_type ?? "").toLowerCase();
    if (MLX_EMBEDDING_MODEL_TYPES.has(modelType)) return true;
    const arch = Array.isArray(config.architectures) ? config.architectures[0] : "";
    const lowerArch = String(arch).toLowerCase();
    return MLX_EMBEDDING_MODEL_TYPES.has(lowerArch) || lowerArch.includes("bert");
  } catch {
    return false;
  }
}

// ── MLX model entry builder ───────────────────────────────────────────────

function makeMlxModel(dir, label, sizeBytes, sourceLabel, rootDir) {
  return {
    id: `${sourceLabel}:${dir.replace(rootDir + "/", "")}`,
    label,
    path: dir,
    filePath: dir,
    sizeBytes,
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

/**
 * Parse an MLX model's config.json to extract architecture parameters.
 * Looks for `text_config` first (multimodal models), then the top level.
 * @param {string} modelDir - path to the MLX model directory.
 * @returns {Promise<object|null>} architecture params or null.
 */
export async function parseMlxArchitecture(modelDir) {
  const configPath = join(modelDir, "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    const textConfig = config.text_config ?? config;
    const numHiddenLayers = textConfig.num_hidden_layers;
    const hiddenSize = textConfig.hidden_size;
    const numAttentionHeads = textConfig.num_attention_heads;
    if (!numHiddenLayers || !hiddenSize || !numAttentionHeads) return null;
    const numKeyValueHeads = textConfig.num_key_value_heads ?? numAttentionHeads;
    const headDim = textConfig.head_dim ?? Math.floor(hiddenSize / numAttentionHeads);
    return { numHiddenLayers, hiddenSize, numAttentionHeads, numKeyValueHeads, headDim };
  } catch {
    return null;
  }
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

  const thinking = /qwen3|qwen3\.\d|gemma-4|gemma4|deepseek-r[12]/i.test(name + " " + label);

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
