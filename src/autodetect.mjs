import { basename } from "node:path";
import { existsSync } from "node:fs";
import { readGgufMetadata } from "./gguf.mjs";

// ── Detect model capabilities from GGUF metadata ──────────────────────────

export function detectCapabilities(modelPath, mmprojPath) {
  const meta = existsSync(modelPath) ? readGgufMetadata(modelPath) : {};
  const name = basename(modelPath).toLowerCase();

  // Architecture
  const architecture = meta["general.architecture"] ?? null;

  // Thinking / reasoning mode
  const hasThinkingKwargs = meta["chat_template_kwargs"] !== undefined;
  const nameHintsThinking = /qwen3|gemma-4|gemma4|deepseek-r[12]/i.test(name);
  const thinking = hasThinkingKwargs || nameHintsThinking;

  // Vision — mmproj present
  const vision = mmprojPath && existsSync(mmprojPath);

  // MTP (multi-token prediction) — detect speculative decoding
  const mtp = /mtp/i.test(name) || architecture === "qwen3";

  // Quantization
  const quant = name.match(/(Q\d_K_[A-Z]+|UD-[A-Z0-9_]+)/i)?.[1] ?? null;

  // Context size from metadata, fallback to name hints
  const metaCtx = architecture
    ? numberMeta(meta, `${architecture}.context_length`)
    : undefined;
  const ctxSize = metaCtx ?? (thinking ? 80000 : 32768);

  return { architecture, thinking, vision, mtp, quant, metaCtx, ctxSize, meta };
}

// ── Compute llama-server flags from capabilities ───────────────────────────

export function computeFlags(capabilities, modelPath, mmprojPath, draftModelPath) {
  const { thinking, mtp, quant } = capabilities;
  const isLowMem = quant && /[Qq]4[_0]/i.test(quant);

  const flags = {
    host: "127.0.0.1",
    port: 8080,
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
    argv.push("--spec-type", "draft-mtp", "--spec-draft-n-max", "2");
  }

  return { flags, argv };
}

// ── Internal helper ─────────────────────────────────────────────────────

function numberMeta(meta, key) {
  const value = key ? meta[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}