// ── Unified capability detection (issue #12) ─────────────────────────────
// One schema, one detector, dumb consumers.
//
// FACTS (stored on profile.capabilities at setup/reconfigure by this module):
//   architecture, quant, thinking, vision, mtp, contextLength, tools
//   llama.cpp extras: qat, imatrix, mmprojProjectorType, missingContextLength
//   Ollama runtime extra: servedContext (written by run.mjs after the model
//   loads — the VRAM-fit window Ollama actually serves, not the model max)
//
// CHOICES (user decisions, never inside capabilities):
//   profile.thinkingLevel, profile.mtpEnabled, llama.cpp profile.flags
//
// Each backend has one adapter that fills the same shape from its
// authoritative source:
//   llama.cpp → GGUF file metadata
//   oMLX      → model config.json + safetensors index (+ server max_model_len)
//   Ollama    → /api/show capabilities + model_info
// The name-hint regex is the documented last resort for thinking — it lives
// in model-family.mjs with the other family heuristics. Consumers (picker,
// estimates, harness configs) render the stored shape; they never re-derive.

import { basename } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readGgufMetadataSafe, numberMeta, resolveQuant } from "./gguf.mjs";
import { findOmlxModelDir, readOmlxModelConfig, mlxModelHasMtpWeights } from "./mlx-discovery.mjs";
import { ollamaModelInfo } from "./ollama-runtime.mjs";
import { nameHintsThinking } from "./model-family.mjs";

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Detect capability facts for a model. Source shape:
 *   { backend: "llama-cpp", modelPath, mmprojPath }
 *   { backend: "omlx", modelId, contextLength? }  (contextLength = server-reported max_model_len when known)
 *   { backend: "ollama", modelId }
 */
export async function detectCapabilities(source) {
  if (source.backend === "omlx") return await detectOmlxCapabilities(source);
  if (source.backend === "ollama") return await detectOllamaCapabilities(source);
  return detectGgufCapabilities(source.modelPath, source.mmprojPath);
}

// The name-hint regex (documented last resort for thinking) lives in
// model-family.mjs with the other family predicates; re-exported here so
// existing consumers keep importing from the capability module.
export { nameHintsThinking } from "./model-family.mjs";

// ── llama.cpp adapter: GGUF metadata ───────────────────────────────────────

export function detectGgufCapabilities(modelPath, mmprojPath) {
  const meta = readGgufMetadataSafe(modelPath);
  const mmprojMeta = mmprojPath ? readGgufMetadataSafe(mmprojPath) : {};
  const pathHints = String(modelPath).toLowerCase();

  const architecture = meta["general.architecture"] ?? null;

  // Thinking / reasoning mode
  const thinking = meta["chat_template_kwargs"] !== undefined || nameHintsThinking(pathHints);

  // QAT is explicit quantization-aware training lineage, mainly seen in
  // Gemma QAT releases. imatrix is common GGUF quantization metadata and is
  // intentionally tracked separately so we don't label every imatrix quant as QAT.
  const qat = /\bqat\b|[-_]qat[-_]|qat[-_]?q\d/i.test(pathHints);
  const imatrix = /imatrix|i-?matrix/i.test(pathHints) || Object.keys(meta).some((key) => key.startsWith("quantize.imatrix."));

  // Vision — mmproj present
  const vision = Boolean(mmprojPath && existsSync(mmprojPath));
  const mmprojProjectorType = stringMeta(mmprojMeta, "clip.vision.projector_type") ?? stringMeta(mmprojMeta, "clip.audio.projector_type") ?? null;

  // MTP (multi-token prediction) — speculative decoding support.
  // Do not treat all Qwen models as MTP; require an explicit filename or metadata hint.
  const mtp = /\bmtp\b|draft-mtp|multi-token/i.test(pathHints) || Object.keys(meta).some((key) => /mtp|draft|speculative/i.test(key));

  // Quantization — prefer GGUF metadata (general.file_type), fall back to filename
  const quant = resolveQuant(meta, basename(modelPath));

  // Context size from metadata — required for safe configuration.
  // Missing context_length means we cannot determine KV cache size, which
  // can cause OOM or silent context truncation. Block the model instead of
  // guessing.
  const contextLength = architecture
    ? numberMeta(meta, `${architecture}.context_length`) ?? null
    : null;

  return {
    architecture,
    quant,
    thinking,
    vision,
    mtp,
    contextLength,
    qat,
    imatrix,
    mmprojProjectorType,
    ...(contextLength ? {} : { missingContextLength: true }),
  };
}

// ── oMLX adapter: config.json + safetensors index ─────────────────────────

// oMLX supports native MTP for Qwen 3.5/3.6 (dense + MoE) and DeepSeek-V4
// models that ship MTP heads in their weights. The check mirrors oMLX's own
// _mtp_compat_for_model: config must declare mtp_num_hidden_layers, model_type
// must be on the whitelist, and the safetensors index must contain mtp.* keys.
const MTP_MODEL_TYPES = ["qwen3_5", "qwen3_5_moe", "qwen3_6", "qwen3_6_moe", "deepseek_v4"];

export async function detectOmlxCapabilities({ modelId, contextLength = null }) {
  const facts = {
    architecture: null,
    quant: null,
    thinking: undefined,
    vision: false,
    mtp: false,
    mtpReason: "",
    contextLength,
  };

  const modelDir = await findOmlxModelDir(modelId);
  if (modelDir) {
    const config = await readOmlxModelConfig(modelDir);
    if (config) {
      facts.architecture = typeof config.model_type === "string" ? config.model_type : null;
      // MLX-VLM models declare a vision_config section in config.json.
      facts.vision = config.vision_config != null && typeof config.vision_config === "object";
      if (facts.contextLength == null && Number.isFinite(config.max_position_embeddings)) {
        facts.contextLength = config.max_position_embeddings;
      }
      const mtp = await omlxMtpCompatibility(modelDir, config);
      facts.mtp = mtp.compatible;
      facts.mtpReason = mtp.reason;
    }
    const templateThinking = await omlxTemplateHintsThinking(modelDir);
    if (templateThinking !== undefined) facts.thinking = templateThinking;
  }

  if (facts.thinking === undefined) facts.thinking = nameHintsThinking(modelId) || undefined;
  return facts;
}

async function omlxMtpCompatibility(modelDir, config) {
  const mtpLayers = config.mtp_num_hidden_layers;
  if (!mtpLayers || mtpLayers <= 0) {
    return { compatible: false, reason: "model has no MTP heads in config" };
  }
  const modelType = config.model_type;
  if (!MTP_MODEL_TYPES.some((t) => modelType === t || modelType?.startsWith(t))) {
    return { compatible: false, reason: `model_type=${modelType} is not on the MTP whitelist (supported: ${MTP_MODEL_TYPES.join(", ")})` };
  }
  if (!await mlxModelHasMtpWeights(modelDir)) {
    return { compatible: false, reason: "Config declares MTP layers but the converted weights are missing mtp.* tensors. Re-convert from HF with a converter that preserves MTP weights." };
  }
  return { compatible: true, reason: "" };
}

// oMLX applies the model's chat template; templates that read enable_thinking
// prove the model can think. More authoritative than the model name.
async function omlxTemplateHintsThinking(modelDir) {
  try {
    const raw = await readFile(join(modelDir, "tokenizer_config.json"), "utf8");
    const config = JSON.parse(raw);
    const template = typeof config.chat_template === "string" ? config.chat_template : "";
    if (/enable_thinking|thinking_budget|\bthink\b/i.test(template)) return true;
  } catch { /* no readable tokenizer config */ }
  if (existsSync(join(modelDir, "chat_template.jinja"))) {
    try {
      const template = await readFile(join(modelDir, "chat_template.jinja"), "utf8");
      if (/enable_thinking|thinking_budget|\bthink\b/i.test(template)) return true;
    } catch { /* unreadable */ }
  }
  return undefined;
}

// ── Ollama adapter: /api/show ─────────────────────────────────────────────

export async function detectOllamaCapabilities({ modelId }) {
  const info = await ollamaModelInfo(modelId);
  const caps = Array.isArray(info.capabilities) ? info.capabilities : null;
  const modelInfo = info.model_info ?? {};

  // e.g. "llama.context_length": 262144 — the model's metadata maximum
  // (NOT the VRAM-fit served context; that fact arrives via run.mjs).
  let contextLength = null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (/\.context_length$/u.test(key) && Number.isFinite(value)) {
      contextLength = value;
      break;
    }
  }

  return {
    architecture: typeof modelInfo["general.architecture"] === "string" ? modelInfo["general.architecture"] : null,
    quant: info.details?.quantization_level ?? null,
    // The capabilities array is authoritative when present; only without it
    // do we fall back to name hints.
    thinking: caps ? caps.includes("thinking") : (nameHintsThinking(modelId) || undefined),
    vision: caps ? caps.includes("vision") : false,
    tools: caps ? caps.includes("tools") : false,
    mtp: Object.keys(modelInfo).some((key) => /mtp/i.test(key)),
    contextLength,
  };
}

// ── Choices ────────────────────────────────────────────────────────────────

/**
 * Whether the user chose to enable MTP for this profile.
 * Legacy (pre-#12) profiles stored the Reconfigure answer inside
 * capabilities.mtp; read it only when no explicit choice exists. New
 * profiles always set mtpEnabled when the MTP question was asked, and
 * capabilities.mtp is the pure fact.
 */
export function mtpEnabledFor(profile) {
  if (typeof profile.mtpEnabled === "boolean") return profile.mtpEnabled;
  return profile.capabilities?.mtp === true;
}

// ── Migration ──────────────────────────────────────────────────────────────

/**
 * Normalize a profile loaded from disk to the current schema:
 * - legacy llama-cpp-mtp backend → llama-cpp with mtp fact
 * - capabilities.ctxSize / metaCtx (pre-#12 llama.cpp facts) → contextLength
 */
export function migrateProfile(profile) {
  let migrated = profile;
  if (migrated.backend === "llama-cpp-mtp") {
    migrated = {
      ...migrated,
      backend: "llama-cpp",
      providerId: "llama-cpp",
      capabilities: { ...(migrated.capabilities ?? {}), mtp: true },
    };
  }
  const caps = migrated.capabilities;
  if (caps && caps.contextLength == null) {
    const legacy = caps.ctxSize ?? caps.metaCtx;
    if (typeof legacy === "number") {
      const rest = { ...caps };
      delete rest.ctxSize;
      delete rest.metaCtx;
      migrated = { ...migrated, capabilities: { ...rest, contextLength: legacy } };
    }
  }
  return migrated;
}

function stringMeta(meta, key) {
  const value = key ? meta[key] : undefined;
  return typeof value === "string" && value ? value : undefined;
}
