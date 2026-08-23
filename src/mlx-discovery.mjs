// oMLX model size lookup — scans ~/.omlx/models/ for MLX model directories
// to compute sizes and publishers. The oMLX API doesn't return these, so we
// read them from disk.
//
// Capability facts (vision, MTP, thinking) are detected from the same
// config.json by src/capabilities.mjs — this module owns only discovery
// (finding model dirs) and the shared file readers.

import { readdir, stat, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const OMLX_MODELS_DIR = join(homedir(), ".omlx", "models");

async function isMlxModelDir(dir) {
  if (!existsSync(join(dir, "config.json"))) return false;
  try {
    const entries = await readdir(dir);
    return entries.some((f) => f.endsWith(".safetensors"));
  } catch {
    return false;
  }
}

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

/** Read an oMLX model's config.json once; null when missing/unparseable. */
export async function readOmlxModelConfig(modelDir) {
  try {
    const raw = await readFile(join(modelDir, "config.json"), "utf8");
    const config = JSON.parse(raw);
    return config && typeof config === "object" ? config : null;
  } catch {
    return null;
  }
}

/** Whether the model's weights contain mtp.* tensors (safetensors index). */
export async function mlxModelHasMtpWeights(modelDir) {
  const indexPath = join(modelDir, "model.safetensors.index.json");
  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(await readFile(indexPath, "utf8"));
      const weightMap = index.weight_map ?? {};
      return Object.keys(weightMap).some((key) => key.includes("mtp."));
    } catch {
      return false;
    }
  }
  // Single-shard fallback: can't easily read safetensors keys in Node without
  // the safetensors library. Check for an mtp-specific safetensors file.
  try {
    const entries = await readdir(modelDir);
    return entries.some((f) => f.endsWith(".safetensors") && /mtp/i.test(f));
  } catch {
    return false;
  }
}

/**
 * Scan ~/.omlx/models/ for MLX model directories and return a Map of
 * basename → { sizeBytes, publisher, modelType, drafter }.
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
        const config = await readOmlxModelConfig(fullPath);
        const modelType = typeof config?.model_type === "string" ? config.model_type : null;
        // DFlash/DFlash2 draft checkpoints (and similar) are not chat models:
        // they carry a dflash_config block and/or a DFlash* architecture.
        const drafter = Boolean(config?.dflash_config)
          || (Array.isArray(config?.architectures) && config.architectures.some((a) => /dflash/i.test(String(a))));
        if (sizeBytes > 0) infoByBasename.set(entry.name, { sizeBytes, publisher, modelType, drafter });
      } else {
        await walk(fullPath, publisher ?? entry.name);
      }
    }
  }

  await walk(OMLX_MODELS_DIR, null);
  return infoByBasename;
}

/**
 * Find the model directory for a given oMLX model ID.
 * Searches ~/.omlx/models/ recursively for a directory matching the model ID.
 */
export async function findOmlxModelDir(modelId) {
  if (!existsSync(OMLX_MODELS_DIR)) return null;
  const basename = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId.includes("--") ? modelId.slice(modelId.lastIndexOf("--") + 2)
    : modelId;

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(dir, entry.name);
      if (entry.name === basename && await isMlxModelDir(fullPath)) return fullPath;
      const found = await walk(fullPath);
      if (found) return found;
    }
    return null;
  }

  return await walk(OMLX_MODELS_DIR);
}

/**
 * Look up a model's info by its oMLX API id. Tries exact match, then the
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
