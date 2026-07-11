import { existsSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { prepareMemoryEstimate, computeMemoryTotal } from "./estimate.mjs";
import { detectHardware } from "./hardware.mjs";
import { findLlamaServer } from "./config.mjs";
import { backendFor } from "./backends.mjs";
import { pc, formatBytes, renderRows, renderSection, padCol } from "./ui.mjs";
import { execFileAsync } from "./exec.mjs";
import { detectCapabilities } from "./autodetect.mjs";
import { matchDrafter, scanGgufModels } from "./scan.mjs";
import { capabilitySummary } from "./model-summary.mjs";
import { detectOmlxMtpCapability, findOmlxModelDir } from "./mlx-discovery.mjs";
import { ollamaModelInfo } from "./ollama-runtime.mjs";
import { applyRuntimeFlagOverrides, removeMtpDefaults, applyMtpDefaults, applyVisionDefaults, removeVisionDefaults, applyThinkingDefaults, removeThinkingDefaults } from "./profile-flags.mjs";

const CACHE_CHOICES = [
  { value: "bf16", label: "bf16", hint: "16-bit · best quality · 2 bytes/elem" },
  { value: "f16", label: "f16", hint: "16-bit · stable fallback · 2 bytes/elem" },
  { value: "q8_0", label: "q8_0", hint: "8-bit · half memory · usually safe · 1 byte/elem" },
  { value: "q4_0", label: "q4_0", hint: "4-bit · quarter memory · quality tradeoff · 0.5 bytes/elem" },
];

// ── Context × KV cache heatmap ──────────────────────────────────────────────

const CONTEXT_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288];
const HEATMAP_CACHE_TYPES = ["bf16", "q8_0", "q4_0"];
const FIT_GREEN = 0.70;  // ≤ 70% of system RAM = comfortable
const FIT_YELLOW = 0.90; // ≤ 90% = tight, may work

function fitColor(totalBytes, systemRamBytes) {
  const ratio = totalBytes / systemRamBytes;
  if (ratio <= FIT_GREEN) return pc.green;
  if (ratio <= FIT_YELLOW) return pc.yellow;
  return pc.red;
}

function formatCtxLabel(ctx) {
  if (ctx >= 1048576) return `${(ctx / 1048576).toFixed(0)}M`;
  if (ctx >= 1024) return `${(ctx / 1024).toFixed(0)}k`;
  return String(ctx);
}

function renderContextCacheHeatmap(prepared, baseFlags, maxCtx, systemRamBytes) {
  const presets = [...CONTEXT_PRESETS.filter((ctx) => ctx <= maxCtx)];
  // Include current ctx if it's not a standard preset
  const currentCtx = baseFlags.ctxSize;
  if (!presets.includes(currentCtx) && currentCtx >= 1024 && currentCtx <= maxCtx) {
    presets.push(currentCtx);
    presets.sort((a, b) => a - b);
  }
  const parallel = baseFlags.parallel ?? 1;

  // Compute all cells
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

  // Column labels with bytes/elem hint
  const cacheLabels = HEATMAP_CACHE_TYPES.map((t) => {
    const choice = CACHE_CHOICES.find((c) => c.value === t);
    const bytesInfo = choice?.hint?.match(/([\d.]+ bytes\/elem)/)?.[1] ?? "";
    return `${t} ${pc.dim(bytesInfo ? `(${bytesInfo})` : "")}`;
  });

  // Column widths (visible length)
  const ctxLabels = presets.map(formatCtxLabel);
  const col0Width = Math.max(stripVTControlCharacters("Context").length, ...ctxLabels.map((l) => l.length), "Custom".length) + 3;
  const colWidths = HEATMAP_CACHE_TYPES.map((_, colIdx) => {
    const cellLens = rows.map((row) => {
      const est = row.cells[colIdx];
      return est.totalBytes ? `~${formatBytes(est.totalBytes)}`.length : 1;
    });
    return Math.max(...cellLens, stripVTControlCharacters(cacheLabels[colIdx]).length) + 3;
  });

  // Build lines
  const lines = [];
  const fixedBytes = prepared.modelBytes + prepared.mmprojBytes + prepared.draftBytes + prepared.overheadBytes;
  lines.push(pc.dim(`System RAM: ${formatBytes(systemRamBytes)}  ·  Fixed (model+overhead): ${formatBytes(fixedBytes)}  ·  Parallel: ${parallel} slot(s)`));
  lines.push(pc.dim(`Legend: ${pc.green("✓ fits")} · ${pc.yellow("~ tight")} · ${pc.red("✗ won't fit")}`));
  lines.push("");
  // Header row
  lines.push(pc.bold(padCol("Context", col0Width)) + cacheLabels.map((label, i) => pc.dim(padCol(label, colWidths[i]))).join(""));
  // Data rows
  for (const row of rows) {
    const label = formatCtxLabel(row.ctx);
    const ctxCell = (row.ctx === currentCtx ? pc.cyan : pc.dim)(padCol(label, col0Width));
    const memCells = row.cells.map((est, colIdx) => {
      if (!est.totalBytes) return pc.dim(padCol("—", colWidths[colIdx]));
      const color = fitColor(est.totalBytes, systemRamBytes);
      return padCol(color(`~${formatBytes(est.totalBytes)}`), colWidths[colIdx]);
    });
    lines.push(ctxCell + memCells.join(""));
  }
  // Custom row
  lines.push(pc.dim(padCol("Custom", col0Width) + colWidths.map((w) => padCol("—", w)).join("")));

  return renderSection("Context & KV cache", lines.join("\n"));
}

export async function configureLocalProfile(prompt, profile) {
  let configured = profile;
  // Re-detect capabilities from the model file and check for drafters
  // so that re-setup can pick up MTP availability, vision changes, etc.
  const freshCaps = detectCapabilities(profile.modelPath, profile.mmprojPath);
  let drafterPath = profile.drafterPath ?? null;
  if (drafterPath && !existsSync(drafterPath)) {
    drafterPath = null;
  }
  if (!drafterPath) {
    const { drafters } = await scanGgufModels();
    const drafter = matchDrafter(profile.modelPath, drafters);
    if (drafter) drafterPath = drafter.path;
  }
  const hasMtp = freshCaps.mtp || Boolean(drafterPath);
  const caps = { ...freshCaps, mtp: hasMtp };
  configured = { ...configured, drafterPath: drafterPath ?? null, capabilities: { ...configured.capabilities, mtp: hasMtp } };
  if (configured.disabledMmprojPath && configured.mmprojPath === null && freshCaps.vision) {
    configured = { ...configured, mmprojPath: configured.disabledMmprojPath, disabledMmprojPath: undefined, capabilities: { ...configured.capabilities, vision: true, visionDisabledReason: undefined } };
  }

  // ── Model overview ──────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Model overview", renderRows([
    ["Model", pc.bold(profile.label)],
    ["Detected", capabilitySummary(caps)],
    ["Backend", "llama.cpp (local server)"],
    ["Model file", profile.modelPath],
  ])));

  // ── MTP ────────────────────────────────────────────────────────────────
  if (caps.mtp) {
    console.log("");
    console.log(renderSection("MTP (Multi-Token Prediction)", renderRows([
      ["What it does", "Speculative decoding — predicts multiple tokens at once, verifies them"],
      ["Speed", "1.5–3x faster generation"],
      ["Quality", "No loss — rejected predictions fall back to normal"],
      ["Memory", "Slightly more for draft model weights"],
      ["Flags", "--spec-type draft-mtp --spec-draft-n-max 4"],
      ...(configured.drafterPath ? [["Drafter", configured.drafterPath]] : []),
    ])));
    const useMtp = await prompt.yesNo("Enable MTP speculative decoding?", true);
    configured = useMtp ? applyMtpDefaults(configured) : removeMtpDefaults(configured);
  }

  // ── Vision ─────────────────────────────────────────────────────────────
  if (caps.vision && profile.mmprojPath) {
    console.log("");
    const gemma4Unified = isGemma4UnifiedProjector(caps.mmprojProjectorType);
    const supported = !gemma4Unified || await runtimeSupportsGemma4Unified();
    console.log(renderSection("Vision projector", renderRows([
      ["What it does", "Enables image understanding — model can see and reason about images"],
      ["Projector type", caps.mmprojProjectorType ?? "unknown"],
      ["Flag", `--mmproj ${profile.mmprojPath}`],
      ["Memory", "~200 MB for projector weights (varies by model)"],
      ...(gemma4Unified && !supported ? [["Note", pc.yellow("Gemma 4 unified projectors need llama.cpp b9549+.")]] : []),
    ])));
    const useVision = await prompt.yesNo("Enable vision?", supported);
    configured = useVision ? applyVisionDefaults(configured) : removeVisionDefaults(configured, gemma4Unified && !supported ? "gemma4-unified-unsupported" : "user-disabled");
  }

  // ── Thinking ───────────────────────────────────────────────────────────
  if (caps.thinking) {
    console.log("");
    console.log(renderSection("Thinking mode", renderRows([
      ["What it does", "Model reasons step-by-step before answering"],
      ["Benefit", "Better results for math, code, logic — but slower (more output tokens)"],
      ["Sampling changes", "top-k → 64, presence penalty → 0, repeat penalty → 1.1 (adjustable below)"],
      ["Template", "--chat-template-kwargs { enable_thinking: true }"],
    ])));
    const useThinking = await prompt.yesNo("Use thinking/loop-safe defaults?", true);
    configured = useThinking ? applyThinkingDefaults(configured) : removeThinkingDefaults(configured);
  }

  // ── Context & KV cache (heatmap) ────────────────────────────────────────
  const maxCtx = caps.metaCtx ?? 1048576;
  const systemRamBytes = detectHardware().totalRamBytes;
  const prepared = prepareMemoryEstimate(profile.modelPath, profile.mmprojPath, profile.drafterPath);
  const hasKvParams = Boolean(prepared.kvParams.layers);

  if (hasKvParams) {
    // Show the heatmap table: context presets × cache types, color-coded vs system RAM
    console.log("");
    console.log(renderContextCacheHeatmap(prepared, configured.flags, maxCtx, systemRamBytes));

    // Context selection (presets + custom)
    const ctxPresets = CONTEXT_PRESETS.filter((ctx) => ctx <= maxCtx);
    const currentCtx = configured.flags.ctxSize;
    const ctxDefault = ctxPresets.includes(currentCtx) ? currentCtx : "custom";
    const ctxChoices = [
      ...ctxPresets.map((ctx) => ({ value: ctx, label: formatCtxLabel(ctx) })),
      { value: "custom", label: "Custom (enter tokens)" },
    ];
    console.log("");
    const ctxChoice = await prompt.choice("Select context window", ctxChoices, ctxDefault);
    let ctxSize;
    if (ctxChoice === "custom") {
      ctxSize = await prompt.number("Context window tokens", currentCtx, 1024, maxCtx);
    } else {
      ctxSize = ctxChoice;
    }
    configured = applyRuntimeFlagOverrides(configured, { ctxSize });

    // Cache type selection — show live memory at the chosen context for each option
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
    const cacheType = await prompt.choice("KV cache precision (K = V)", cacheChoices, configured.flags.cacheTypeK);

    // Optional: separate V cache precision (advanced — most users want K = V)
    const sameV = await prompt.yesNo("Use same precision for V cache?", true);
    let cacheTypeK = cacheType, cacheTypeV = cacheType;
    if (!sameV) {
      cacheTypeV = await prompt.choice("V cache precision", CACHE_CHOICES, cacheType);
    }
    configured = applyRuntimeFlagOverrides(configured, { cacheTypeK, cacheTypeV });
  } else {
    // Fallback: metadata unavailable — simple prompts without memory estimates
    console.log("");
    console.log(renderSection("Context window", renderRows([
      ["What it does", "Maximum tokens the model can process at once (prompt + response + history)"],
      ["Range", `1,024 – ${maxCtx.toLocaleString()} tokens`],
      ["Memory", "KV cache grows linearly — larger context = more RAM"],
      ["Guidance", "8k–32k: chat · 32k–80k: coding/long convos · 128k+: long documents"],
      ["Model max", `${maxCtx.toLocaleString()} tokens`],
      ["Default", `${configured.flags.ctxSize.toLocaleString()} tokens`],
    ])));
    const ctxSize = await prompt.number("Context window tokens", configured.flags.ctxSize, 1024, maxCtx);
    configured = applyRuntimeFlagOverrides(configured, { ctxSize });

    console.log("");
    console.log(renderSection("K cache precision", renderRows([
      ["What it is", "KV cache stores attention 'keys' — previous token states used for prediction"],
      ["Tradeoff", "Lower precision = less memory, potential quality loss"],
    ])));
    const cacheTypeK = await prompt.choice("K cache precision", CACHE_CHOICES, configured.flags.cacheTypeK);
    configured = applyRuntimeFlagOverrides(configured, { cacheTypeK });

    console.log("");
    console.log(renderSection("V cache precision", renderRows([
      ["What it is", "KV cache stores attention 'values' — token representations from previous layers"],
      ["Tradeoff", "Same as K cache. Some models are more sensitive to V precision than K"],
    ])));
    const cacheTypeV = await prompt.choice("V cache precision", CACHE_CHOICES, configured.flags.cacheTypeV);
    configured = applyRuntimeFlagOverrides(configured, { cacheTypeV });
  }

  // ── Memory estimate (with chosen context + cache) ──────────────────────
  console.log("");
  console.log(renderMemoryEstimate(configured, prepared));

  // ── Temperature ────────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Temperature", renderRows([
    ["What it does", "Controls randomness in token selection"],
    ["Range", "0.0 – 2.0"],
    ["0.0", "Deterministic — always picks most likely token"],
    ["0.6", "Balanced — default for most models"],
    ["1.0+", "Creative — more random, may hallucinate"],
    ["Guidance", "0–0.3: coding/factual · 0.4–0.8: chat · 0.9+: creative writing"],
  ])));
  const temperature = await prompt.number("Temperature", configured.flags.temperature, 0, 2, { float: true });
  configured = applyRuntimeFlagOverrides(configured, { temperature });

  // ── Top-p ──────────────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Top-p (nucleus sampling)", renderRows([
    ["What it does", "Only considers tokens in the top p fraction of probability mass"],
    ["Range", "0.0 – 1.0 (1.0 = consider all tokens)"],
    ["Guidance", "0.9–0.95: good default · Lower = more focused · Higher = more diverse"],
  ])));
  const topP = await prompt.number("Top-p", configured.flags.topP, 0, 1, { float: true });
  configured = applyRuntimeFlagOverrides(configured, { topP });

  // ── Top-k ──────────────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Top-k", renderRows([
    ["What it does", "Limits token selection to top K most likely tokens at each step"],
    ["Range", "0 – 1000 (0 = disabled, uses top-p instead)"],
    ["Guidance", "20: general chat · 40–64: thinking/reasoning · 0: rely on top-p"],
  ])));
  const topK = await prompt.number("Top-k", configured.flags.topK, 0, 1000);
  configured = applyRuntimeFlagOverrides(configured, { topK });

  // ── Min-p ──────────────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Min-p", renderRows([
    ["What it does", "Excludes tokens with probability below this threshold"],
    ["Range", "0.0 – 1.0 (0 = disabled)"],
    ["Guidance", "0: off (default) · 0.05–0.1: reduces hallucination while keeping creativity"],
  ])));
  const minP = await prompt.number("Min-p", configured.flags.minP, 0, 1, { float: true });
  configured = applyRuntimeFlagOverrides(configured, { minP });

  // ── Presence penalty ───────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Presence penalty", renderRows([
    ["What it does", "Discourages repeated tokens — each used token gets a fixed logit penalty"],
    ["Range", "0.0 – 2.0 (0 = off)"],
    ["Guidance", "0: thinking/reasoning · 1.0–1.5: general chat · Too high = incoherent"],
  ])));
  const presencePenalty = await prompt.number("Presence penalty", configured.flags.presencePenalty, 0, 2, { float: true });
  configured = applyRuntimeFlagOverrides(configured, { presencePenalty });

  // ── Repeat penalty ─────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Repeat penalty", renderRows([
    ["What it does", "Multiplies probability of repeated tokens (multiplicative, vs presence's additive)"],
    ["Range", "0.0 – 2.0 (1.0 = no effect)"],
    ["Guidance", "1.0–1.1: most use cases · Higher = aggressive anti-repeat · Can break code patterns"],
  ])));
  const repeatPenalty = await prompt.number("Repeat penalty", configured.flags.repeatPenalty, 0, 2, { float: true });
  configured = applyRuntimeFlagOverrides(configured, { repeatPenalty });

  // ── Batch size ─────────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Batch size", renderRows([
    ["What it does", "Tokens processed in parallel during prompt processing (before generation)"],
    ["Range", "1 – 4096"],
    ["Guidance", "512: good default · 2048+: faster for long prompts · Lower if memory tight"],
  ])));
  const batchSize = await prompt.number("Batch size", configured.flags.batchSize, 1, 4096);
  configured = applyRuntimeFlagOverrides(configured, { batchSize });

  // ── Parallel slots ─────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Parallel slots", renderRows([
    ["What it does", "Number of concurrent request slots (each handles an independent conversation)"],
    ["Range", "1 – 10"],
    ["Memory", "KV cache is multiplied by this number"],
    ["Guidance", "1: single-user local · 2+: multiple clients connecting simultaneously"],
  ])));
  const parallel = await prompt.number("Parallel slots", configured.flags.parallel, 1, 10);
  configured = applyRuntimeFlagOverrides(configured, { parallel });

  // ── Flash attention ────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Flash attention", renderRows([
    ["What it does", "Memory-efficient attention algorithm — faster and less RAM than standard"],
    ["Guidance", "Always on for modern hardware · Turn off only for old GPU driver compat issues"],
  ])));
  const flashAttn = await prompt.yesNo("Enable flash attention?", true);
  configured = applyRuntimeFlagOverrides(configured, { flashAttention: flashAttn ? "on" : "off" });

  // ── Jinja templates ────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Jinja chat templates", renderRows([
    ["What it does", "Enables Jinja2 template rendering for proper chat formatting"],
    ["Guidance", "Always on for modern models · Turn off only for very old models without chat templates"],
  ])));
  const jinja = await prompt.yesNo("Enable Jinja templates?", true);
  configured = applyRuntimeFlagOverrides(configured, { jinja });

  // ── Final summary ──────────────────────────────────────────────────────
  console.log("");
  console.log(renderSection("Configuration summary", renderRows([
    ["Model", pc.bold(configured.label)],
    ["Backend", configured.backend],
    ["Endpoint", configured.baseUrl],
    ["Context", `${configured.flags.ctxSize.toLocaleString()} tokens`],
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
    ...(configured.capabilities?.mtp ? [["MTP", "enabled"]] : []),
    ...(configured.capabilities?.vision ? [["Vision", "enabled"]] : []),
    ...(configured.capabilities?.thinking ? [["Thinking", "enabled"]] : []),
  ])));

  console.log("");
  console.log(renderMemoryEstimate(configured, prepared));
  if (!(await prompt.yesNo("Save profile with these settings?", true))) return null;
  return configured;
}

// ── Managed server (oMLX, Ollama) profile configuration ──────────────────

export async function configureManagedProfile(prompt, profile) {
  const backend = backendFor(profile.backend);
  if (backend.id === "ollama") return await configureOllamaProfile(prompt, profile);
  return await configureOmlxProfile(prompt, profile);
}

async function configureOmlxProfile(prompt, profile) {
  let configured = profile;
  const modelId = profile.omlxModel ?? profile.modelAlias ?? profile.id;

  // Detect MTP capability from the model's config.json
  const modelDir = await findOmlxModelDir(modelId);
  if (modelDir) {
    const mtpResult = await detectOmlxMtpCapability(modelDir);
    if (mtpResult.compatible) {
      console.log("");
      console.log(renderSection("MTP detected", renderRows([
        ["Feature", "Multi-Token Prediction (speculative decoding)"],
        ["Mechanism", "oMLX native MTP (enabled via admin API at load time)"],
      ])));
      const useMtp = await prompt.yesNo("Use MTP speculative decoding?", true);
      configured = { ...configured, capabilities: { ...(configured.capabilities ?? {}), mtp: useMtp } };
    } else if (mtpResult.reason !== "model has no MTP heads in config") {
      // Model declares MTP but can't use it — surface the reason
      console.log("");
      console.log(renderSection("MTP not available", renderRows([
        ["Feature", "Multi-Token Prediction (speculative decoding)"],
        ["Reason", pc.yellow(mtpResult.reason)],
      ])));
    }
    // If reason is "no MTP heads in config", don't surface anything —
    // most models don't have MTP, and showing a card for every non-MTP
    // model would be noise.
  }

  console.log("");
  console.log(renderSection("Model setup", renderRows([
    ["Model", pc.bold(profile.label)],
    ["Backend", "oMLX"],
    ...(configured.capabilities?.mtp ? [["MTP", "enabled"]] : []),
  ])));

  if (!(await prompt.yesNo("Save profile with these settings?", true))) return null;
  return configured;
}

// ── Ollama (managed server) profile configuration ──────────────────────────

async function configureOllamaProfile(prompt, profile) {
  let configured = profile;
  const modelId = profile.ollamaModel ?? profile.modelAlias ?? profile.id;

  // Query Ollama for model details (capabilities, parameters)
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
  } catch { /* model info unavailable — continue without it */ }

  console.log("");
  console.log(renderSection("Model setup", renderRows([
    ["Model", pc.bold(profile.label)],
    ["Backend", "Ollama"],
    ["Model ID", modelId],
    ...(capabilities.length > 0 ? [["Capabilities", capabilities.join(" · ")]] : []),
  ])));

  if (!(await prompt.yesNo("Save profile with these settings?", true))) return null;
  return configured;
}


function renderMemoryEstimate(profile, prepared) {
  try {
    const est = prepared
      ? computeMemoryTotal(prepared, profile.flags)
      : computeMemoryTotal(prepareMemoryEstimate(profile.modelPath, profile.mmprojPath, profile.drafterPath), profile.flags);
    return renderSection("Memory estimate", renderRows([
      ["Estimated total", pc.bold(`~${formatBytes(est.totalBytes)}`)],
      ["Model", formatBytes(est.modelBytes)],
      ...(est.mmprojBytes ? [["Vision projector", formatBytes(est.mmprojBytes)]] : []),
      ...(est.draftBytes ? [["Drafter (MTP)", formatBytes(est.draftBytes)]] : []),
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



