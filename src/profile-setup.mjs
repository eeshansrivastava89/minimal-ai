import { existsSync, statSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { prepareMemoryEstimate, computeMemoryTotal } from "./estimate.mjs";
import { availableRamBytes } from "./hardware.mjs";
import { findLlamaServer } from "./config.mjs";
import { backendFor } from "./backends.mjs";
import { formatBytes, formatCtxLabel, renderList, card, padEndVisible, fitColor, renderMemoryEstimate, theme, status, promptConfirm, promptSelect, promptNumber } from "./ui.mjs";
import { execFileAsync } from "./exec.mjs";
import { detectCapabilities } from "./autodetect.mjs";
import { matchDrafter, scanGgufModels } from "./scan.mjs";
import { capabilitySummary } from "./model-summary.mjs";
import { effectiveModelId } from "./profiles.mjs";
import { detectOmlxMtpCapability, findOmlxModelDir } from "./mlx-discovery.mjs";
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

function renderContextCacheHeatmap(prepared, baseFlags, maxCtx, systemRamBytes) {
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
  lines.push(theme.subtle(`System RAM: ${formatBytes(systemRamBytes)}  ·  Fixed (model+overhead): ${formatBytes(fixedBytes)}  ·  Parallel: ${parallel} slot(s)`));
  lines.push(theme.subtle(`Legend: ${status({ kind: "success", message: "fits" })} · ${status({ kind: "warning", message: "tight" })} · ${status({ kind: "error", message: "won't fit" })}`));
  lines.push("");
  lines.push(theme.bold(padEndVisible("Context", col0Width)) + cacheLabels.map((label, i) => theme.subtle(padEndVisible(label, colWidths[i]))).join(""));
  for (const row of rows) {
    const label = formatCtxLabel(row.ctx);
    const ctxCell = (row.ctx === currentCtx ? theme.brand : theme.subtle)(padEndVisible(label, col0Width));
    const memCells = row.cells.map((est, colIdx) => {
      if (!est.totalBytes) return theme.subtle(padEndVisible("—", colWidths[colIdx]));
      const color = fitColor(est.totalBytes, systemRamBytes);
      return padEndVisible(color(`~${formatBytes(est.totalBytes)}`), colWidths[colIdx]);
    });
    lines.push(ctxCell + memCells.join(""));
  }
  lines.push(theme.subtle(padEndVisible("Custom", col0Width) + colWidths.map((w) => padEndVisible("—", w)).join("")));

  return lines.join("\n");
}

export async function configureLocalProfile(profile) {
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
    console.log(card({ title: "MTP (Multi-Token Prediction)", body: renderList([
      ["What it does", "Speculative decoding — predicts multiple tokens at once, verifies them"],
      ["Speed", "1.5–3x faster generation"],
      ["Quality", "No loss — rejected predictions fall back to normal"],
      ["Memory", "Slightly more for draft model weights"],
      ...(configured.drafterPath ? [["Drafter", configured.drafterPath]] : []),
    ]) }));
    const useMtp = await promptConfirm({ message: "Enable MTP speculative decoding?", initialValue: true });
    configured = useMtp ? applyMtpDefaults(configured) : removeMtpDefaults(configured);
    if (useMtp) {
      console.log("");
      console.log(card({ title: "MTP draft tokens", body: renderList([
        ["What it is", "Maximum number of tokens the draft model predicts per step"],
        ["Range", "1 – 8"],
        ["Guidance", "2: recommended for most models · 4: more aggressive (may waste compute) · 1: minimal speedup"],
      ]) }));
      const specDraftNMax = await promptNumber({ message: "Draft tokens per step", defaultValue: configured.flags.specDraftNMax ?? 2, min: 1, max: 8 });
      configured = applyRuntimeFlagOverrides(configured, { specDraftNMax });
    }
  }

  if (caps.vision && profile.mmprojPath) {
    console.log("");
    const gemma4Unified = isGemma4UnifiedProjector(caps.mmprojProjectorType);
    const supported = !gemma4Unified || await runtimeSupportsGemma4Unified();
    let mmprojSize = "unknown";
    try { mmprojSize = formatBytes(statSync(profile.mmprojPath).size); } catch { /* file not found */ }
    console.log(card({ title: "Vision projector", body: renderList([
      ["What it does", "Enables image understanding — model can see and reason about images"],
      ["Projector type", caps.mmprojProjectorType ?? "unknown"],
      ["Flag", `--mmproj ${profile.mmprojPath}`],
      ["Memory", `${mmprojSize} for projector weights`],
      ...(gemma4Unified && !supported ? [["Note", theme.warning("Gemma 4 unified projectors need llama.cpp b9549+.")]] : []),
    ]) }));
    const useVision = await promptConfirm({ message: "Enable vision?", initialValue: supported });
    configured = useVision ? applyVisionDefaults(configured) : removeVisionDefaults(configured, gemma4Unified && !supported ? "gemma4-unified-unsupported" : "user-disabled");
  }

  if (caps.thinking) {
    console.log("");
    console.log(card({ title: "Thinking mode", body: renderList([
      ["What it does", "Model reasons step-by-step before answering"],
      ["Benefit", "Better results for math, code, logic — but slower (more output tokens)"],
      ["Sampling changes", "top-k → 64, presence penalty → 0, repeat penalty → 1.1 (adjustable below)"],
      ["Template", "--chat-template-kwargs { enable_thinking: true }"],
    ]) }));
    const useThinking = await promptConfirm({ message: "Use thinking/loop-safe defaults?", initialValue: true });
    configured = useThinking ? applyThinkingDefaults(configured) : removeThinkingDefaults(configured);
  }

  console.log("");
  console.log(card({ title: "GPU layers", body: renderList([
    ["What it does", "Number of model layers to offload to GPU (Metal on Apple Silicon, CUDA on NVIDIA)"],
    ["Range", "0 – 999 (0 = CPU only, 99 = all layers on GPU)"],
    ["Guidance", "99: recommended for Apple Silicon (unified memory) · 0: CPU-only fallback"],
  ]) }));
  const nGpuLayers = await promptNumber({ message: "GPU layers", defaultValue: configured.flags.nGpuLayers ?? 99, min: 0, max: 999 });
  configured = applyRuntimeFlagOverrides(configured, { nGpuLayers });

  const maxCtx = caps.metaCtx ?? caps.ctxSize;
  const systemRamBytes = availableRamBytes();
  const prepared = prepareMemoryEstimate(profile.modelPath, profile.mmprojPath, drafterPath);
  const hasKvParams = Boolean(prepared.kvParams.layers);

  if (hasKvParams) {
    console.log("");
    console.log(card({ title: "Context & KV cache", body: renderContextCacheHeatmap(prepared, configured.flags, maxCtx, systemRamBytes) }));

    const ctxPresets = CONTEXT_PRESETS.filter((ctx) => ctx <= maxCtx);
    const currentCtx = configured.flags.ctxSize;
    const ctxDefault = ctxPresets.includes(currentCtx) ? currentCtx : "custom";
    const ctxChoices = [
      ...ctxPresets.map((ctx) => ({ value: ctx, label: formatCtxLabel(ctx) })),
      { value: "custom", label: "Custom (enter tokens)" },
    ];
    console.log("");
    const ctxChoice = await promptSelect({ message: "Select context window", choices: ctxChoices, defaultValue: ctxDefault });
    let ctxSize;
    if (ctxChoice === "custom") {
      ctxSize = await promptNumber({ message: "Context window tokens", defaultValue: currentCtx, min: 1024, max: maxCtx });
    } else {
      ctxSize = ctxChoice;
    }
    configured = applyRuntimeFlagOverrides(configured, { ctxSize });

    const cacheChoices = CACHE_CHOICES.map((c) => {
      const flags = { ...configured.flags, ctxSize, cacheTypeK: c.value, cacheTypeV: c.value };
      try {
        const est = computeMemoryTotal(prepared, flags);
        const color = fitColor(est.totalBytes, systemRamBytes);
        return {
          value: c.value,
          label: `${c.label.padEnd(6)} ${color(`~${formatBytes(est.totalBytes)}`)}`,
          hint: c.hint,
        };
      } catch {
        return { value: c.value, label: c.label, hint: c.hint };
      }
    });
    const cacheType = await promptSelect({ message: "KV cache precision (K = V)", choices: cacheChoices, defaultValue: configured.flags.cacheTypeK });

    const sameV = await promptConfirm({ message: "Use same precision for V cache?", initialValue: true });
    let cacheTypeK = cacheType, cacheTypeV = cacheType;
    if (!sameV) {
      cacheTypeV = await promptSelect({ message: "V cache precision", choices: CACHE_CHOICES, defaultValue: cacheType });
    }
    configured = applyRuntimeFlagOverrides(configured, { cacheTypeK, cacheTypeV });
  } else {
    console.log("");
    console.log(card({ title: "Context window", body: renderList([
      ["What it does", "Maximum tokens the model can process at once (prompt + response + history)"],
      ["Range", `1,024 – ${maxCtx.toLocaleString()} tokens`],
      ["Memory", "KV cache grows linearly — larger context = more RAM"],
      ["Guidance", "8k–32k: chat · 32k–80k: coding/long convos · 128k+: long documents"],
      ["Model max", `${maxCtx.toLocaleString()} tokens`],
      ["Default", `${configured.flags.ctxSize.toLocaleString()} tokens`],
    ]) }));
    const ctxSize = await promptNumber({ message: "Context window tokens", defaultValue: configured.flags.ctxSize, min: 1024, max: maxCtx });
    configured = applyRuntimeFlagOverrides(configured, { ctxSize });

    console.log("");
    console.log(card({ title: "K cache precision", body: renderList([
      ["What it is", "KV cache stores attention 'keys' — previous token states used for prediction"],
      ["Tradeoff", "Lower precision = less memory, potential quality loss"],
    ]) }));
    const cacheTypeK = await promptSelect({ message: "K cache precision", choices: CACHE_CHOICES, defaultValue: configured.flags.cacheTypeK });
    configured = applyRuntimeFlagOverrides(configured, { cacheTypeK });

    console.log("");
    console.log(card({ title: "V cache precision", body: renderList([
      ["What it is", "KV cache stores attention 'values' — token representations from previous layers"],
      ["Tradeoff", "Same as K cache. Some models are more sensitive to V precision than K"],
    ]) }));
    const cacheTypeV = await promptSelect({ message: "V cache precision", choices: CACHE_CHOICES, defaultValue: configured.flags.cacheTypeV });
    configured = applyRuntimeFlagOverrides(configured, { cacheTypeV });
  }

  console.log("");
  console.log(card({ title: "Memory estimate", body: renderMemoryEstimate(computeMemoryTotal(prepared, configured.flags), configured.flags) }));

  console.log("");
  console.log(card({ title: "Temperature", body: renderList([
    ["What it does", "Controls randomness in token selection"],
    ["Range", "0.0 – 2.0"],
    ["0.0", "Deterministic — always picks most likely token"],
    ["0.6", "Balanced — default for most models"],
    ["1.0+", "Creative — more random, may hallucinate"],
    ["Guidance", "0–0.3: coding/factual · 0.4–0.8: chat · 0.9+: creative writing"],
  ]) }));
  const temperature = await promptNumber({ message: "Temperature", defaultValue: configured.flags.temperature, min: 0, max: 2, float: true });
  configured = applyRuntimeFlagOverrides(configured, { temperature });

  console.log("");
  console.log(card({ title: "Top-p (nucleus sampling)", body: renderList([
    ["What it does", "Only considers tokens in the top p fraction of probability mass"],
    ["Range", "0.0 – 1.0 (1.0 = consider all tokens)"],
    ["Guidance", "0.9–0.95: good default · Lower = more focused · Higher = more diverse"],
  ]) }));
  const topP = await promptNumber({ message: "Top-p", defaultValue: configured.flags.topP, min: 0, max: 1, float: true });
  configured = applyRuntimeFlagOverrides(configured, { topP });

  console.log("");
  console.log(card({ title: "Top-k", body: renderList([
    ["What it does", "Limits token selection to top K most likely tokens at each step"],
    ["Range", "0 – 1000 (0 = disabled, uses top-p instead)"],
    ["Guidance", "20: general chat · 40–64: thinking/reasoning · 0: rely on top-p"],
  ]) }));
  const topK = await promptNumber({ message: "Top-k", defaultValue: configured.flags.topK, min: 0, max: 1000 });
  configured = applyRuntimeFlagOverrides(configured, { topK });

  console.log("");
  console.log(card({ title: "Min-p", body: renderList([
    ["What it does", "Excludes tokens with probability below this threshold"],
    ["Range", "0.0 – 1.0 (0 = disabled)"],
    ["Guidance", "0: off (default) · 0.05–0.1: reduces hallucination while keeping creativity"],
  ]) }));
  const minP = await promptNumber({ message: "Min-p", defaultValue: configured.flags.minP, min: 0, max: 1, float: true });
  configured = applyRuntimeFlagOverrides(configured, { minP });

  console.log("");
  console.log(card({ title: "Presence penalty", body: renderList([
    ["What it does", "Discourages repeated tokens — each used token gets a fixed logit penalty"],
    ["Range", "0.0 – 2.0 (0 = off)"],
    ["Guidance", "0: thinking/reasoning · 1.0–1.5: general chat · Too high = incoherent"],
  ]) }));
  const presencePenalty = await promptNumber({ message: "Presence penalty", defaultValue: configured.flags.presencePenalty, min: 0, max: 2, float: true });
  configured = applyRuntimeFlagOverrides(configured, { presencePenalty });

  console.log("");
  console.log(card({ title: "Repeat penalty", body: renderList([
    ["What it does", "Multiplies probability of repeated tokens (multiplicative, vs presence's additive)"],
    ["Range", "0.0 – 2.0 (1.0 = no effect)"],
    ["Guidance", "1.0–1.1: most use cases · Higher = aggressive anti-repeat · Can break code patterns"],
  ]) }));
  const repeatPenalty = await promptNumber({ message: "Repeat penalty", defaultValue: configured.flags.repeatPenalty, min: 0, max: 2, float: true });
  configured = applyRuntimeFlagOverrides(configured, { repeatPenalty });

  console.log("");
  console.log(card({ title: "Batch size", body: renderList([
    ["What it does", "Tokens processed in parallel during prompt processing (before generation)"],
    ["Range", "1 – 4096"],
    ["Guidance", "512: good default · 2048+: faster for long prompts · Lower if memory tight"],
  ]) }));
  const batchSize = await promptNumber({ message: "Batch size", defaultValue: configured.flags.batchSize, min: 1, max: 4096 });
  configured = applyRuntimeFlagOverrides(configured, { batchSize });

  console.log("");
  console.log(card({ title: "Parallel slots", body: renderList([
    ["What it does", "Number of concurrent request slots (each handles an independent conversation)"],
    ["Range", "1 – 10"],
    ["Memory", "KV cache is multiplied by this number"],
    ["Guidance", "1: single-user local · 2+: multiple clients connecting simultaneously"],
  ]) }));
  const parallel = await promptNumber({ message: "Parallel slots", defaultValue: configured.flags.parallel, min: 1, max: 10 });
  configured = applyRuntimeFlagOverrides(configured, { parallel });

  console.log("");
  console.log(card({ title: "Flash attention", body: renderList([
    ["What it does", "Memory-efficient attention algorithm — faster and less RAM than standard"],
    ["Guidance", "Always on for modern hardware · Turn off only for old GPU driver compat issues"],
  ]) }));
  const flashAttn = await promptConfirm({ message: "Enable flash attention?", initialValue: true });
  configured = applyRuntimeFlagOverrides(configured, { flashAttention: flashAttn ? "on" : "off" });

  console.log("");
  console.log(card({ title: "Jinja chat templates", body: renderList([
    ["What it does", "Enables Jinja2 template rendering for proper chat formatting"],
    ["Guidance", "Always on for modern models · Turn off only for very old models without chat templates"],
  ]) }));
  const jinja = await promptConfirm({ message: "Enable Jinja templates?", initialValue: true });
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

  console.log("");
  console.log(card({ title: "Memory estimate", body: renderMemoryEstimate(computeMemoryTotal(prepared, configured.flags), configured.flags) }));

  if (!(await promptConfirm({ message: "Save profile with these settings?", initialValue: true }))) return null;
  return configured;
}

export async function configureManagedProfile(profile) {
  const backend = backendFor(profile.backend);
  if (backend.id === "ollama") return await configureOllamaProfile(profile);
  return await configureOmlxProfile(profile);
}

async function configureOmlxProfile(profile) {
  let configured = profile;
  const modelId = effectiveModelId(profile);
  const modelDir = await findOmlxModelDir(modelId);
  if (modelDir) {
    const mtpResult = await detectOmlxMtpCapability(modelDir);
    if (mtpResult.compatible) {
      console.log("");
      console.log(card({ title: "MTP detected", body: renderList([
        ["Feature", "Multi-Token Prediction (speculative decoding)"],
        ["Mechanism", "oMLX native MTP (enabled via admin API at load time)"],
      ]) }));
      const useMtp = await promptConfirm({ message: "Use MTP speculative decoding?", initialValue: true });
      configured = { ...configured, capabilities: { ...(configured.capabilities ?? {}), mtp: useMtp } };
    } else if (mtpResult.reason !== "model has no MTP heads in config") {
      console.log("");
      console.log(card({ title: "MTP not available", body: renderList([
        ["Feature", "Multi-Token Prediction (speculative decoding)"],
        ["Reason", theme.warning(mtpResult.reason)],
      ]) }));
    }
  }

  console.log("");
  console.log(card({ title: "Model setup", body: renderList([
    ["Model", theme.bold(profile.label)],
    ["Backend", "oMLX"],
    ...(configured.capabilities?.mtp ? [["MTP", "enabled"]] : []),
  ]) }));

  if (!(await promptConfirm({ message: "Save profile with these settings?", initialValue: true }))) return null;
  return configured;
}

async function configureOllamaProfile(profile) {
  let configured = profile;
  const modelId = effectiveModelId(profile);
  let capabilities = [];
  try {
    const info = await ollamaModelInfo(modelId);
    const caps = info.capabilities ?? [];
    if (caps.includes("vision")) capabilities.push("Vision");
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

  if (!(await promptConfirm({ message: "Save profile with these settings?", initialValue: true }))) return null;
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
