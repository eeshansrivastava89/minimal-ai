import { existsSync, statSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { prepareMemoryEstimate, computeMemoryTotal } from "./estimate.mjs";
import { availableRamBytes, installedRamGB } from "./hardware.mjs";
import { findLlamaServer } from "./config.mjs";
import { backendFor } from "./backends.mjs";
import { formatBytes, formatCtxLabel, renderList, card, padEndVisible, fitColor, renderMemoryEstimate, theme, status, promptConfirm, promptSelect, promptNumber } from "./ui.mjs";
import { execFileAsync } from "./exec.mjs";
import { detectCapabilities } from "./autodetect.mjs";
import { matchDrafter, scanGgufModels } from "./scan.mjs";
import { capabilitySummary } from "./model-summary.mjs";
import { effectiveModelId } from "./profiles.mjs";
import { detectOmlxMtpCapability, detectOmlxVision, findOmlxModelDir } from "./mlx-discovery.mjs";
import { ollamaModelInfo } from "./ollama-runtime.mjs";
import { applyRuntimeFlagOverrides, removeMtpDefaults, applyMtpDefaults, applyVisionDefaults, removeVisionDefaults, applyThinkingDefaults, removeThinkingDefaults } from "./profile-flags.mjs";

const CACHE_CHOICES = [
  { value: "bf16", label: "bf16", hint: "16-bit · best quality · 2 bytes/elem" },
  { value: "f16", label: "f16", hint: "16-bit · stable fallback · 2 bytes/elem" },
  { value: "q8_0", label: "q8_0", hint: "8-bit · half memory · usually safe · 1 byte/elem" },
  { value: "q4_0", label: "q4_0", hint: "4-bit · quarter memory · quality tradeoff · 0.5 bytes/elem" },
];

const CONTEXT_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288];
const HEATMAP_CACHE_TYPES = ["bf16", "q8_0", "q4_0"];

function hint(text) {
  console.log(theme.subtle(`  ${text}`));
}

class CancelSetup extends Error {}

/** Unwrap a prompt result; null means the user pressed Escape — cancel the whole setup. */
async function ask(promise) {
  const value = await promise;
  if (value === null) throw new CancelSetup();
  return value;
}

function renderContextCacheHeatmap(prepared, baseFlags, maxCtx, availableRam) {
  const presets = [...CONTEXT_PRESETS.filter((ctx) => ctx <= maxCtx)];
  const currentCtx = baseFlags.ctxSize;
  if (!presets.includes(currentCtx) && currentCtx >= 1024 && currentCtx <= maxCtx) {
    presets.push(currentCtx);
    presets.sort((a, b) => a - b);
  }
  const parallel = baseFlags.parallel ?? 1;

  const rows = presets.map((ctx) => {
    const cells = HEATMAP_CACHE_TYPES.map((cacheType) => {
      try {
        return computeMemoryTotal(prepared, { ...baseFlags, ctxSize: ctx, cacheTypeK: cacheType, cacheTypeV: cacheType });
      } catch {
        return { totalBytes: 0 };
      }
    });
    return { ctx, cells };
  });

  const cacheLabels = HEATMAP_CACHE_TYPES.map((t) => {
    const choice = CACHE_CHOICES.find((c) => c.value === t);
    const bytesInfo = choice?.hint?.match(/([\d.]+ bytes\/elem)/)?.[1] ?? "";
    return `${t} ${theme.subtle(bytesInfo ? `(${bytesInfo})` : "")}`;
  });

  const ctxLabels = presets.map(formatCtxLabel);
  const col0Width = Math.max(stripVTControlCharacters("Context").length, ...ctxLabels.map((l) => l.length), "Custom".length) + 3;
  const colWidths = HEATMAP_CACHE_TYPES.map((_, colIdx) => {
    const cellLens = rows.map((row) => {
      const est = row.cells[colIdx];
      return est.totalBytes ? `~${formatBytes(est.totalBytes)}`.length : 1;
    });
    return Math.max(...cellLens, stripVTControlCharacters(cacheLabels[colIdx]).length) + 3;
  });

  const lines = [];
  const fixedBytes = prepared.modelBytes + prepared.mmprojBytes + prepared.draftBytes + prepared.overheadBytes;
  lines.push(theme.subtle(`RAM: ${installedRamGB()} GB installed · ${formatBytes(availableRam)} available now  ·  Fixed (model+overhead): ${formatBytes(fixedBytes)}  ·  Parallel: ${parallel} slot(s)`));
  lines.push(theme.subtle(`Legend: ${status({ kind: "success", message: "fits" })} · ${status({ kind: "warning", message: "tight" })} · ${status({ kind: "error", message: "won't fit" })}`));
  lines.push("");
  lines.push(theme.bold(padEndVisible("Context", col0Width)) + cacheLabels.map((label, i) => theme.subtle(padEndVisible(label, colWidths[i]))).join(""));
  for (const row of rows) {
    const label = formatCtxLabel(row.ctx);
    const ctxCell = (row.ctx === currentCtx ? theme.brand : theme.subtle)(padEndVisible(label, col0Width));
    const memCells = row.cells.map((est, colIdx) => {
      if (!est.totalBytes) return theme.subtle(padEndVisible("—", colWidths[colIdx]));
      const color = fitColor(est.totalBytes, availableRam);
      return padEndVisible(color(`~${formatBytes(est.totalBytes)}`), colWidths[colIdx]);
    });
    lines.push(ctxCell + memCells.join(""));
  }
  lines.push(theme.subtle(padEndVisible("Custom", col0Width) + colWidths.map((w) => padEndVisible("—", w)).join("")));

  return lines.join("\n");
}

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
  const freshCaps = detectCapabilities(profile.modelPath, profile.mmprojPath);
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
  const caps = { ...freshCaps, mtp: hasMtp };
  configured = { ...configured, drafterPath: drafterPath ?? null, capabilities: { ...configured.capabilities, mtp: hasMtp } };
  if (configured.disabledMmprojPath && configured.mmprojPath === null && existsSync(configured.disabledMmprojPath)) {
    configured = { ...configured, mmprojPath: configured.disabledMmprojPath, disabledMmprojPath: undefined, capabilities: { ...configured.capabilities, vision: true, visionDisabledReason: undefined } };
  }

  console.log("");
  console.log(card({ title: "Model overview", body: renderList([
    ["Model", theme.bold(profile.label)],
    ["Detected", capabilitySummary(caps)],
    ["Backend", "llama.cpp (local server)"],
    ["Model file", profile.modelPath],
  ]) }));

  if (caps.mtp) {
    console.log("");
    hint(`Predicts multiple tokens per step — 1.5–3x faster, no quality loss${configured.drafterPath ? ` · drafter: ${configured.drafterPath}` : ""}`);
    const useMtp = await ask(promptConfirm({ message: "Enable MTP speculative decoding?", initialValue: true }));
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

  const maxCtx = caps.metaCtx ?? caps.ctxSize;
  const availableRam = availableRamBytes();
  const prepared = prepareMemoryEstimate(profile.modelPath, profile.mmprojPath, drafterPath);
  const hasKvParams = Boolean(prepared.kvParams.layers);

  if (hasKvParams) {
    console.log("");
    console.log(card({ title: "Context & KV cache", body: renderContextCacheHeatmap(prepared, configured.flags, maxCtx, availableRam) }));

    const ctxPresets = CONTEXT_PRESETS.filter((ctx) => ctx <= maxCtx);
    const currentCtx = configured.flags.ctxSize;
    const ctxDefault = ctxPresets.includes(currentCtx) ? currentCtx : "custom";
    const ctxChoices = [
      ...ctxPresets.map((ctx) => ({ value: ctx, label: formatCtxLabel(ctx) })),
      { value: "custom", label: "Custom (enter tokens)" },
    ];
    console.log("");
    const ctxChoice = await ask(promptSelect({ message: "Select context window", choices: ctxChoices, defaultValue: ctxDefault }));
    let ctxSize;
    if (ctxChoice === "custom") {
      ctxSize = await ask(promptNumber({ message: "Context window tokens", defaultValue: currentCtx, min: 1024, max: maxCtx }));
    } else {
      ctxSize = ctxChoice;
    }
    configured = applyRuntimeFlagOverrides(configured, { ctxSize });

    const cacheChoices = CACHE_CHOICES.map((c) => {
      const flags = { ...configured.flags, ctxSize, cacheTypeK: c.value, cacheTypeV: c.value };
      try {
        const est = computeMemoryTotal(prepared, flags);
        const color = fitColor(est.totalBytes, availableRam);
        return {
          value: c.value,
          label: `${c.label.padEnd(6)} ${color(`~${formatBytes(est.totalBytes)}`)}`,
          hint: c.hint,
        };
      } catch {
        return { value: c.value, label: c.label, hint: c.hint };
      }
    });
    const cacheType = await ask(promptSelect({ message: "KV cache precision (K = V)", choices: cacheChoices, defaultValue: configured.flags.cacheTypeK }));

    const sameV = await ask(promptConfirm({ message: "Use same precision for V cache?", initialValue: true }));
    let cacheTypeK = cacheType, cacheTypeV = cacheType;
    if (!sameV) {
      cacheTypeV = await ask(promptSelect({ message: "V cache precision", choices: CACHE_CHOICES, defaultValue: cacheType }));
    }
    configured = applyRuntimeFlagOverrides(configured, { cacheTypeK, cacheTypeV });
  } else {
    console.log("");
    hint(`Max tokens per request · KV cache grows with context · model max ${maxCtx.toLocaleString()}`);
    const ctxSize = await ask(promptNumber({ message: "Context window tokens", defaultValue: configured.flags.ctxSize, min: 1024, max: maxCtx }));
    configured = applyRuntimeFlagOverrides(configured, { ctxSize });

    console.log("");
    hint("KV cache precision · lower = less memory · bf16 best quality · q8_0 usually safe");
    const cacheTypeK = await ask(promptSelect({ message: "K cache precision", choices: CACHE_CHOICES, defaultValue: configured.flags.cacheTypeK }));
    configured = applyRuntimeFlagOverrides(configured, { cacheTypeK });

    console.log("");
    hint("Same tradeoff as K cache · some models are more sensitive to V precision");
    const cacheTypeV = await ask(promptSelect({ message: "V cache precision", choices: CACHE_CHOICES, defaultValue: configured.flags.cacheTypeV }));
    configured = applyRuntimeFlagOverrides(configured, { cacheTypeV });
  }

  console.log("");
  console.log(card({ title: "Memory estimate", body: renderMemoryEstimate(computeMemoryTotal(prepared, configured.flags), configured.flags) }));

  console.log("");
  hint("Randomness · 0 = deterministic · 0.6 balanced · 0.9+ creative");
  const temperature = await ask(promptNumber({ message: "Temperature", defaultValue: configured.flags.temperature, min: 0, max: 2, float: true }));
  configured = applyRuntimeFlagOverrides(configured, { temperature });

  console.log("");
  hint("Token pool by probability mass · 0.9–0.95 good default");
  const topP = await ask(promptNumber({ message: "Top-p", defaultValue: configured.flags.topP, min: 0, max: 1, float: true }));
  configured = applyRuntimeFlagOverrides(configured, { topP });

  console.log("");
  hint("Limits to top K tokens · 0 = off (uses top-p) · 20 chat · 40–64 thinking");
  const topK = await ask(promptNumber({ message: "Top-k", defaultValue: configured.flags.topK, min: 0, max: 1000 }));
  configured = applyRuntimeFlagOverrides(configured, { topK });

  console.log("");
  hint("Probability floor · 0 = off · 0.05–0.1 reduces hallucination");
  const minP = await ask(promptNumber({ message: "Min-p", defaultValue: configured.flags.minP, min: 0, max: 1, float: true }));
  configured = applyRuntimeFlagOverrides(configured, { minP });

  console.log("");
  hint("Penalizes any used token · 0 = off · 1.0–1.5 general chat");
  const presencePenalty = await ask(promptNumber({ message: "Presence penalty", defaultValue: configured.flags.presencePenalty, min: 0, max: 2, float: true }));
  configured = applyRuntimeFlagOverrides(configured, { presencePenalty });

  console.log("");
  hint("Multiplies down repeated tokens · 1.0 = no effect · 1.0–1.1 typical");
  const repeatPenalty = await ask(promptNumber({ message: "Repeat penalty", defaultValue: configured.flags.repeatPenalty, min: 0, max: 2, float: true }));
  configured = applyRuntimeFlagOverrides(configured, { repeatPenalty });

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

  console.log("");
  console.log(card({ title: "Configuration summary", body: renderList([
    ["Model", theme.bold(configured.label)],
    ["Backend", configured.backend],
    ["Endpoint", configured.baseUrl],
    ["Context", `${configured.flags.ctxSize.toLocaleString()} tokens`],
    ["GPU layers", String(configured.flags.nGpuLayers)],
    ["KV cache", `${configured.flags.cacheTypeK}/${configured.flags.cacheTypeV}`],
    ["Temperature", String(configured.flags.temperature)],
    ["Top-p", String(configured.flags.topP)],
    ["Top-k", String(configured.flags.topK)],
    ["Min-p", String(configured.flags.minP)],
    ["Presence penalty", String(configured.flags.presencePenalty)],
    ["Repeat penalty", String(configured.flags.repeatPenalty)],
    ["Batch size", String(configured.flags.batchSize)],
    ["Parallel", String(configured.flags.parallel)],
    ["Flash attention", configured.flags.flashAttention],
    ["Jinja", configured.flags.jinja ? "on" : "off"],
    ...(configured.capabilities?.mtp ? [["MTP", `enabled (${configured.flags.specDraftNMax ?? 2} draft tokens)`]] : []),
    ...(configured.capabilities?.vision ? [["Vision", "enabled"]] : []),
    ...(configured.capabilities?.thinking ? [["Thinking", "enabled"]] : []),
  ]) }));

  if (!(await ask(promptConfirm({ message: "Save profile with these settings?", initialValue: true })))) return null;
  return configured;
}

export async function configureManagedProfile(profile) {
  try {
    const backend = backendFor(profile.backend);
    if (backend.id === "ollama") return await configureOllamaProfile(profile);
    return await configureOmlxProfile(profile);
  } catch (err) {
    if (err instanceof CancelSetup) {
      console.log(theme.subtle("Cancelled."));
      return null;
    }
    throw err;
  }
}

async function configureOmlxProfile(profile) {
  let configured = profile;
  const modelId = effectiveModelId(profile);
  const modelDir = await findOmlxModelDir(modelId);
  if (modelDir) {
    const mtpResult = await detectOmlxMtpCapability(modelDir);
    if (mtpResult.compatible) {
      console.log("");
      hint("oMLX native MTP — speculative decoding enabled at load time");
      const useMtp = await ask(promptConfirm({ message: "Use MTP speculative decoding?", initialValue: true }));
      configured = { ...configured, capabilities: { ...(configured.capabilities ?? {}), mtp: useMtp } };
    } else if (mtpResult.reason !== "model has no MTP heads in config") {
      console.log("");
      hint(`MTP not available — ${mtpResult.reason}`);
    }

    const hasVision = await detectOmlxVision(modelDir);
    configured = { ...configured, capabilities: { ...(configured.capabilities ?? {}), vision: hasVision } };
  }

  console.log("");
  console.log(card({ title: "Model setup", body: renderList([
    ["Model", theme.bold(profile.label)],
    ["Backend", "oMLX"],
    ...(configured.capabilities?.mtp ? [["MTP", "enabled"]] : []),
    ...(configured.capabilities?.vision ? [["Vision", "yes"]] : []),
  ]) }));

  if (!(await ask(promptConfirm({ message: "Save profile with these settings?", initialValue: true })))) return null;
  return configured;
}

async function configureOllamaProfile(profile) {
  let configured = profile;
  const modelId = effectiveModelId(profile);
  let capabilities = [];
  try {
    const info = await ollamaModelInfo(modelId);
    const caps = info.capabilities ?? [];
    if (caps.includes("vision")) {
      capabilities.push("Vision");
      configured = { ...configured, capabilities: { ...(configured.capabilities ?? {}), vision: true } };
    }
    if (caps.includes("tools")) capabilities.push("Tool calling");
    if (info.model_info) {
      const keys = Object.keys(info.model_info);
      if (keys.some((k) => /mtp/i.test(k))) capabilities.push("MTP");
    }
  } catch { /* model info unavailable */ }

  console.log("");
  console.log(card({ title: "Model setup", body: renderList([
    ["Model", theme.bold(profile.label)],
    ["Backend", "Ollama"],
    ["Model ID", modelId],
    ...(capabilities.length > 0 ? [["Capabilities", capabilities.join(" · ")]] : []),
  ]) }));

  if (!(await ask(promptConfirm({ message: "Save profile with these settings?", initialValue: true })))) return null;
  return configured;
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
