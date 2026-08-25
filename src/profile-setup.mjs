import { existsSync, statSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { prepareMemoryEstimate, computeMemoryTotal } from "./estimate.mjs";
import { availableRamBytes, installedRamGB } from "./hardware.mjs";
import { findLlamaServer } from "./config.mjs";
import { backendFor } from "./backends.mjs";
import { formatBytes, formatCtxLabel, renderList, card, padEndVisible, fitColor, renderMemoryEstimate, theme, status, promptConfirm, promptSelect, promptNumber } from "./ui.mjs";
import { execFileAsync } from "./exec.mjs";
import { detectGgufCapabilities, detectCapabilities, mtpEnabledFor } from "./capabilities.mjs";
import { readOmlxModelSettings } from "./mlx-discovery.mjs";
import { putOmlxModelSettings, omlxSettingsFailureHint } from "./omlx-runtime.mjs";
import { apiRootUrl } from "./server-status.mjs";
import { matchDrafter, scanGgufModels } from "./scan.mjs";
import { capabilitySummary } from "./model-summary.mjs";
import { effectiveModelId } from "./profiles.mjs";
import { applyRuntimeFlagOverrides, removeMtpDefaults, applyMtpDefaults, applyVisionDefaults, removeVisionDefaults, applyThinkingDefaults, removeThinkingDefaults } from "./profile-flags.mjs";
import { hfRepoFromPath, getHfGenerationConfig, extractRecommendedSamplers } from "./huggingface.mjs";
import { isUncustomizedSampler } from "./autodetect.mjs";

const CACHE_CHOICES = [
  { value: "bf16", label: "bf16", hint: "16-bit · best quality · 2 bytes/elem" },
  { value: "f16", label: "f16", hint: "16-bit · stable fallback · 2 bytes/elem" },
  { value: "q8_0", label: "q8_0", hint: "8-bit · half memory · usually safe · 1 byte/elem" },
  { value: "q4_0", label: "q4_0", hint: "4-bit · quarter memory · quality tradeoff · 0.5 bytes/elem" },
];

const THINKING_CHOICES = [
  { value: "", label: "Harness default (Pi/omp session level)" },
  { value: "off", label: "Off — no thinking" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

/** Ask which thinking level launches should use; stored per profile, inherited by benchmarks. */
async function askThinkingLevel(configured, backendId) {
  const current = configured.thinkingLevel ?? "";
  console.log("");
  if (backendId === "ollama") {
    hint("Ollama /v1 honors thinking levels as soft steering — but the thinking trace is never shown, and \"off\" still thinks at the server default (harness limitation).");
  } else {
    hint("How hard the model thinks on each launch. Benchmark runs inherit this. Harness default = Pi/omp session level.");
  }
  const level = await ask(promptSelect({ message: "Thinking level for launches", choices: THINKING_CHOICES, defaultValue: current }));
  const next = { ...configured };
  if (level) next.thinkingLevel = level;
  else delete next.thinkingLevel;
  return next;
}

/**
 * oMLX thinking controls (server-side settings). Verified 2026-08 on
 * oMLX 0.6.3rc2:
 * - Batched engines: thinking levels land (soft steering) and
 *   thinking_budget is enforced — a hard cap against runaway thinking.
 * - DFlash engine path: levels sent via client chat_template_kwargs DO
 *   land (verified 2026-08: reasoning_effort low vs xhigh = ~2-2.5x
 *   thinking-token reduction on hard prompts), but are soft steering, and
 *   thinking_budget is NOT enforced (a benchmark turn ran ~10K thinking
 *   tokens past an active 4096 cap). The template default when nothing is
 *   sent is xhigh — the runaway-turn cause. The only hard control:
 *   enable_thinking=false server-side PLUS no harness thinking controls
 *   on the wire (client kwargs override server settings) — which is why
 *   thinkingOff also strips reasoning from harness configs
 *   (harness-pi/harness-omp).
 * Answers are stored on the profile (thinkingOff / thinkingBudget),
 * pushed to the server immediately, and re-applied at launch.
 */
async function askOmlxThinkingControl(configured, serverSettings) {
  const next = { ...configured };
  console.log("");
  if (serverSettings?.dflash_enabled === true) {
    hint("DFlash is enabled — thinking levels work here but are soft steering (~2x swing, verified).");
    hint("The hard budget is NOT enforced on this path; turning thinking off entirely is the only hard control.");
    next.thinkingOff = await ask(promptConfirm({ message: "Turn thinking off entirely?", initialValue: next.thinkingOff ?? serverSettings?.enable_thinking === false }));
    delete next.thinkingBudget;
    return next;
  }
  delete next.thinkingOff;
  const current = serverSettings?.thinking_budget_enabled && Number.isFinite(serverSettings?.thinking_budget_tokens)
    ? serverSettings.thinking_budget_tokens
    : null;
  hint("Hard cap on thinking tokens, enforced server-side — stops runaway thinking that soft levels can't.");
  const wantsBudget = await ask(promptConfirm({ message: "Set a hard thinking budget?", initialValue: current != null }));
  if (!wantsBudget) {
    delete next.thinkingBudget;
    return next;
  }
  hint("Thinking is force-stopped at this many tokens · 4096 works well for Qwen3.8");
  next.thinkingBudget = await ask(promptNumber({ message: "Thinking budget tokens", defaultValue: next.thinkingBudget ?? current ?? DEFAULT_THINKING_BUDGET, min: 256, max: 65536 }));
  return next;
}

/** Push the thinking answers to the oMLX server right away (best-effort). No-op when nothing needs changing. */
async function applyOmlxThinkingSettings(profile, serverSettings) {
  const settings = {};
  if (typeof profile.thinkingOff === "boolean") settings.enable_thinking = !profile.thinkingOff;
  else if (serverSettings?.enable_thinking === false) settings.enable_thinking = true; // control moved off the DFlash path — restore the server default
  if (Number.isFinite(profile.thinkingBudget)) {
    settings.thinking_budget_enabled = true;
    settings.thinking_budget_tokens = profile.thinkingBudget;
  } else if (serverSettings?.thinking_budget_enabled) {
    settings.thinking_budget_enabled = false;
  }
  if (Object.keys(settings).length === 0) return;
  const result = await putOmlxModelSettings(apiRootUrl(profile.baseUrl), effectiveModelId(profile), settings);
  if (result.ok) {
    const unverified = result.verified === false ? " (not independently verified)" : "";
    const applied = [
      "enable_thinking" in settings ? `thinking ${settings.enable_thinking ? "on" : "off"}` : null,
      settings.thinking_budget_enabled === true ? `budget ${settings.thinking_budget_tokens.toLocaleString()} tokens` : null,
      settings.thinking_budget_enabled === false ? "budget disabled" : null,
    ].filter(Boolean).join(", ");
    console.log(status({ kind: "success", message: `oMLX thinking settings applied: ${applied}${unverified}` }));
  } else {
    console.log(status({ kind: "warning", message: `Could not apply thinking settings: ${omlxSettingsFailureHint(result)}` }));
    hint("Stored on the profile — minimal-ai will apply them on next launch.");
  }
}

const CONTEXT_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288];
const HEATMAP_CACHE_TYPES = ["bf16", "q8_0", "q4_0"];
const DEFAULT_THINKING_BUDGET = 4096;

function hint(text) {
  console.log(theme.subtle(`  ${text}`));
}

// ── Model-card sampler recommendations (#17) ─────────────────────────────
// HF repos ship the lab's recommended sampling params in
// generation_config.json. We fetch them lazily from the profile's HF repo
// (derived from the cached model path) and use them as the prompt defaults
// for uncustomized fields — never silently overwriting a value the user
// already set. The fetched block (or null marker) is stored on the profile
// so Reconfigure doesn't re-fetch.

/** Fetch + extract recommended samplers for a llama.cpp profile's HF repo.
 *  Returns { configured, recommended } — `configured` carries the stored
 *  `recommendedSamplers` field (object or null); `recommended` is the
 *  samplers object or null. */
async function loadRecommendedSamplers(configured) {
  if (configured.recommendedSamplers !== undefined) {
    return { configured, recommended: configured.recommendedSamplers };
  }
  let recommended = null;
  const repo = configured.modelPath ? hfRepoFromPath(configured.modelPath) : null;
  if (repo) {
    try {
      const cfg = await getHfGenerationConfig(repo);
      recommended = extractRecommendedSamplers(cfg);
    } catch {
      recommended = null;
    }
  }
  return { configured: { ...configured, recommendedSamplers: recommended }, recommended };
}

/** Prompt default for a sampler field: the model-card recommendation when
 *  one exists AND the saved value is still a fresh-profile default; otherwise
 *  the user's saved value (never silently override a deliberate choice). */
function samplerDefault(configured, field, recommended) {
  const saved = configured.flags[field];
  if (recommended && recommended[field] !== undefined && isUncustomizedSampler(field, saved)) {
    return recommended[field];
  }
  return saved;
}

/** A "Model card recommends X" hint line, or null when there's no
 *  recommendation for this field. */
function recommendedHint(field, recommended) {
  if (recommended && recommended[field] !== undefined) {
    return `Model card recommends ${recommended[field]}`;
  }
  return null;
}

/** Print the base sampler hint, plus a "Model card recommends X" line when
 *  the repo ships a recommendation for this field. */
function samplerHints(baseHint, field, recommended) {
  hint(baseHint);
  const r = recommendedHint(field, recommended);
  if (r) hint(r);
}

// ── KV-cache fidelity guardrail (#18) ─────────────────────────────────────
// Low-bit (q4_0) KV cache at long context (32K+) degrades tool-call
// fidelity in agentic runs (Level1Techs, Aug 2026). One-line hint, not a
// block — surfaced on the q4_0 choice and once before the cache pick.
const LONG_CONTEXT_KV_THRESHOLD = 32768;

function lowBitKvWarning(ctxSize) {
  return ctxSize > LONG_CONTEXT_KV_THRESHOLD;
}

const LOW_BIT_KV_HINT = "⚠ low-bit KV at 32K+ context can degrade tool-call fidelity — prefer q8_0+ for agentic runs";

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
  console.log(card({ title: "Model overview", body: renderList([
    ["Model", theme.bold(profile.label)],
    ["Detected", capabilitySummary(caps)],
    ["Backend", "llama.cpp (local server)"],
    ["Model file", profile.modelPath],
  ]) }));

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

    if (lowBitKvWarning(ctxSize)) hint(LOW_BIT_KV_HINT);

    const cacheChoices = CACHE_CHOICES.map((c) => {
      const flags = { ...configured.flags, ctxSize, cacheTypeK: c.value, cacheTypeV: c.value };
      const lowBitWarn = c.value === "q4_0" && lowBitKvWarning(ctxSize);
      const hint = lowBitWarn ? `${c.hint} · ${LOW_BIT_KV_HINT}` : c.hint;
      try {
        const est = computeMemoryTotal(prepared, flags);
        const color = fitColor(est.totalBytes, availableRam);
        return {
          value: c.value,
          label: `${c.label.padEnd(6)} ${color(`~${formatBytes(est.totalBytes)}`)}`,
          hint,
        };
      } catch {
        return { value: c.value, label: c.label, hint };
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

    if (lowBitKvWarning(ctxSize)) hint(LOW_BIT_KV_HINT);

    const kChoices = CACHE_CHOICES.map((c) => ({
      value: c.value,
      label: c.label,
      hint: c.value === "q4_0" && lowBitKvWarning(ctxSize) ? `${c.hint} · ${LOW_BIT_KV_HINT}` : c.hint,
    }));
    console.log("");
    hint("KV cache precision · lower = less memory · bf16 best quality · q8_0 usually safe");
    const cacheTypeK = await ask(promptSelect({ message: "K cache precision", choices: kChoices, defaultValue: configured.flags.cacheTypeK }));
    configured = applyRuntimeFlagOverrides(configured, { cacheTypeK });

    const vChoices = CACHE_CHOICES.map((c) => ({
      value: c.value,
      label: c.label,
      hint: c.value === "q4_0" && lowBitKvWarning(ctxSize) ? `${c.hint} · ${LOW_BIT_KV_HINT}` : c.hint,
    }));
    console.log("");
    hint("Same tradeoff as K cache · some models are more sensitive to V precision");
    const cacheTypeV = await ask(promptSelect({ message: "V cache precision", choices: vChoices, defaultValue: configured.flags.cacheTypeV }));
    configured = applyRuntimeFlagOverrides(configured, { cacheTypeV });
  }

  console.log("");
  console.log(card({ title: "Memory estimate", body: renderMemoryEstimate(computeMemoryTotal(prepared, configured.flags), configured.flags) }));

  console.log("");
  samplerHints("Randomness · 0 = deterministic · 0.6 balanced · 0.9+ creative", "temperature", rec);
  const temperature = await ask(promptNumber({ message: "Temperature", defaultValue: samplerDefault(configured, "temperature", rec), min: 0, max: 2, float: true }));
  configured = applyRuntimeFlagOverrides(configured, { temperature });

  console.log("");
  samplerHints("Token pool by probability mass · 0.9–0.95 good default", "topP", rec);
  const topP = await ask(promptNumber({ message: "Top-p", defaultValue: samplerDefault(configured, "topP", rec), min: 0, max: 1, float: true }));
  configured = applyRuntimeFlagOverrides(configured, { topP });

  console.log("");
  samplerHints("Limits to top K tokens · 0 = off (uses top-p) · 20 chat · 40–64 thinking", "topK", rec);
  const topK = await ask(promptNumber({ message: "Top-k", defaultValue: samplerDefault(configured, "topK", rec), min: 0, max: 1000 }));
  configured = applyRuntimeFlagOverrides(configured, { topK });

  console.log("");
  samplerHints("Probability floor · 0 = off · 0.05–0.1 reduces hallucination", "minP", rec);
  const minP = await ask(promptNumber({ message: "Min-p", defaultValue: samplerDefault(configured, "minP", rec), min: 0, max: 1, float: true }));
  configured = applyRuntimeFlagOverrides(configured, { minP });

  console.log("");
  samplerHints("Penalizes any used token · 0 = off · 1.0–1.5 general chat", "presencePenalty", rec);
  const presencePenalty = await ask(promptNumber({ message: "Presence penalty", defaultValue: samplerDefault(configured, "presencePenalty", rec), min: 0, max: 2, float: true }));
  configured = applyRuntimeFlagOverrides(configured, { presencePenalty });

  console.log("");
  samplerHints("Multiplies down repeated tokens · 1.0 = no effect · 1.0–1.1 typical", "repeatPenalty", rec);
  const repeatPenalty = await ask(promptNumber({ message: "Repeat penalty", defaultValue: samplerDefault(configured, "repeatPenalty", rec), min: 0, max: 2, float: true }));
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

  configured = await askThinkingLevel(configured, "llama-cpp");

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
    ["Thinking", configured.thinkingLevel ?? "harness default"],
    ...(mtpEnabledFor(configured) ? [["MTP", `enabled (${configured.flags.specDraftNMax ?? 2} draft tokens)`]] : []),
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

  // Server-reported context (max_model_len) beats config.json when available.
  // Profiles created before context-length persistence (v2.5.0) lack this
  // fact; Reconfigure re-detects it.
  let serverContext = null;
  try {
    const entry = (await backendFor("omlx").scanModels())
      .find((m) => m.id.toLowerCase() === modelId.toLowerCase());
    serverContext = entry?.contextLength ?? null;
  } catch { /* oMLX unreachable — detector falls back to config.json */ }

  const { mtpReason, ...facts } = await detectCapabilities({ backend: "omlx", modelId, contextLength: serverContext });
  configured = { ...configured, capabilities: { ...(configured.capabilities ?? {}), ...facts } };
  const serverSettings = await readOmlxModelSettings(modelId);

  console.log("");
  console.log(card({ title: "Model overview", body: renderList([
    ["Model", theme.bold(profile.label)],
    ["Detected", capabilitySummary(facts)],
    ["Backend", "oMLX (managed server)"],
    ["Context", facts.contextLength ? formatCtxLabel(facts.contextLength) : "unknown"],
  ]) }));

  if (facts.mtp) {
    console.log("");
    hint("oMLX native MTP — speculative decoding enabled at load time");
    const useMtp = await ask(promptConfirm({ message: "Use MTP speculative decoding?", initialValue: mtpEnabledFor(configured) }));
    configured = { ...configured, mtpEnabled: useMtp };
  } else if (mtpReason && mtpReason !== "model has no MTP heads in config") {
    console.log("");
    hint(`MTP not available — ${mtpReason}`);
  }

  const dflashOn = serverSettings?.dflash_enabled === true;
  if (facts.thinking) {
    // Off/budget first: answering "off" makes the level question moot.
    configured = await askOmlxThinkingControl(configured, serverSettings);
    if (!configured.thinkingOff) {
      if (dflashOn) {
        console.log("");
        hint("DFlash engine path: levels apply (soft steering, ~2x swing) — no hard budget on this path.");
      }
      configured = await askThinkingLevel(configured, "omlx");
    } else {
      console.log("");
      hint("Thinking is off — harness thinking toggles for this model are hidden so they can't override it.");
    }
  }

  console.log("");
  console.log(card({ title: "Model setup", body: renderList([
    ["Model", theme.bold(profile.label)],
    ["Backend", "oMLX"],
    ["Context", facts.contextLength ? formatCtxLabel(facts.contextLength) : "unknown"],
    ["Thinking", configured.thinkingOff
      ? "off entirely (server-side, hard)"
      : (configured.thinkingLevel ?? "harness default") + (dflashOn && facts.thinking ? " · soft steering on DFlash" : "")],
    ...(configured.thinkingBudget ? [["Thinking budget", `${configured.thinkingBudget.toLocaleString()} tokens`]] : []),
    ...(mtpEnabledFor(configured) && facts.mtp ? [["MTP", "enabled"]] : []),
    ...(facts.vision ? [["Vision", "yes"]] : []),
  ]) }));
  console.log(theme.subtle("  Server settings (quant, KV cache, MTP internals) live in the oMLX dashboard."));

  if (!(await ask(promptConfirm({ message: "Save profile with these settings?", initialValue: true })))) return null;
  if (facts.thinking) {
    await applyOmlxThinkingSettings(configured, serverSettings);
  }
  return configured;
}

async function configureOllamaProfile(profile) {
  let configured = profile;
  const modelId = effectiveModelId(profile);
  let facts = null;
  try {
    facts = await detectCapabilities({ backend: "ollama", modelId });
    configured = { ...configured, capabilities: { ...(configured.capabilities ?? {}), ...facts } };
  } catch { /* model info unavailable — keep existing facts */ }

  if (facts) {
    console.log("");
    console.log(card({ title: "Model overview", body: renderList([
      ["Model", theme.bold(profile.label)],
      ["Detected", capabilitySummary(facts)],
      ["Backend", "Ollama (managed server)"],
      ["Context", facts.contextLength ? formatCtxLabel(facts.contextLength) : "unknown"],
      ...(facts.tools ? [["Tools", "yes"]] : []),
    ]) }));
  }

  configured = await askThinkingLevel(configured, "ollama");

  console.log("");
  console.log(card({ title: "Model setup", body: renderList([
    ["Model", theme.bold(profile.label)],
    ["Backend", "Ollama"],
    ["Model ID", modelId],
    ["Thinking", configured.thinkingLevel ?? "harness default"],
    ...(facts ? [["Detected", [capabilitySummary(facts), facts.tools ? "tools" : null].filter(Boolean).join(" · ")]] : []),
  ]) }));
  console.log(theme.subtle("  Server settings live in the Ollama app / OLLAMA_* environment."));

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
