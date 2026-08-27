// Shared sweep-report computation (A3): the terminal table and results.md
// previously recomputed grouping, sort, and baseline deltas independently and
// could disagree. Both renderers now consume these functions, so a sweep row
// reads identically wherever it lands.

import { isThinkingOn, compareReal } from "./recommend.mjs";

/** The baseline config (vanilla) of a sweep result set, or undefined. */
export function sweepBaseline(results) {
  return results.find((r) => r.configId === "vanilla");
}

/** Group results by path (fast = thinking off, beauty = thinking on), each
 *  sorted by median tps descending. Null medians (failed configs) sort last —
 *  raw subtraction on null produces NaN and an unstable order. */
export function groupSweepResults(results) {
  const byMedianDesc = (a, b) => (b.summary.median ?? -Infinity) - (a.summary.median ?? -Infinity);
  return {
    fast: results.filter((r) => !isThinkingOn(r)).sort(byMedianDesc),
    beauty: results.filter(isThinkingOn).sort(byMedianDesc),
  };
}

/**
 * One row's delta facts vs the baseline:
 *   { isBaseline: true }                                — the vanilla row
 *   { pct, noise }                                      — % delta and whether
 *     the difference is inside 2× the within-config noise (MAD), i.e. a tie
 *   { pct: null, noise: null }                          — no measurement
 * Renderers format; they never recompute.
 */
export function sweepRowDelta(r, baseline) {
  if (r.configId === "vanilla") return { isBaseline: true, pct: null, noise: null };
  if (!baseline?.summary.median || !r.summary.median) return { isBaseline: false, pct: null, noise: null };
  const pct = ((r.summary.median - baseline.summary.median) / baseline.summary.median) * 100;
  return { isBaseline: false, pct, noise: compareReal(r, baseline) === "noise" };
}

/** The recommended config id, or null when the sweep produced none. */
export function recommendedId(recommendation) {
  return recommendation?.ok ? recommendation.recommendation.configId : null;
}
