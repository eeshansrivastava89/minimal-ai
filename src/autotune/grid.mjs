// Autotune grid generator — turns one model's capability probe into the
// ordered list of configs the speed sweep will measure. Pure data: no
// network, no filesystem, no prompts. Every row carries its own settings
// delta (a partial oMLX settings object ready to PUT), a tested/skip flag
// with a human reason, and an estimated minute cost for the dry-run plan.
//
// The rules are transcribed from
// internal-docs/reference/2026-08-24-omlx-optimal-settings-search.md (the
// "Known traps" and "Per-model optimal rules" sections) and the rc3 update
// notes. A new model needs zero per-model authoring — the grid is derived
// entirely from its capability flags plus a DFlash-draft match heuristic.

// ── Knobs under test ───────────────────────────────────────────────────────
//
// Every row specifies the full set of speculative/thinking/ANE/KV-quant knobs
// so a measurement is never contaminated by a stale sibling left on from the
// user's prior settings (oMLX applies partial PUTs on top of existing state).
// Knobs not under test are forced off here; the row's "on" knobs merge on top.

const OFF = {
  mtp_enabled: false,
  dflash_enabled: false,
  enable_thinking: false,
  thinking_budget_enabled: false,
  qwen35_ane_prefill_enabled: false,
  turboquant_kv_enabled: false,
};

// Thinking budget enforced only with DFlash off (trap #1); 4096 is the
// reference doc's measured "bounded thinking" value (C4) and the predicted
// optimal bounded-thinking budget (open item #1).
const THINKING_BUDGET_TOKENS = 4096;

// Conservative per-row minute estimates for the dry-run plan card. These are
// expectations, not measurements — each row is one cold load + n warm runs
// with unload/PUT/verify bookends. The real numbers come back from the sweep.
const ESTIMATE_MINUTES = {
  vanilla: 8,
  mtp: 8,
  dflash: 8,
  thinking: 12,
  "mtp-thinking": 12,
  ane: 10,
  "turboquant-q4": 8,
  "turboquant-q8": 8,
};

// ── Base-family + fine-tune detection ──────────────────────────────────────
//
// DFlash draft matching needs two judgements from a model id:
//   1. baseFamily — the canonical model family, with quant/variant/fine-tune
//      suffixes stripped, so a draft and target can be compared.
//   2. isFinetune — whether the target is a *personality* fine-tune (diverges
//      from the base distribution a base DFlash draft was trained on). Format
//      variants and re-conversions (MTPLX, MTP, 4bit, DFlash2 itself) are NOT
//      fine-tunes — they preserve the base distribution, so a base draft still
//      matches them. This is the distinction the chimingw finding turns on:
//      base draft + base target = +34%; base draft + personality fine-tune =
//      measured slowdown.

// Tokens that mark a *personality* fine-tune (distribution shift). Adding a
// new one here is the only change needed to teach the heuristic a new merge.
const FINE_TUNE_INDICATORS = [
  "uncensored", "uncensor", "orcarouter", "instruct", "dpo", "rlhf",
  "openhermes", "hermes", "abliterated", "solar", "merge", "tiefighter",
  "magnum", "cydonia", "noromaid", "mythomax",
];

// Tokens stripped to reach the base family. Format/re-conversion tokens live
// here deliberately — they are NOT fine-tune indicators.
const FAMILY_SUFFIX_TOKENS = [
  "dflash2", "dflash", "mtplx", "mtp", "mlx", "optimized", "speed",
  "optiq", "opti", "oq4e", "oq8e", "q4", "q8", "4bit", "8bit", "16bit",
  ...FINE_TUNE_INDICATORS,
];

/**
 * Canonical model family from an id or display name, suffixes stripped.
 * `Qwen3.8-27B-4bit`, `Qwen3.8-27B-Uncensored-OrcaRouter-MLX-4bit`, and
 * `Qwen3.8-27B-DFlash2` all collapse to `qwen3.8-27b`.
 */
export function baseFamily(modelId) {
  const id = String(modelId ?? "").toLowerCase().replace(/^[^/]+\//, "").trim();
  // Canonical "<family>-<size>B" prefix covers Qwen3.8-27B-* and friends.
  const match = id.match(/^([a-z][a-z0-9]*(?:\.[0-9]+)*-\d+b)/);
  if (match) return match[1];
  // Fallback: strip the first recognized suffix token and everything after.
  for (const token of FAMILY_SUFFIX_TOKENS) {
    const stripped = id.replace(new RegExp(`-?${token}\\b.*$`, "i"), "");
    if (stripped && stripped !== id) return stripped;
  }
  return id;
}

/** True if the id carries a personality fine-tune indicator. */
export function isFinetune(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  return FINE_TUNE_INDICATORS.some((token) => id.includes(token));
}

// ── DFlash draft discovery + matching ──────────────────────────────────────

/**
 * DFlash draft candidates from an admin model list. Drafts surface as ordinary
 * discovered models whose id or display name contains "DFlash" (e.g.
 * `z-lab/Qwen3.8-27B-DFlash2`, engine `batched`).
 */
export function findDflashDrafts(models) {
  return models.filter((m) => /dflash/i.test(m.id) || /dflash/i.test(m.displayName ?? ""));
}

/**
 * Pick the DFlash draft that matches the target, or explain why none does.
 * Returns `{ matched: true, draft }` or `{ matched: false, reason }`.
 * Callers should already have checked `targetModel.dflashCompatible`.
 */
export function pickDflashDraft(targetModel, drafts) {
  const family = baseFamily(targetModel.id);
  if (isFinetune(targetModel.id)) {
    return {
      matched: false,
      reason: `personality fine-tune target — the ${family} DFlash draft is trained on the base distribution and will mismatch (measured slowdown on fine-tunes); skip unless a draft trained on this fine-tune is published`,
    };
  }
  const candidates = drafts.filter((d) => baseFamily(d.id) === family);
  if (candidates.length === 0) {
    return { matched: false, reason: `no DFlash draft model discovered for ${family}` };
  }
  return { matched: true, draft: candidates[0] };
}

// ── Grid row factory ───────────────────────────────────────────────────────

/**
 * Build one grid row. `settings` is the partial oMLX settings delta to PUT
 * (already a clean spec — siblings forced off). Skipped rows still carry
 * their would-be settings so the dry-run plan can show what was considered.
 */
function makeRow(id, family, label, tested, skipReason, settings, notes) {
  return {
    id,
    family,
    label,
    tested,
    skipReason: tested ? null : skipReason,
    estMinutes: ESTIMATE_MINUTES[id] ?? 0,
    settings,
    notes,
  };
}

// ── Grid generation ────────────────────────────────────────────────────────

/**
 * Generate the speed-sweep grid for one target model.
 *
 * @param {object} targetModel  normalized probe record (see probe.mjs).
 * @param {object[]} allModels  full normalized admin list — used to discover
 *                              DFlash drafts. Pass [] if unavailable.
 * @returns {object[]} ordered grid rows (see makeRow shape).
 *
 * Rules (reference doc "Known traps" + "Per-model optimal rules"):
 *   • vanilla baseline always tested.
 *   • MTP row tested iff mtpCompatible (uses the model's own heads).
 *   • DFlash row tested iff dflashCompatible AND a matching draft exists AND
 *     the target is not a personality fine-tune. MTP and DFlash are competing
 *     drafters — never stacked.
 *   • thinking row (bounded, DFlash off) always tested — budget is enforced
 *     only with DFlash off (trap #1), so the beauty path forces DFlash off.
 *   • MTP+thinking row tested iff mtpCompatible (open item #1 — the predicted
 *     optimal bounded-thinking config).
 *   • ANE prefill row always tested (rc3 re-test; memory-guard rationale
 *     obsolete). Isolated on the vanilla baseline to measure its marginal
 *     effect (ANE does nothing on the DFlash path).
 *   • turboquant q4 / q8 rows always tested (speed + memory signal; KV-quant
 *     quality at long context is a Phase 4 concern).
 */
export function generateGrid(targetModel, allModels = []) {
  const drafts = findDflashDrafts(allModels);
  const rows = [];

  // 1 — vanilla baseline.
  rows.push(makeRow(
    "vanilla", "baseline", "vanilla", true, null,
    { ...OFF },
    "baseline — all speculative/thinking off",
  ));

  // 2 — MTP (model's own draft heads; only when compatible).
  if (targetModel.mtpCompatible) {
    rows.push(makeRow(
      "mtp", "speculative", "MTP on", true, null,
      { ...OFF, mtp_enabled: true },
      "MTP on — the model's own draft heads",
    ));
  } else {
    rows.push(makeRow(
      "mtp", "speculative", "MTP on", false,
      targetModel.mtpReason || "model is not MTP-compatible",
      { ...OFF, mtp_enabled: true },
      "MTP",
    ));
  }

  // 3 — DFlash (matching draft required; never stacked with MTP).
  if (!targetModel.dflashCompatible) {
    rows.push(makeRow(
      "dflash", "speculative", "DFlash on", false,
      targetModel.dflashReason || "model is not DFlash-compatible",
      { ...OFF, dflash_enabled: true },
      "DFlash",
    ));
  } else {
    const pick = pickDflashDraft(targetModel, drafts);
    if (pick.matched) {
      const draftId = pick.draft.displayName || pick.draft.id;
      rows.push(makeRow(
        "dflash", "speculative", "DFlash on", true, null,
        { ...OFF, dflash_enabled: true, dflash_draft_model: draftId },
        `DFlash on — draft ${draftId}`,
      ));
    } else {
      rows.push(makeRow(
        "dflash", "speculative", "DFlash on", false, pick.reason,
        { ...OFF, dflash_enabled: true },
        "DFlash",
      ));
    }
  }

  // 4 — bounded thinking (DFlash off so the budget is enforced — trap #1).
  rows.push(makeRow(
    "thinking", "thinking", "thinking + budget", true, null,
    { ...OFF, enable_thinking: true, thinking_budget_enabled: true, thinking_budget_tokens: THINKING_BUDGET_TOKENS },
    `thinking on, budget ${THINKING_BUDGET_TOKENS} — DFlash off so the budget is enforced (beauty path)`,
  ));

  // 5 — MTP + bounded thinking (open item #1; only when MTP compatible).
  if (targetModel.mtpCompatible) {
    rows.push(makeRow(
      "mtp-thinking", "thinking", "MTP + thinking + budget", true, null,
      { ...OFF, mtp_enabled: true, enable_thinking: true, thinking_budget_enabled: true, thinking_budget_tokens: THINKING_BUDGET_TOKENS },
      `MTP + thinking + budget ${THINKING_BUDGET_TOKENS} — predicted optimal bounded-thinking config`,
    ));
  }

  // 6 — ANE prefill (rc3 re-test; isolated on the vanilla baseline).
  rows.push(makeRow(
    "ane", "ane", "ANE prefill", true, null,
    { ...OFF, qwen35_ane_prefill_enabled: true },
    "ANE prefill on — rc3 re-test (memory-guard rationale obsolete)",
  ));

  // 7–8 — turboquant KV-cache quant (speed/memory; quality is Phase 4).
  rows.push(makeRow(
    "turboquant-q4", "kvquant", "turboquant q4", true, null,
    { ...OFF, turboquant_kv_enabled: true, turboquant_kv_bits: 4 },
    "KV-cache quant q4 — speed/memory; long-context quality is a Phase 4 concern",
  ));
  rows.push(makeRow(
    "turboquant-q8", "kvquant", "turboquant q8", true, null,
    { ...OFF, turboquant_kv_enabled: true, turboquant_kv_bits: 8 },
    "KV-cache quant q8 — speed/memory; long-context quality is a Phase 4 concern",
  ));

  return rows;
}

/** Total estimated minutes across the tested rows (for the dry-run plan). */
export function estimateGridMinutes(rows) {
  return rows.filter((r) => r.tested).reduce((sum, r) => sum + r.estMinutes, 0);
}