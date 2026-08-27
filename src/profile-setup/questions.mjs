// Shared question machinery for profile setup/reconfigure (A1). One home for
// the prompt helpers, choices, the data-driven sampler table, and the
// context/KV-cache block (which used to be duplicated across the two
// has-KV-params branches of the local flow).

import { formatBytes, formatCtxLabel, renderList, padEndVisible, fitColor, theme, status, promptConfirm, promptSelect, promptNumber, maxWidth, visibleLen } from "../ui.mjs";
import { computeMemoryTotal } from "../estimate.mjs";
import { installedRamGB, availableRamBytes } from "../hardware.mjs";
import { isUncustomizedSampler } from "../autodetect.mjs";
import { hfRepoFromPath, getHfGenerationConfig, extractRecommendedSamplers } from "../huggingface.mjs";
import { applyRuntimeFlagOverrides } from "../profile-flags.mjs";

export const CACHE_CHOICES = [
  { value: "bf16", label: "bf16", hint: "16-bit · best quality · 2 bytes/elem" },
  { value: "f16", label: "f16", hint: "16-bit · stable fallback · 2 bytes/elem" },
  { value: "q8_0", label: "q8_0", hint: "8-bit · half memory · usually safe · 1 byte/elem" },
  { value: "q4_0", label: "q4_0", hint: "4-bit · quarter memory · quality tradeoff · 0.5 bytes/elem" },
];

export const THINKING_CHOICES = [
  { value: "", label: "Harness default (Pi/omp session level)" },
  { value: "off", label: "Off — no thinking" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

export const CONTEXT_PRESETS = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288];
export const HEATMAP_CACHE_TYPES = ["bf16", "q8_0", "q4_0"];
export const DEFAULT_THINKING_BUDGET = 4096;

export const LONG_CONTEXT_KV_THRESHOLD = 32768;
export function lowBitKvWarning(ctxSize) {
  return ctxSize > LONG_CONTEXT_KV_THRESHOLD;
}
export const LOW_BIT_KV_HINT = "⚠ low-bit KV at 32K+ context can degrade tool-call fidelity — prefer q8_0+ for agentic runs";

export function hint(text) {
  console.log(theme.subtle(`  ${text}`));
}

/** Unwrap a prompt result; null means the user pressed Escape — cancel the whole setup. */
export async function ask(promise) {
  const value = await promise;
  if (value === null) throw new CancelSetup();
  return value;
}

export class CancelSetup extends Error {}

/** Ask which thinking level launches should use; stored per profile, inherited by benchmarks. */
export async function askThinkingLevel(configured, backendId) {
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
export async function askOmlxThinkingControl(configured, serverSettings) {
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
export async function loadRecommendedSamplers(configured) {
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
 *  the user's saved value (never silently override a deliberate choice).
 *  Exported for testing the seeding rule without driving the prompt UI. */
export function samplerDefault(configured, field, recommended) {
  const saved = configured.flags[field];
  if (recommended && recommended[field] !== undefined && isUncustomizedSampler(field, saved)) {
    return recommended[field];
  }
  return saved;
}

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

// ── Sampler fields (data-driven: one row per sampler) ─────────────────────
// Add a sampler here and it appears in the questions AND the summary.
export const SAMPLERS = [
  { field: "temperature", label: "Temperature", hint: "Randomness · 0 = deterministic · 0.6 balanced · 0.9+ creative", min: 0, max: 2, float: true },
  { field: "topP", label: "Top-p", hint: "Token pool by probability mass · 0.9–0.95 good default", min: 0, max: 1, float: true },
  { field: "topK", label: "Top-k", hint: "Limits to top K tokens · 0 = off (uses top-p) · 20 chat · 40–64 thinking", min: 0, max: 1000 },
  { field: "minP", label: "Min-p", hint: "Probability floor · 0 = off · 0.05–0.1 reduces hallucination", min: 0, max: 1, float: true },
  { field: "presencePenalty", label: "Presence penalty", hint: "Penalizes any used token · 0 = off · 1.0–1.5 general chat", min: 0, max: 2, float: true },
  { field: "repeatPenalty", label: "Repeat penalty", hint: "Multiplies down repeated tokens · 1.0 = no effect · 1.0–1.1 typical", min: 0, max: 2, float: true },
];

/** Ask all sampler questions; returns a new configured profile. */
export async function askSamplers(configured, recommended) {
  let next = configured;
  for (const s of SAMPLERS) {
    console.log("");
    samplerHints(s.hint, s.field, recommended);
    const value = await ask(promptNumber({ message: s.label, defaultValue: samplerDefault(next, s.field, recommended), min: s.min, max: s.max, float: s.float }));
    next = applyRuntimeFlagOverrides(next, { [s.field]: value });
  }
  return next;
}

// ── KV-cache fidelity guardrail (#18) ─────────────────────────────────────
// Low-bit (q4_0) KV cache at long context (32K+) degrades tool-call
// fidelity in agentic runs (Level1Techs, Aug 2026). One-line hint, not a
// block — surfaced on the q4_0 choice and once before the cache pick.

/** q4_0 cache choices carry the low-bit warning when the context is long. */
export function cacheChoiceHint(c, ctxSize) {
  return c.value === "q4_0" && lowBitKvWarning(ctxSize) ? `${c.hint} · ${LOW_BIT_KV_HINT}` : c.hint;
}

/** Ask a single cache-precision question (no RAM estimates — the plain path). */
export async function askCachePrecision(message, hintText, ctxSize, currentValue) {
  const choices = CACHE_CHOICES.map((c) => ({ value: c.value, label: c.label, hint: cacheChoiceHint(c, ctxSize) }));
  console.log("");
  hint(hintText);
  return await ask(promptSelect({ message, choices, defaultValue: currentValue }));
}

function renderContextCacheHeatmap(prepared, baseFlags, maxCtx, availableRam) {
  const presets = [...CONTEXT_PRESETS.filter((ctx) => ctx <= maxCtx)];
  const currentCtx = baseFlags.ctxSize;
  if (!presets.includes(currentCtx) && currentCtx >= 1024 && currentCtx <= maxCtx) {
    presets.push(currentCtx);
    presets.sort((a, b) => a - b);
  }
  const parallel = baseFlags.parallel ?? 1;

  const cacheLabels = HEATMAP_CACHE_TYPES.map((t) => {
    const choice = CACHE_CHOICES.find((c) => c.value === t);
    const bytesInfo = choice?.hint?.match(/([\d.]+ bytes\/elem)/)?.[1] ?? "";
    return `${t} ${theme.subtle(bytesInfo ? `(${bytesInfo})` : "")}`;
  });

  const allRows = presets.map((ctx) => {
    const cells = HEATMAP_CACHE_TYPES.map((cacheType) => {
      try {
        return computeMemoryTotal(prepared, { ...baseFlags, ctxSize: ctx, cacheTypeK: cacheType, cacheTypeV: cacheType });
      } catch {
        return { totalBytes: 0 };
      }
    });
    return { ctx, cells };
  });

  // Width ceiling: with no card chrome the table still has to fit the
  // terminal — drop the largest context presets until it does (never the
  // currently-selected one).
  const widthFor = (rows) => {
    const col0 = Math.max(visibleLen("Context"), ...rows.map((r) => formatCtxLabel(r.ctx).length), "Custom".length) + 3;
    const cols = HEATMAP_CACHE_TYPES.map((_, colIdx) => {
      const cellLens = rows.map((row) => {
        const est = row.cells[colIdx];
        return est.totalBytes ? `~${formatBytes(est.totalBytes)}`.length : 1;
      });
      return Math.max(...cellLens, visibleLen(cacheLabels[colIdx])) + 3;
    });
    return col0 + cols.reduce((a, b) => a + b, 0);
  };
  let rows = allRows;
  while (rows.length > 2 && widthFor(rows) > maxWidth() - 2) {
    const removable = allRows.filter((r) => r.ctx !== currentCtx && rows.includes(r));
    if (removable.length <= 1) break;
    const largest = removable.reduce((a, b) => (b.ctx > a.ctx ? b : a));
    rows = rows.filter((r) => r !== largest);
  }

  const ctxLabels = rows.map((r) => formatCtxLabel(r.ctx));
  const col0Width = Math.max(visibleLen("Context"), ...ctxLabels.map((l) => l.length), "Custom".length) + 3;
  const colWidths = HEATMAP_CACHE_TYPES.map((_, colIdx) => {
    const cellLens = rows.map((row) => {
      const est = row.cells[colIdx];
      return est.totalBytes ? `~${formatBytes(est.totalBytes)}`.length : 1;
    });
    return Math.max(...cellLens, visibleLen(cacheLabels[colIdx])) + 3;
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
  if (rows.length < allRows.length) {
    lines.push(theme.subtle(`(larger presets hidden — terminal too narrow)`));
  }

  return lines.join("\n");
}

/**
 * Ask context window + KV cache precision — the one merged block (A1) for
 * both the has-KV-params (heatmap + estimates) and plain (number + plain
 * choices) paths. Returns a new configured profile.
 */
export async function askContextAndKvCache(configured, { prepared, maxCtx, availableRam, hasKvParams, applyRuntimeFlagOverrides }) {
  let next = configured;
  if (hasKvParams) {
    console.log("");
    console.log(theme.bold("Context & KV cache — total RAM by context window"));
    console.log(renderContextCacheHeatmap(prepared, next.flags, maxCtx, availableRam));

    const ctxPresets = CONTEXT_PRESETS.filter((ctx) => ctx <= maxCtx);
    const currentCtx = next.flags.ctxSize;
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
    next = applyRuntimeFlagOverrides(next, { ctxSize });

    if (lowBitKvWarning(ctxSize)) hint(LOW_BIT_KV_HINT);

    const cacheChoices = CACHE_CHOICES.map((c) => {
      const flags = { ...next.flags, ctxSize, cacheTypeK: c.value, cacheTypeV: c.value };
      try {
        const est = computeMemoryTotal(prepared, flags);
        const color = fitColor(est.totalBytes, availableRam);
        return {
          value: c.value,
          label: `${c.label.padEnd(6)} ${color(`~${formatBytes(est.totalBytes)}`)}`,
          hint: cacheChoiceHint(c, ctxSize),
        };
      } catch {
        return { value: c.value, label: c.label, hint: cacheChoiceHint(c, ctxSize) };
      }
    });
    const cacheType = await ask(promptSelect({ message: "KV cache precision (K = V)", choices: cacheChoices, defaultValue: next.flags.cacheTypeK }));

    const sameV = await ask(promptConfirm({ message: "Use same precision for V cache?", initialValue: true }));
    let cacheTypeK = cacheType, cacheTypeV = cacheType;
    if (!sameV) {
      cacheTypeV = await ask(promptSelect({ message: "V cache precision", choices: CACHE_CHOICES, defaultValue: cacheType }));
    }
    return applyRuntimeFlagOverrides(next, { cacheTypeK, cacheTypeV });
  }

  console.log("");
  hint(`Max tokens per request · KV cache grows with context · model max ${maxCtx.toLocaleString()}`);
  const ctxSize = await ask(promptNumber({ message: "Context window tokens", defaultValue: next.flags.ctxSize, min: 1024, max: maxCtx }));
  next = applyRuntimeFlagOverrides(next, { ctxSize });

  if (lowBitKvWarning(ctxSize)) hint(LOW_BIT_KV_HINT);

  const cacheTypeK = await askCachePrecision("K cache precision", "KV cache precision · lower = less memory · bf16 best quality · q8_0 usually safe", ctxSize, next.flags.cacheTypeK);
  next = applyRuntimeFlagOverrides(next, { cacheTypeK });

  const cacheTypeV = await askCachePrecision("V cache precision", "Same tradeoff as K cache · some models are more sensitive to V precision", ctxSize, next.flags.cacheTypeV);
  return applyRuntimeFlagOverrides(next, { cacheTypeV });
}