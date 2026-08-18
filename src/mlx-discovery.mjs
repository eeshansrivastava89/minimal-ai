// oMLX model size lookup — scans ~/.omlx/models/ for MLX model directories
// to compute sizes and publishers. The oMLX API doesn't return these, so we
// read them from disk.

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

async function getMlxModelType(dir) {
  try {
    const raw = await readFile(join(dir, "config.json"), "utf8");
    const config = JSON.parse(raw);
    return typeof config.model_type === "string" ? config.model_type : null;
  } catch {
    return null;
  }
}

/**
 * Check if an oMLX model directory is vision-capable.
 * MLX-VLM models declare a vision_config section in config.json.
 */
export async function detectOmlxVision(modelDir) {
  try {
    const raw = await readFile(join(modelDir, "config.json"), "utf8");
    const config = JSON.parse(raw);
    return config.vision_config != null && typeof config.vision_config === "object";
  } catch {
    return false;
  }
}

/**
 * Scan ~/.omlx/models/ for MLX model directories and return a Map of
 * basename → { sizeBytes, publisher, modelType }.
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
        const modelType = await getMlxModelType(fullPath);
        if (sizeBytes > 0) infoByBasename.set(entry.name, { sizeBytes, publisher, modelType });
      } else {
        await walk(fullPath, publisher ?? entry.name);
      }
    }
  }

  await walk(OMLX_MODELS_DIR, null);
  return infoByBasename;
}

// ── MTP capability detection ─────────────────────────────────────────────
// oMLX supports native MTP for Qwen 3.5/3.6 (dense + MoE) and DeepSeek-V4
// models that ship MTP heads in their weights. The check mirrors oMLX's own
// _mtp_compat_for_model: config must declare mtp_num_hidden_layers, model_type
// must be on the whitelist, and the safetensors index must contain mtp.* keys.

const MTP_MODEL_TYPES = ["qwen3_5", "qwen3_5_moe", "qwen3_6", "qwen3_6_moe", "deepseek_v4"];

/**
 * Check if an oMLX model directory supports native MTP.
 * Returns { compatible: boolean, reason: string }.
 */
export async function detectOmlxMtpCapability(modelDir) {
  const configPath = join(modelDir, "config.json");
  if (!existsSync(configPath)) return { compatible: false, reason: "config.json not found" };

  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return { compatible: false, reason: "failed to read config.json" };
  }

  const mtpLayers = config.mtp_num_hidden_layers;
  if (!mtpLayers || mtpLayers <= 0) {
    return { compatible: false, reason: "model has no MTP heads in config" };
  }

  const modelType = config.model_type;
  if (!MTP_MODEL_TYPES.some((t) => modelType === t || modelType?.startsWith(t))) {
    return { compatible: false, reason: `model_type=${modelType} is not on the MTP whitelist (supported: ${MTP_MODEL_TYPES.join(", ")})` };
  }

  // Check for mtp.* weight tensors in the safetensors index
  const hasWeights = await modelHasMtpWeights(modelDir);
  if (!hasWeights) {
    return { compatible: false, reason: "Config declares MTP layers but the converted weights are missing mtp.* tensors. Re-convert from HF with a converter that preserves MTP weights." };
  }

  return { compatible: true, reason: "" };
}

async function modelHasMtpWeights(modelDir) {
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