import { defaultFlagsForBackend } from "./backends.mjs";

// ── Compute llama-server flags from capabilities ───────────────────────────
// Capability DETECTION lives in capabilities.mjs (one detector, all
// backends). This module only turns detected facts + user choices into
// llama-server flags.

export function computeFlags(capabilities, modelPath, mmprojPath, draftModelPath, flagOverrides = {}) {
  const { thinking, mtp, quant } = capabilities;
  const isLowMem = quant && /[Qq]4[_0]/i.test(quant);

  const flags = {
    ...defaultFlagsForBackend("llama-cpp"),
    ctxSize: capabilities.contextLength,
    nGpuLayers: 99,
    flashAttention: "on",
    cacheTypeK: isLowMem ? "f16" : "bf16",
    cacheTypeV: isLowMem ? "f16" : "bf16",
    jinja: true,
    temperature: 0.6,
    topP: 0.95,
    topK: thinking ? 64 : 20,
    minP: 0,
    presencePenalty: thinking ? 0 : 1.0,
    repeatPenalty: thinking ? 1.1 : 1.0,
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
