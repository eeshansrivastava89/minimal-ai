import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { estimateMemory } from "./estimate.mjs";
import { findLlamaServer } from "./config.mjs";
import { baseUrlForFlags, LLAMA_CPP_PORT, LLAMA_CPP_MTP_PORT } from "./backends.mjs";
import { pc, formatBytes, renderRows, renderSection } from "./ui.mjs";
import { detectCapabilities } from "./autodetect.mjs";
import { matchDrafter } from "./scan.mjs";
import { scanGgufModels } from "./scan.mjs";
import { estimateMemoryMb } from "./mlx-flags.mjs";
import { capabilitySummary } from "./model-summary.mjs";

const execFileAsync = promisify(execFile);

const CACHE_CHOICES = [
  { value: "bf16", label: "bf16", hint: "default: stable, good quality" },
  { value: "f16", label: "f16", hint: "stable fallback, similar memory to bf16" },
  { value: "q8_0", label: "q8_0", hint: "lower memory, usually safe" },
  { value: "q4_0", label: "q4_0", hint: "lowest memory, quality/speed tradeoff" },
];

const GENERAL_DEFAULTS = {
  topK: 20,
  presencePenalty: 1.5,
  repeatPenalty: 1.0,
};

const THINKING_DEFAULTS = {
  topK: 64,
  presencePenalty: 0,
  repeatPenalty: 1.1,
  chatTemplateKwargs: { enable_thinking: true },
};

export async function configureLocalProfile(prompt, profile) {
  let configured = profile;
  // Re-detect capabilities from the model file and check for drafters
  // so that re-setup can pick up MTP availability, vision changes, etc.
  const freshCaps = detectCapabilities(profile.modelPath, profile.mmprojPath);
  let drafterPath = profile.drafterPath ?? null;
  if (drafterPath && !existsSync(drafterPath)) {
    // Stored drafter is no longer on disk — drop it and re-scan for a fresh one.
    drafterPath = null;
  }
  if (!drafterPath) {
    const { drafters } = await scanGgufModels();
    const drafter = matchDrafter(profile.modelPath, drafters);
    if (drafter) drafterPath = drafter.path;
  }
  const hasMtp = freshCaps.mtp || Boolean(drafterPath);
  const caps = { ...freshCaps, mtp: hasMtp };
  // If MTP is newly available, switch backend and add drafter path
  if (hasMtp && configured.backend !== "llama-cpp-mtp") {
    configured = { ...configured, backend: "llama-cpp-mtp", providerId: "llama-cpp-mtp", drafterPath, capabilities: { ...configured.capabilities, mtp: true } };
  }
  // If the profile was MTP but the drafter is now gone (and the model isn't
  // natively MTP), switch back to plain llama.cpp so the server can start.
  if (!hasMtp && configured.backend === "llama-cpp-mtp") {
    console.log(pc.yellow("MTP drafter no longer found — switching to llama.cpp without speculative decoding."));
    configured = removeMtpDefaults(configured);
  }
  if (drafterPath && !configured.drafterPath) {
    configured = { ...configured, drafterPath };
  }
  // If vision was previously disabled but mmproj is back, re-enable
  if (configured.disabledMmprojPath && configured.mmprojPath === null && freshCaps.vision) {
    configured = { ...configured, mmprojPath: configured.disabledMmprojPath, disabledMmprojPath: undefined, capabilities: { ...configured.capabilities, vision: true, visionDisabledReason: undefined } };
  }

  console.log("");
  console.log(renderSection("Model setup", renderRows([
    ["Model", pc.bold(profile.label)],
    ["Detected", capabilitySummary(caps)],
    ["Context", `${profile.flags.ctxSize.toLocaleString()} tokens`],
    ["KV cache", `${profile.flags.cacheTypeK}/${profile.flags.cacheTypeV}`],
    ["Sampling", samplingSummary(profile.flags)],
  ])));
  console.log(pc.dim("Larger context windows use more memory. KV cache precision controls memory used by attention history."));
  console.log(pc.dim("Sampling defaults are shown for transparency; you can edit the profile later if needed.\n"));

  if (caps.mtp) {
    const drafterInfo = configured.drafterPath ? `\n  Drafter: ${configured.drafterPath}` : "";
    console.log(renderSection("MTP detected", renderRows([
      ["Backend", "llama.cpp MTP"],
      ["Port", String(LLAMA_CPP_MTP_PORT)],
      ["Flags", `--spec-type draft-mtp --spec-draft-n-max 4${configured.drafterPath ? " --spec-draft-model <drafter>" : ""}`],
    ])));
    if (drafterInfo) console.log(pc.dim(drafterInfo));
    const useMtp = await prompt.yesNo("Use MTP speculative decoding?", true);
    configured = useMtp ? applyMtpDefaults(configured) : removeMtpDefaults(configured);
  }

  if (caps.qat) {
    console.log("");
    console.log(renderSection("QAT detected", renderRows([
      ["Meaning", "quantization-aware trained"],
      ["Runtime flags", "none QAT-specific"],
    ])));
  }

  if (caps.vision && profile.mmprojPath) {
    console.log("");
    const gemma4Unified = isGemma4UnifiedProjector(caps.mmprojProjectorType);
    const supported = !gemma4Unified || await runtimeSupportsGemma4Unified();
    console.log(renderSection("Vision projector detected", renderRows([
      ["Projector", caps.mmprojProjectorType ?? "unknown"],
      ["Flag", `--mmproj ${profile.mmprojPath}`],
      ...(gemma4Unified && !supported ? [["Note", pc.yellow("Gemma 4 unified projectors need llama.cpp b9549+.")]] : []),
    ])));
    const useVision = await prompt.yesNo("Enable vision with --mmproj?", supported);
    configured = useVision ? applyVisionDefaults(configured) : removeVisionDefaults(configured, gemma4Unified && !supported ? "gemma4-unified-unsupported" : "user-disabled");
  }

  if (caps.thinking) {
    console.log("");
    console.log(renderSection("Thinking model detected", renderRows([
      ["Defaults", "thinking / loop-safe"],
      ["Flags", "--top-k 64 --presence-penalty 0 --repeat-penalty 1.1"],
      ["Template", "--chat-template-kwargs { enable_thinking: true }"],
    ])));
    const useThinking = await prompt.yesNo("Use these thinking/loop-safe defaults?", true);
    configured = useThinking ? applyThinkingDefaults(configured) : removeThinkingDefaults(configured);
  }

  const ctxSize = await prompt.number("Context window tokens", configured.flags.ctxSize, 1024, 1048576);
  const cacheTypeK = await prompt.choice("K cache precision", CACHE_CHOICES, configured.flags.cacheTypeK);
  const cacheTypeV = await prompt.choice("V cache precision", CACHE_CHOICES, configured.flags.cacheTypeV);
  configured = applyRuntimeFlagOverrides(configured, { ctxSize, cacheTypeK, cacheTypeV });

  console.log("");
  console.log(renderSection("Defaults", renderRows([
    ["Backend", configured.backend],
    ["Endpoint", configured.baseUrl],
    ["Temperature", configured.flags.temperature],
    ["Top-p", configured.flags.topP],
    ["Top-k", configured.flags.topK],
    ["Min-p", configured.flags.minP],
    ["Presence penalty", configured.flags.presencePenalty],
    ["Repeat penalty", configured.flags.repeatPenalty],
  ])));

  console.log("\n" + renderMemoryEstimate(configured));
  if (!(await prompt.yesNo("Save profile with these settings?", true))) return null;
  return configured;
}

export function applyRuntimeFlagOverrides(profile, overrides) {
  const flags = { ...profile.flags, ...overrides };
  return applyProfileFlags(profile, flags);
}

export function applyMtpDefaults(profile) {
  const flags = { ...profile.flags, port: LLAMA_CPP_MTP_PORT };
  return applyProfileFlags({
    ...profile,
    backend: "llama-cpp-mtp",
    providerId: "llama-cpp-mtp",
    capabilities: { ...(profile.capabilities ?? {}), mtp: true },
  }, flags);
}

export function removeMtpDefaults(profile) {
  const flags = { ...profile.flags, port: LLAMA_CPP_PORT };
  return applyProfileFlags({
    ...profile,
    backend: "llama-cpp",
    providerId: "llama-cpp",
    drafterPath: null,
    capabilities: { ...(profile.capabilities ?? {}), mtp: false },
  }, flags);
}

function applyVisionDefaults(profile) {
  if (!profile.mmprojPath) return profile;
  return applyProfileFlags({
    ...profile,
    capabilities: { ...(profile.capabilities ?? {}), vision: true, visionDisabledReason: undefined },
  }, profile.flags, { values: { "--mmproj": profile.mmprojPath } });
}

function removeVisionDefaults(profile, reason) {
  return applyProfileFlags({
    ...profile,
    disabledMmprojPath: profile.mmprojPath,
    mmprojPath: null,
    capabilities: { ...(profile.capabilities ?? {}), vision: false, visionDisabledReason: reason },
  }, profile.flags, { remove: ["--mmproj"] });
}

function applyThinkingDefaults(profile) {
  const flags = { ...profile.flags, ...THINKING_DEFAULTS };
  return applyProfileFlags(profile, flags);
}

function removeThinkingDefaults(profile) {
  const flags = { ...profile.flags, ...GENERAL_DEFAULTS };
  delete flags.chatTemplateKwargs;
  return applyProfileFlags(profile, flags);
}

function applyProfileFlags(profile, flags) {
  const next = {
    ...profile,
    flags,
    baseUrl: baseUrlForFlags(flags),
    harnesses: {
      ...(profile.harnesses ?? {}),
      pi: { ...(profile.harnesses?.pi ?? {}), enabled: true, model: `${profile.providerId ?? profile.backend}/${profile.modelAlias ?? profile.id}` },
    },
  };
  return next;
}


function renderMemoryEstimate(profile) {
  try {
    const est = estimateMemory(profile.modelPath, profile.mmprojPath, null, profile.flags);
    return renderSection("Memory estimate", renderRows([
      ["Estimated total", pc.bold(`~${formatBytes(est.totalBytes)}`)],
      ["Model", formatBytes(est.modelBytes)],
      ["KV cache", est.kvBytes ? `~${formatBytes(est.kvBytes)} (${profile.flags.ctxSize.toLocaleString()} ctx, ${profile.flags.cacheTypeK}/${profile.flags.cacheTypeV})` : "unknown"],
      ...(est.note ? [["Note", pc.yellow(est.note)]] : []),
    ]));
  } catch {
    return renderSection("Memory estimate", pc.dim("Estimate unavailable for this model."));
  }
}

function isGemma4UnifiedProjector(projectorType) {
  return /gemma4u[va]/i.test(String(projectorType ?? ""));
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

function samplingSummary(flags) {
  return `temp ${flags.temperature}, top-p ${flags.topP}, top-k ${flags.topK}`;
}

// ── MLX profile configuration ─────────────────────────────────────────────

/**
 * Interactive configuration for an mlx-vlm profile.
 */
export async function configureMlxProfile(prompt, profile) {
  let configured = profile;

  console.log("");
  console.log(renderSection("Model setup", renderRows([
    ["Model", pc.bold(profile.label)],
    ["Detected", mlxDetectionSummary(configured.capabilities)],
    ["Context", String(configured.flags.ctxSize) + " tokens"],
  ])));
  console.log(pc.dim("Larger context windows use more memory. You can edit the profile later if needed.\n"));

  if (configured.capabilities.vision) {
    console.log(renderSection("Vision detected", renderRows([
      ["Capability", "image / multimodal input"],
      ["Note", "mlx-vlm loads vision from the model directory automatically."],
    ])));
  }

  if (configured.capabilities.thinking) {
    console.log("");
    console.log(renderSection("Thinking mode", renderRows([
      ["Flag", "--enable-thinking"],
      ["Default", "on for Qwen 3 / Gemma 4 / DeepSeek-R class models"],
    ])));
    const useThinking = await prompt.yesNo("Enable thinking mode?", true);
    configured = await applyMlxThinkingToggle(configured, useThinking);
  }

  const ctxSize = await prompt.number("Context window tokens", configured.flags.ctxSize, 1024, 1048576);
  configured = applyMlxContextSize(configured, ctxSize);

  console.log("\n" + renderMlxMemoryEstimate(configured));

  console.log("");
  console.log(renderSection("Defaults", renderRows([
    ["Backend", configured.backend],
    ["Endpoint", configured.baseUrl],
    ["Context", String(configured.flags.ctxSize) + " tokens"],
    ["Thinking", configured.capabilities?.thinking ? "on" : "off"],
    ["Vision", configured.capabilities.vision ? "yes" : "no"],
  ])));

  if (!(await prompt.yesNo("Save profile with these settings?", true))) return null;
  return configured;
}

async function applyMlxThinkingToggle(profile, enabled) {
  if (!profile.capabilities.thinking) return profile;
  return {
    ...profile,
    capabilities: { ...profile.capabilities, thinkingEnabled: enabled },
  };
}

function applyMlxContextSize(profile, ctxSize) {
  const flags = { ...profile.flags, ctxSize };
  return {
    ...profile,
    flags,
    baseUrl: baseUrlForFlags(flags),
  };
}

function renderMlxMemoryEstimate(profile) {
  const modelBytes = profile.modelSizeBytes || 0;
  if (!modelBytes) {
    return renderSection("Memory estimate", pc.dim("Model size unknown — save the profile to estimate."));
  }
  const totalMb = estimateMemoryMb(modelBytes);
  const overheadBytes = Math.max(0, totalMb * 1024 * 1024 - modelBytes);
  return renderSection("Memory estimate", renderRows([
    ["Estimated total", pc.bold(`~${formatBytes(totalMb * 1024 * 1024)}`)],
    ["Model", formatBytes(modelBytes)],
    ["Overhead", `~${formatBytes(overheadBytes)} (KV cache, APC, runtime)`],
  ]));
}

function mlxDetectionSummary(caps) {
  const parts = [];
  if (caps.architecture) parts.push(caps.architecture);
  if (caps.thinking) parts.push("thinking");
  if (caps.vision) parts.push("vision");
  return parts.length > 0 ? parts.join(" · ") : "standard MLX";
}
