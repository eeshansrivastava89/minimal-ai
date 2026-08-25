import { defaultFlagsForBackend } from "./backends.mjs";

// ── Compute llama-server flags from capabilities ───────────────────────────
// Capability DETECTION lives in capabilities.mjs (one detector, all
// backends). This module only turns detected facts + user choices into
// llama-server flags.

// Sampler defaults baked into every fresh llama.cpp profile (computeFlags).
// Exported so the setup wizard can tell a user-customized value from a
// never-touched default — that distinction is what lets us seed a
// model-card recommendation only on uncustomized fields (#17) without
// silently overriding a value the user deliberately set.
export const GENERAL_SAMPLER_DEFAULTS = {
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  minP: 0,
  presencePenalty: 1.0,
  repeatPenalty: 1.0,
};

export const THINKING_SAMPLER_DEFAULTS = {
  temperature: 0.6,
  topP: 0.95,
  topK: 64,
  minP: 0,
  presencePenalty: 0,
  repeatPenalty: 1.1,
};

/** True when a saved sampler value still matches a fresh-profile default
 *  (general OR thinking variant) — i.e. the user never changed it. */
export function isUncustomizedSampler(field, value) {
  return value === GENERAL_SAMPLER_DEFAULTS[field] || value === THINKING_SAMPLER_DEFAULTS[field];
}

export function computeFlags(capabilities, modelPath, mmprojPath, draftModelPath, flagOverrides = {}) {
  const { thinking, mtp, quant } = capabilities;
  const isLowMem = quant && /[Qq]4[_0]/i.test(quant);

  const samplerDefaults = thinking ? THINKING_SAMPLER_DEFAULTS : GENERAL_SAMPLER_DEFAULTS;

  const flags = {
    ...defaultFlagsForBackend("llama-cpp"),
    ctxSize: capabilities.contextLength,
    nGpuLayers: 99,
    flashAttention: "on",
    cacheTypeK: isLowMem ? "f16" : "bf16",
    cacheTypeV: isLowMem ? "f16" : "bf16",
    jinja: true,
    temperature: samplerDefaults.temperature,
    topP: samplerDefaults.topP,
    topK: samplerDefaults.topK,
    minP: samplerDefaults.minP,
    presencePenalty: samplerDefaults.presencePenalty,
    repeatPenalty: samplerDefaults.repeatPenalty,
    parallel: 1,
    batchSize: 512,
    specDraftNMax: 2,
    ...flagOverrides,
  };

  // Thinking mode default. At profile creation this applies the detected
  // default; at launch, callers pass choice-resolved capabilities (thinking
  // reflects the stored flags), so a user who disabled thinking keeps it off.
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
    "--n-gpu-layers", String(flags.nGpuLayers),
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

  // MTP flags — `mtp` here is the launch-time choice (see mtpEnabledFor),
  // not just the detected capability.
  if (mtp) {
    argv.push("--spec-type", "draft-mtp", "--spec-draft-n-max", String(flags.specDraftNMax));
  }

  return { flags, argv };
}
