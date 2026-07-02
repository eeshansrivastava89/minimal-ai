// oMLX model size lookup — scans ~/.omlx/models/ for MLX model directories
// to compute sizes and publishers. The oMLX API doesn't return these, so we
// read them from disk.

import { readdir, stat } from "node:fs/promises";
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

/**
 * Scan ~/.omlx/models/ for MLX model directories and return a Map of
 * basename → { sizeBytes, publisher }.
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
        await walk(fullPath, publisher ?? entry.name);
      }
    }
  }

  await walk(OMLX_MODELS_DIR, null);
  return infoByBasename;
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