// llama.cpp profile setup/reconfigure (A1). The long linear prompt sequence
// lives here; shared machinery (samplers, KV block, thinking) is in
// questions.mjs; omlx.mjs and ollama.mjs hold the managed flows.

import { existsSync, statSync } from "node:fs";
import { prepareMemoryEstimate, computeMemoryTotal } from "../estimate.mjs";
import { availableRamBytes } from "../hardware.mjs";
import { findLlamaServer } from "../config.mjs";
import { formatBytes, renderList, renderMemoryEstimate, theme, status, promptConfirm, promptNumber } from "../ui.mjs";
import { execFileAsync } from "../exec.mjs";
import { detectGgufCapabilities, mtpEnabledFor } from "../capabilities.mjs";
import { matchDrafter, scanGgufModels } from "../scan.mjs";
import { capabilitySpecs } from "../model-summary.mjs";
import { applyRuntimeFlagOverrides, removeMtpDefaults, applyMtpDefaults, applyVisionDefaults, removeVisionDefaults, applyThinkingDefaults, removeThinkingDefaults } from "../profile-flags.mjs";
import { isGemma4UnifiedProjector } from "../model-family.mjs";
import {
  hint, ask, CancelSetup, askThinkingLevel, loadRecommendedSamplers,
  askSamplers, SAMPLERS, askContextAndKvCache,
} from "./questions.mjs";

export async function configureLocalProfile(profile) {
  try {
    return await configureLocalProfileInner(profile);
  } catch (err) {
    if (err instanceof CancelSetup) {
      console.log(theme.subtle("Cancelled."));
      return null;
    }
    throw err;
  }
}

async function configureLocalProfileInner(profile) {
  let configured = profile;
  const freshCaps = detectGgufCapabilities(profile.modelPath, profile.mmprojPath);
  if (freshCaps.missingContextLength) {
    console.log(status({ kind: "error", message: "\nCannot configure this model: GGUF metadata is missing context_length." }));
    console.log(theme.subtle("Without context_length, we cannot safely determine KV cache size —\nthis can cause out-of-memory errors or silent context truncation.\nUse a GGUF with complete metadata, or fix the file with a GGUF editor."));
    return null;
  }
  let drafterPath = profile.drafterPath ?? null;
  if (drafterPath && !existsSync(drafterPath)) drafterPath = null;
  if (!drafterPath) {
    const { drafters } = await scanGgufModels();
    const drafter = matchDrafter(profile.modelPath, drafters);
    if (drafter) drafterPath = drafter.path;
  }
  const hasMtp = freshCaps.mtp || Boolean(drafterPath);
  // Store the freshly detected facts wholesale (one schema, facts only);
  // the MTP enable/disable answer lives on mtpEnabled, not in capabilities.
  const caps = { ...freshCaps, mtp: hasMtp };
  configured = { ...configured, drafterPath: drafterPath ?? null, capabilities: caps };
  if (configured.disabledMmprojPath && configured.mmprojPath === null && existsSync(configured.disabledMmprojPath)) {
    configured = { ...configured, mmprojPath: configured.disabledMmprojPath, disabledMmprojPath: undefined, capabilities: { ...configured.capabilities, vision: true, visionDisabledReason: undefined } };
  }

  console.log("");
  console.log(theme.bold("Model overview"));
  console.log(renderList([
    ["Model", theme.bold(profile.label)],
    ["Detected", capabilitySpecs(caps)],
    ["Backend", "llama.cpp (local server)"],
    ["Model file", profile.modelPath],
  ]));

  if (caps.mtp) {
    console.log("");
    hint(`Predicts multiple tokens per step — 1.5–3x faster, no quality loss${configured.drafterPath ? ` · drafter: ${configured.drafterPath}` : ""}`);
    const useMtp = await ask(promptConfirm({ message: "Enable MTP speculative decoding?", initialValue: mtpEnabledFor(configured) }));
    configured = useMtp ? applyMtpDefaults(configured) : removeMtpDefaults(configured);
    if (useMtp) {
      console.log("");
      hint("Tokens the draft model predicts per step · 2 recommended · 4 aggressive");
      const specDraftNMax = await ask(promptNumber({ message: "Draft tokens per step", defaultValue: configured.flags.specDraftNMax ?? 2, min: 1, max: 8 }));
      configured = applyRuntimeFlagOverrides(configured, { specDraftNMax });
    }
  }

  if (caps.vision && profile.mmprojPath) {
    console.log("");
    const gemma4Unified = isGemma4UnifiedProjector(caps.mmprojProjectorType);
    const supported = !gemma4Unified || await runtimeSupportsGemma4Unified();
    let mmprojSize = "unknown";
    try { mmprojSize = formatBytes(statSync(profile.mmprojPath).size); } catch { /* file not found */ }
    hint(`Enables image understanding · projector ${mmprojSize} · type ${caps.mmprojProjectorType ?? "unknown"}${gemma4Unified && !supported ? " · needs llama.cpp b9549+" : ""}`);
    const useVision = await ask(promptConfirm({ message: "Enable vision?", initialValue: supported }));
    configured = useVision ? applyVisionDefaults(configured) : removeVisionDefaults(configured, gemma4Unified && !supported ? "gemma4-unified-unsupported" : "user-disabled");
  }

  if (caps.thinking) {
    console.log("");
    hint("Step-by-step reasoning — slower but better for math/code/logic · sets top-k 64, presence 0, repeat 1.1");
    const useThinking = await ask(promptConfirm({ message: "Use thinking/loop-safe defaults?", initialValue: true }));
    configured = useThinking ? applyThinkingDefaults(configured) : removeThinkingDefaults(configured);
  }

  console.log("");
  hint("Layers offloaded to GPU · 99 = all on GPU (recommended for Apple Silicon) · 0 = CPU only");
  const nGpuLayers = await ask(promptNumber({ message: "GPU layers", defaultValue: configured.flags.nGpuLayers ?? 99, min: 0, max: 999 }));
  configured = applyRuntimeFlagOverrides(configured, { nGpuLayers });

  // Model-card sampler recommendations (#17) — fetched once, stored on the
  // profile. `rec` is null when the repo has no generation_config.json or
  // the model didn't come from the HF cache.
  let rec;
  ({ configured, recommended: rec } = await loadRecommendedSamplers(configured));

  const maxCtx = caps.contextLength;
  const availableRam = availableRamBytes();
  const prepared = prepareMemoryEstimate(profile.modelPath, profile.mmprojPath, drafterPath);
  const hasKvParams = Boolean(prepared.kvParams.layers);
  configured = await askContextAndKvCache(configured, { prepared, maxCtx, availableRam, hasKvParams, applyRuntimeFlagOverrides });

  console.log("");
  console.log(theme.bold("Memory estimate"));
  console.log(renderMemoryEstimate(computeMemoryTotal(prepared, configured.flags), configured.flags));

  configured = await askSamplers(configured, rec);

  console.log("");
  hint("Tokens processed per step during prompt ingestion · 512 default · higher for long prompts");
  const batchSize = await ask(promptNumber({ message: "Batch size", defaultValue: configured.flags.batchSize, min: 1, max: 4096 }));
  configured = applyRuntimeFlagOverrides(configured, { batchSize });

  console.log("");
  hint("Concurrent request slots · 1 = single user · KV cache multiplies by slots");
  const parallel = await ask(promptNumber({ message: "Parallel slots", defaultValue: configured.flags.parallel, min: 1, max: 10 }));
  configured = applyRuntimeFlagOverrides(configured, { parallel });

  console.log("");
  hint("Faster, less memory · on for modern hardware · off only for old driver issues");
  const flashAttn = await ask(promptConfirm({ message: "Enable flash attention?", initialValue: true }));
  configured = applyRuntimeFlagOverrides(configured, { flashAttention: flashAttn ? "on" : "off" });

  console.log("");
  hint("Proper chat formatting · on for modern models · off only for very old models");
  const jinja = await ask(promptConfirm({ message: "Enable Jinja templates?", initialValue: true }));
  configured = applyRuntimeFlagOverrides(configured, { jinja });

  configured = await askThinkingLevel(configured, "llama-cpp");

  console.log("");
  console.log(theme.bold("Configuration summary"));
  console.log(renderList([
    ["Model", theme.bold(configured.label)],
    ["Backend", configured.backend],
    ["Endpoint", configured.baseUrl],
    ["Context", `${configured.flags.ctxSize.toLocaleString()} tokens`],
    ["GPU layers", String(configured.flags.nGpuLayers)],
    ["KV cache", `${configured.flags.cacheTypeK}/${configured.flags.cacheTypeV}`],
    ...SAMPLERS.map((s) => [s.label, String(configured.flags[s.field])]),
    ["Batch size", String(configured.flags.batchSize)],
    ["Parallel", String(configured.flags.parallel)],
    ["Flash attention", configured.flags.flashAttention],
    ["Jinja", configured.flags.jinja ? "on" : "off"],
    ["Thinking", configured.thinkingLevel ?? "harness default"],
    // NOTE: thinking capability is folded into the single Thinking row
    // above — a second "Thinking: enabled" row here was duplicate noise.
    ...(mtpEnabledFor(configured) ? [["MTP", `enabled (${configured.flags.specDraftNMax ?? 2} draft tokens)`]] : []),
    ...(configured.capabilities?.vision ? [["Vision", "enabled"]] : []),
  ]));

  if (!(await ask(promptConfirm({ message: "Save profile with these settings?", initialValue: true })))) return null;
  return configured;
}

async function runtimeSupportsGemma4Unified() {
  try {
    const binary = await findLlamaServer();
    if (!binary) return false;
    const { stdout, stderr } = await execFileAsync(binary, ["--version"]);
    const output = `${stdout}\n${stderr}`;
    const version = Number(output.match(/version:\s*(\d+)/i)?.[1]);
    return Number.isFinite(version) && version >= 9549;
  } catch {
    return false;
  }
}