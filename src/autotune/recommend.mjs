// Autotune recommendation engine — picks the optimal config from a completed
// speed sweep and folds it into optimal.json. Pure over the result set; the
// only I/O is writeOptimalJson.
//
// Rules (reference doc "Per-model optimal rules"):
//   • fast path  = the highest-tps thinking-OFF config (speed is v1's goal).
//   • beauty path = the highest-tps thinking-ON config (bounded thinking,
//     DFlash off so the budget is enforced). Cited as the quality alternative.
//   • v1 recommends the fast path and names the beauty path; the quality
//     phase (v2) decides when the beauty path's quality justifies its ~2× wall.
//
// A cross-config tps difference is "real" when it is ≥ 2× the within-config
// noise (MAD) — the reference doc's "≥2× over noise = real" rule. The summary
// carries the MAD; this module applies the threshold to flag noise-bound rows.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const THINKING_CONFIGS = new Set(["thinking", "mtp-thinking"]);
const REAL_DIFFERENCE_MULTIPLE = 2;

export function isThinkingOn(result) {
  return THINKING_CONFIGS.has(result.configId);
}

/**
 * Join journal config-done rows with their grid rows so a resumed sweep can
 * recommend without re-measuring. The journal carries the summary; the grid
 * row carries the settings + family to apply.
 */
export function resultsFromJournal(journalRows, gridRows) {
  const byId = new Map(gridRows.map((r) => [r.id, r]));
  return journalRows
    .filter((r) => r.event === "config-done")
    .map((r) => {
      const grid = byId.get(r.configId);
      if (!grid) return null;
      return {
        configId: r.configId,
        label: r.label,
        family: grid.family,
        settings: grid.settings,
        summary: r.summary,
      };
    })
    .filter(Boolean);
}

/**
 * Compare two configs' medians against noise. Returns "real" | "noise" | "n/a".
 * A difference is real when |a.median - b.median| >= 2× the larger MAD (the
 * noisier config sets the bar).
 */
export function compareReal(resultA, resultB) {
  const a = resultA?.summary?.median;
  const b = resultB?.summary?.median;
  if (a == null || b == null) return "n/a";
  const noise = Math.max(resultA.summary.mad ?? 0, resultB.summary.mad ?? 0);
  if (noise === 0) return Math.abs(a - b) > 0 ? "real" : "n/a";
  return Math.abs(a - b) >= REAL_DIFFERENCE_MULTIPLE * noise ? "real" : "noise";
}

function fmtTps(r) {
  return r?.summary?.median != null ? `${r.summary.median.toFixed(1)} tps` : null;
}

function fmtAccept(r) {
  const pct = r?.summary?.mtp?.acceptPct;
  return pct != null ? `, accept ${pct.toFixed(1)}%` : "";
}

function buildReasoning({ fastPath, beautyPath, baseline, noChange, beautyWithinNoise }) {
  if (noChange) {
    return "No config beat the clean baseline beyond measurement noise (2× MAD) — keeping your current settings.";
  }
  const parts = [];
  if (fastPath) {
    parts.push(`${fastPath.label} — ${fmtTps(fastPath)}${fmtAccept(fastPath)}`);
    if (baseline && baseline.configId !== fastPath.configId && baseline.summary?.median) {
      const delta = ((fastPath.summary.median - baseline.summary.median) / baseline.summary.median) * 100;
      const sign = delta >= 0 ? "+" : "";
      parts.push(`(${sign}${delta.toFixed(0)}% vs vanilla ${baseline.summary.median.toFixed(1)} tps)`);
    }
  }
  if (beautyPath) {
    // When the beauty path's apparent edge is within noise of the fast path,
    // say so — its higher tps also counts thinking tokens (not useful output),
    // so it is not a reliable speed gain. This is the case that looked like a
    // bug in 3.x: beauty path ranked first but fast path recommended.
    const caveat = beautyWithinNoise
      ? " — within noise of the fast path, and its tps counts thinking tokens, so not a reliable speed gain"
      : "";
    parts.push(`Beauty path: ${beautyPath.label} at ${fmtTps(beautyPath)}${fmtAccept(beautyPath)}${caveat}`);
  }
  return parts.join(" ");
}

/**
 * Pick the fast + beauty paths from a sweep result set.
 * Returns { ok, fastPath, beautyPath, recommendation, reasoning } or
 * { ok: false, reason: "no-results" }.
 */
export function recommendOptimal(results) {
  const valid = results.filter((r) => r?.summary?.median != null);
  if (valid.length === 0) return { ok: false, reason: "no-results" };

  const byTps = (a, b) => b.summary.median - a.summary.median;
  const fast = valid.filter((r) => !isThinkingOn(r)).sort(byTps);
  const beauty = valid.filter(isThinkingOn).sort(byTps);

  const fastPath = fast[0] ?? null;
  const beautyPath = beauty[0] ?? null;
  const baseline = valid.find((r) => r.configId === "vanilla") ?? null;

  // The fast path is v1's recommendation — but only if it actually beats the
  // clean baseline beyond measurement noise. If the fastest thinking-off
  // config is within 2× MAD of vanilla, no feature measurably helps, so we
  // report that honestly (noChange) instead of dressing up a tie as a win.
  // The apply step then restores the user's prior settings rather than
  // applying a no-op.
  let recommendation = fastPath ?? beautyPath;
  let noChange = false;
  if (fastPath && baseline && baseline.configId !== fastPath.configId) {
    // "n/a" happens on an exact tie with zero measured noise (e.g. one warm
    // sample each) — a tie must not be dressed up as a win either.
    if (compareReal(fastPath, baseline) !== "real") {
      recommendation = baseline;
      noChange = true;
    }
  }
  if (!recommendation) return { ok: false, reason: "no-results" };

  const beautyWithinNoise =
    Boolean(beautyPath) && Boolean(fastPath) && compareReal(beautyPath, fastPath) === "noise";

  return {
    ok: true,
    fastPath,
    beautyPath,
    recommendation,
    noChange,
    reasoning: buildReasoning({ fastPath, beautyPath, baseline, noChange, beautyWithinNoise }),
  };
}

/** Write optimal.json for a recommendation (the apply step reads this back). */
export async function writeOptimalJson(runDir, recommendation) {
  const slim = (r) => r
    ? { configId: r.configId, label: r.label, settings: r.settings, summary: r.summary }
    : null;
  const payload = {
    recommendedAt: new Date().toISOString(),
    recommended: slim(recommendation.recommendation),
    fastPath: slim(recommendation.fastPath),
    beautyPath: slim(recommendation.beautyPath),
    noChange: Boolean(recommendation.noChange),
    reasoning: recommendation.reasoning,
  };
  await writeFile(join(runDir, "optimal.json"), JSON.stringify(payload, null, 2) + "\n");
  return payload;
}