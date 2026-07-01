import { basename } from "node:path";
import { existsSync } from "node:fs";
import { readGgufMetadata } from "./gguf.mjs";
import { defaultFlagsForBackend } from "./backends.mjs";
import { parseModelName } from "./model-name.mjs";

// ── Detect model capabilities from GGUF metadata ──────────────────────────

export function detectCapabilities(modelPath, mmprojPath) {
  const meta = safeReadGgufMetadata(modelPath);
  const mmprojMeta = mmprojPath ? safeReadGgufMetadata(mmprojPath) : {};
  const pathHints = String(modelPath).toLowerCase();

  // Architecture
  const architecture = meta["general.architecture"] ?? null;

  // Thinking / reasoning mode
  const hasThinkingKwargs = meta["chat_template_kwargs"] !== undefined;
  const nameHintsThinking = /qwen3|qwen3\.\d|gemma-4|gemma4|deepseek-r[12]/i.test(pathHints);
  const thinking = hasThinkingKwargs || nameHintsThinking;

  // QAT is explicit quantization-aware training lineage, mainly seen in
  // Gemma QAT releases. imatrix is common GGUF quantization metadata and is
  // intentionally tracked separately so we don't label every imatrix quant as QAT.
  const qat = /\bqat\b|[-_]qat[-_]|qat[-_]?q\d/i.test(pathHints);
  const imatrix = /imatrix|i-?matrix/i.test(pathHints) || Object.keys(meta).some((key) => key.startsWith("quantize.imatrix."));

  // Vision — mmproj present
  const vision = Boolean(mmprojPath && existsSync(mmprojPath));
  const mmprojProjectorType = stringMeta(mmprojMeta, "clip.vision.projector_type") ?? stringMeta(mmprojMeta, "clip.audio.projector_type") ?? null;

  // MTP (multi-token prediction) — detect speculative decoding.
  // Do not treat all Qwen models as MTP; require an explicit filename or metadata hint.
  const mtp = /\bmtp\b|draft-mtp|multi-token/i.test(pathHints) || Object.keys(meta).some((key) => /mtp|draft|speculative/i.test(key));

  // Quantization — use parseModelName (single path) for filename-based extraction.
  // GGUF metadata does not store a standardized quant field, so the filename
  // is the authoritative source for quant identification.
  const parsed = parseModelName(basename(modelPath).replace(/\.gguf$/i, ""), "local-gguf");
  const quant = parsed.quant;

  // Context size from metadata, fallback to name hints
  const metaCtx = architecture
    ? numberMeta(meta, `${architecture}.context_length`)
    : undefined;
  const ctxSize = metaCtx ?? (thinking ? 80000 : 32768);

  return { architecture, thinking, vision, mtp, qat, imatrix, quant, metaCtx, ctxSize, meta, mmprojProjectorType };
}

// ── Compute llama-server flags from capabilities ───────────────────────────

export function computeFlags(capabilities, modelPath, mmprojPath, draftModelPath, flagOverrides = {}) {
  const { thinking, mtp, quant } = capabilities;
  const isLowMem = quant && /[Qq]4[_0]/i.test(quant);

  const flags = {
    ...defaultFlagsForBackend(mtp ? "llama-cpp-mtp" : "llama-cpp"),
    ctxSize: capabilities.ctxSize,
    flashAttention: "on",
    cacheTypeK: isLowMem ? "f16" : "bf16",
    cacheTypeV: isLowMem ? "f16" : "bf16",
    jinja: true,
    temperature: 0.6,
    topP: 0.95,
    topK: thinking ? 64 : 20,
    minP: 0,
    presencePenalty: thinking ? 0 : 1.5,
    repeatPenalty: thinking ? 1.1 : 1.0,
    parallel: 1,
    batchSize: 512,
    ...flagOverrides,
  };

  // Thinking mode
  if (thinking) {
    flags.chatTemplateKwargs = { enable_thinking: true };
  }

  // Build argv
  const argv = [
    "--model", modelPath,
  ];

  if (mmprojPath) argv.push("--mmproj", mmprojPath);
  if (draftModelPath) argv.push("--spec-draft-model", draftModelPath);

  argv.push(
    "--host", String(flags.host),
    "--port", String(flags.port),
    "--ctx-size", String(flags.ctxSize),
    "--flash-attn", flags.flashAttention,
    "--cache-type-k", flags.cacheTypeK,
    "--cache-type-v", flags.cacheTypeV,
  );

  if (flags.jinja) argv.push("--jinja");

  argv.push(
    "--temp", String(flags.temperature),
    "--top-p", String(flags.topP),
    "--top-k", String(flags.topK),
    "--min-p", flags.minP.toFixed(2),
    "--presence-penalty", String(flags.presencePenalty),
    "--repeat-penalty", String(flags.repeatPenalty),
    "--batch-size", String(flags.batchSize),
    "--parallel", String(flags.parallel),
  );

  if (flags.chatTemplateKwargs) {
    argv.push("--chat-template-kwargs", JSON.stringify(flags.chatTemplateKwargs));
  }

  // MTP flags
  if (mtp) {
    argv.push("--spec-type", "draft-mtp", "--spec-draft-n-max", "4");
  }

  return { flags, argv };
}

// ── Internal helper ─────────────────────────────────────────────────────

function safeReadGgufMetadata(modelPath) {
  if (!existsSync(modelPath)) return {};
  try {
    return readGgufMetadata(modelPath);
  } catch {
    return {};
  }
}

function numberMeta(meta, key) {
  const value = key ? meta[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringMeta(meta, key) {
  const value = key ? meta[key] : undefined;
  return typeof value === "string" && value ? value : undefined;
}