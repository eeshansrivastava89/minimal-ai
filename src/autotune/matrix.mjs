// Autotune result matrix (the full config space as a grid). Pure data —
// printing lives in autotune.mjs via ui/table.mjs. All coordinates derive
// from each row's own `settings` delta (grid rows and journal results both
// carry one), so nothing here hardcodes a config's meaning: change a knob in
// grid.mjs and the matrix follows.

// The space is 4 axes: speculative (none/MTP/DFlash) × thinking (off/on,
// budget carried by the grid) × ANE prefill (off/on) × KV-quant (off/q4/q8)
// = 3×2×2×3 = 36 combos. Rendered as one block per KV-quant state, each
// block a 3×4 sub-matrix. Cells are one of:
//   "✓" / a measurement — tested
//   "–"                  — compatible, not measured (isolated-knob scope)
//   "NA"                 — not possible for this model
import { sweepBaseline, sweepRowDelta, recommendedId } from "./report.mjs";

const SPEC_ROWS = [
  ["none", "none"],
  ["mtp", "MTP (own heads)"],
  ["dflash", "DFlash (z-lab)"],
];
// Column axis = (thinking, ane) pairs, left to right.
const COL_AXES = [
  ["off", "off"],
  ["off", "on"],
  ["on", "off"],
  ["on", "on"],
];
const KV_STATES = ["off", "q4", "q8"];

function coordKey({ spec, think, ane, kv }) {
  return `${spec}|${think}|${ane}|${kv}`;
}

/** The (spec, think, ane, kv) coordinates a row's settings land on. kv uses
 *  the block keys ("off" | "q4" | "q8") — grid rows always set
 *  turboquant_kv_bits for enabled rows, so bits 4/8 map to "q4"/"q8". */
export function rowCoordinates(settings) {
  return {
    spec: settings.dflash_enabled ? "dflash" : settings.mtp_enabled ? "mtp" : "none",
    think: settings.enable_thinking ? "on" : "off",
    ane: settings.qwen35_ane_prefill_enabled ? "on" : "off",
    kv: settings.turboquant_kv_enabled ? `q${settings.turboquant_kv_bits ?? ""}` : "off",
  };
}

/** Which combos are impossible for this model family (never cell-able). */
export function comboPossible(spec, think, ane) {
  // DFlash runs its own engine path: no thinking budget there (trap #1) and
  // no batched-engine ANE prefill.
  return !(spec === "dflash" && (think === "on" || ane === "on"));
}

/** "think +N" column label from the grid's own thinking budget. */
export function thinkingColumnLabel(kvRows) {
  const thinkingRow = kvRows.find((r) => r.settings.enable_thinking);
  const budget = thinkingRow?.settings.thinking_budget_tokens;
  return budget == null ? "think on" : `think +${budget}`;
}

function buildBlocksFrom(rows, cellFor) {
  const byCoord = new Map(rows.map((r) => [coordKey(rowCoordinates(r.settings)), r]));
  const blocks = KV_STATES.map((kv) => ({
    kv,
    rows: SPEC_ROWS.map(([spec, label]) => ({
      label,
      cells: COL_AXES.map(([think, ane]) =>
        comboPossible(spec, think, ane)
          ? cellFor(byCoord.get(coordKey({ spec, think, ane, kv })))
          : { text: "NA", kind: "na" },
      ),
    })),
  }));
  return blocks;
}

/** Dry-run matrix: what the sweep will (✓) and won't (–/NA) measure. */
export function planMatrix(rows) {
  return buildBlocksFrom(rows, (row) => (row ? { text: "✓", kind: "tick" } : { text: "–", kind: "empty" }));
}

function deltaText(r, baseline) {
  const d = sweepRowDelta(r, baseline);
  if (d.isBaseline) return "baseline";
  if (d.pct == null) return "—";
  const sign = d.pct >= 0 ? "+" : "−";
  return `${sign}${Math.abs(d.pct).toFixed(0)}%${d.noise ? " ≈" : ""}`;
}

/** Results matrix: measured cells carry "tps (delta)", star on the pick. */
export function resultsMatrix(results, recommendation) {
  const baseline = sweepBaseline(results);
  const recId = recommendedId(recommendation);
  return buildBlocksFrom(results, (r) => {
    if (!r) return { text: "–", kind: "empty" };
    return {
      text: `${r.summary.median.toFixed(1)} (${deltaText(r, baseline)})`,
      kind: r.configId === recId ? "value-star" : "value",
    };
  });
}

/** Headers for the four (think × ane) columns — the budget number comes
 *  from the grid's own data, never hardcoded. */
export function matrixHeaders(rows) {
  const thinkLabel = thinkingColumnLabel(rows);
  return COL_AXES.map(([think, ane]) => `${think === "on" ? thinkLabel : "think off"} · ANE ${ane}`);
}
