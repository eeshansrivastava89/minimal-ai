// `minimal-ai autotune [profile]` — the speed-tune wizard (v1).
//
// Flow: ① pre-flight (server up, probe, snapshot, lock) → ② mode pick
// (speed-only in v1; quality stubbed) → ③ dry-run plan card → ④ run with
// live per-config progress → ⑤ report (results.md + optimal.json + terminal
// summary) → ⑥⑦ apply (echo-verified PUT) / discard (restore snapshot).
//
// oMLX-only: the sweep drives the oMLX admin API. Policy lives in code; the
// LLM never decides what gets PUT or when to load/unload.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDirs } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { readProfile, effectiveModelId } from "../profiles.mjs";
import { serverReady } from "../server-check.mjs";
import { apiRootUrl } from "../server-status.mjs";
import { offerOmlxRestart, putOmlxModelSettings, omlxSettingsFailureHint, restartOmlxServer } from "../omlx-runtime.mjs";
import { sleep } from "../exec.mjs";
import {
  parseOptions, status, theme, card, maxWidth,
  promptConfirm, padEndVisible,
} from "../ui.mjs";
import { probeOmlxModel, fetchOmlxAdminModels, ensureMtplxImported } from "../autotune/probe.mjs";
import {
  acquireAutotuneLock, createRunDir, snapshotModelSettings,
  restoreSettingsSnapshot, readJournal,
} from "../autotune/safety.mjs";
import { generateGrid, estimateGridMinutes } from "../autotune/grid.mjs";
import { sweepConfig } from "../autotune/sweep.mjs";
import { recommendOptimal, writeOptimalJson, resultsFromJournal, compareReal, isThinkingOn } from "../autotune/recommend.mjs";

const COL_LABEL = 24;
const COL_TPS = 10;
const COL_ACCEPT = 9;

function fmtTps(median) {
  return median != null ? `${median.toFixed(1)} tps` : "—";
}

function fmtAccept(mtp) {
  return mtp?.acceptPct != null ? `${mtp.acceptPct.toFixed(1)}%` : "—";
}

function truncate(value, max) {
  const str = String(value ?? "");
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

// ── ① Pre-flight ────────────────────────────────────────────────────────────

/** Probe the model + ensure MTP is available. No lock/snapshot yet — safe to
 *  call for --dry-run. Returns { baseUrl, modelId, model, allModels } or throws. */
async function probeForAutotune(profile, { nonInteractive = false } = {}) {
  const baseUrl = profile.baseUrl;
  const modelId = effectiveModelId(profile);

  if (backendFor(profile.backend).id !== "omlx") {
    throw new Error(
      `Autotune is an oMLX workflow (it drives the oMLX admin API). Profile "${profile.id}" uses the ${backendFor(profile.backend).label} backend.`,
    );
  }

  // Server up? Offer restart interactively; fail clearly non-interactively.
  if (!(await serverReady(baseUrl))) {
    if (nonInteractive) {
      throw new Error("oMLX server is not running. Start it with `omlx start` and try again.");
    }
    console.log(status({ kind: "warning", message: "oMLX server is not running." }));
    const restarted = await offerOmlxRestart("to run the autotune sweep");
    if (!restarted) throw new Error("oMLX server is not running. Start it with `omlx start` and try again.");
    if (!(await serverReady(baseUrl))) {
      throw new Error("oMLX server still not responding after restart. Try `omlx start` manually.");
    }
  }

  // Probe capabilities + discover drafts.
  const admin = await fetchOmlxAdminModels(baseUrl);
  if (!admin.ok) throw new Error(`Could not reach the oMLX admin API (${admin.reason}).`);
  const probe = await probeOmlxModel(baseUrl, modelId);
  if (!probe.model) {
    throw new Error(
      `Model "${modelId}" is not discovered on the oMLX server. Restart oMLX (omlx restart) or download the model first.`,
    );
  }

  // Auto-import an MTPLX side-car MTP head if the model ships one unimported
  // (oMLX doesn't auto-merge it; without this the MTP grid row would be
  // skipped on otherwise-MTP-capable checkpoints). Non-destructive, idempotent.
  const mtp = await ensureMtplxImported(baseUrl, probe.model);
  const model = mtp.model;
  if (mtp.attempted) {
    if (mtp.flipped) {
      console.log(status({ kind: "success", message: `Imported MTPLX side-car (${mtp.importResult.merged} MTP tensors) — MTP now available.` }));
    } else {
      console.log(status({ kind: "warning", message: `MTPLX side-car import did not flip MTP compatibility (${mtp.importResult?.reason ?? "re-probe unchanged"}); MTP row will be skipped.` }));
    }
  }

  return { baseUrl, modelId, model, allModels: admin.models };
}

// ── ③ Dry-run plan ───────────────────────────────────────────────────────────

function formatGridTable(rows) {
  // card inner width — matches cli-kit's card(): maxWidth() - 4 (borders+padding).
  const inner = maxWidth() - 4;
  const lines = [];
  for (const r of rows) {
    const mark = r.tested ? theme.success("✓") : theme.warning("✗");
    const est = r.tested ? `~${r.estMinutes}m` : "";
    // line layout: label[COL_LABEL] + " " + mark + "  " + note[N] + " " + est
    const noteWidth = Math.max(16, inner - COL_LABEL - 1 - 1 - 2 - 1 - est.length);
    const note = truncate(r.tested ? r.notes : r.skipReason, noteWidth);
    lines.push(
      `${padEndVisible(r.label, COL_LABEL)} ${mark}  ${padEndVisible(note, noteWidth)} ${est}`,
    );
  }
  const total = estimateGridMinutes(rows);
  lines.push("");
  lines.push(theme.subtle(`${" ".repeat(COL_LABEL + 4)}total est. ~${total}m (tested configs only)`));
  return lines.join("\n");
}

// ── ④ Run with live progress ─────────────────────────────────────────────────

async function runSweep({ baseUrl, runDir, modelId, rows }) {
  const tested = rows.filter((r) => r.tested);
  const journal = await readJournal(runDir);
  const done = new Set(journal.filter((r) => r.event === "config-done").map((r) => r.configId));
  const fresh = [];
  let i = 0;
  for (const row of tested) {
    i += 1;
    if (done.has(row.id)) {
      console.log(theme.subtle(`  ✓ ${row.label} — already measured (resumed)`));
      continue;
    }
    // One dim "measuring" line, then one result line — no duplicated label.
    // The start line carries the index + estimate; the result line carries
    // the tps. (Replaces withSpinner, which printed the full label twice.)
    console.log(theme.subtle(`  → ${i}/${tested.length} ${row.label} (est ~${row.estMinutes}m)…`));
    let result;
    try {
      result = await sweepConfig(baseUrl, runDir, modelId, row);
    } catch (err) {
      console.log(status({ kind: "error", message: `  ${row.label} failed: ${err.message}` }));
      throw err;
    }
    if (!result.ok) {
      console.log(status({ kind: "error", message: `  ${row.label} failed: ${result.reason}` }));
      if (["precheck", "put", "ram-gate"].includes(result.reason)) {
        return { aborted: true, reason: result.reason, detail: result.detail };
      }
      // A measurement failure (cold-run/warm) is recorded but non-fatal.
      continue;
    }
    fresh.push(result);
    const vs = result.summary.median != null ? fmtTps(result.summary.median) : "—";
    const acc = fmtAccept(result.summary.mtp);
    console.log(`  ${theme.success("✓")} ${padEndVisible(row.label, COL_LABEL)} ${padEndVisible(vs, COL_TPS)}  accept ${acc}`);
  }
  return { aborted: false, fresh };
}

// ── ⑤ Report ────────────────────────────────────────────────────────────────

function resultRow(r, baseline, recId) {
  const med = fmtTps(r.summary.median);
  const acc = fmtAccept(r.summary.mtp);
  let delta = "—";
  if (r.configId === "vanilla") {
    delta = "(baseline)";
  } else if (baseline && baseline.summary.median && r.summary.median) {
    const pct = ((r.summary.median - baseline.summary.median) / baseline.summary.median) * 100;
    const sign = pct >= 0 ? "+" : "";
    const real = compareReal(r, baseline);
    delta = real === "noise" ? `${sign}${pct.toFixed(0)}%  ≈ tie` : `${sign}${pct.toFixed(0)}%`;
  }
  const isRec = r.configId === recId;
  const prefix = isRec ? `${theme.success("★")} ` : "  ";
  const label = isRec ? theme.bold(r.label) : r.label;
  return `${prefix}${padEndVisible(label, COL_LABEL)} ${padEndVisible(med, COL_TPS)} ${padEndVisible(acc, COL_ACCEPT)} ${delta}`;
}

function resultsTable(results, baseline, recommendation) {
  // Group by path so the recommendation (fastest thinking-off) is
  // self-evident, instead of the beauty path ranking first by raw tps.
  const recId = recommendation?.ok ? recommendation.recommendation.configId : null;
  const fast = results.filter((r) => !isThinkingOn(r)).sort((a, b) => b.summary.median - a.summary.median);
  const beauty = results.filter(isThinkingOn).sort((a, b) => b.summary.median - a.summary.median);
  const lines = [];
  if (fast.length) {
    lines.push(theme.bold("fast path — thinking off (raw output speed)"));
    for (const r of fast) lines.push(resultRow(r, baseline, recId));
  }
  if (beauty.length) {
    if (fast.length) lines.push("");
    lines.push(theme.bold("beauty path — thinking on (includes reasoning tokens)"));
    for (const r of beauty) lines.push(resultRow(r, baseline, recId));
  }
  return lines.join("\n");
}

async function writeResultsMd(runDir, { modelId, results, recommendation, runDir: rd }) {
  const baseline = results.find((r) => r.configId === "vanilla");
  const recId = recommendation?.ok ? recommendation.recommendation.configId : null;
  const fast = results.filter((r) => !isThinkingOn(r)).sort((a, b) => b.summary.median - a.summary.median);
  const beauty = results.filter(isThinkingOn).sort((a, b) => b.summary.median - a.summary.median);
  const lines = [];
  lines.push(`# Autotune report — ${modelId}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Run dir: ${rd}`);
  lines.push("");
  lines.push("## Speed sweep");
  lines.push("");
  const writeGroup = (heading, group) => {
    if (!group.length) return;
    lines.push(`### ${heading}`);
    lines.push("");
    lines.push("| config | median tps | accept | vs vanilla | noise | rec |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of group) {
      const med = r.summary.median != null ? r.summary.median.toFixed(2) : "—";
      const acc = r.summary.mtp?.acceptPct != null ? `${r.summary.mtp.acceptPct.toFixed(1)}%` : "—";
      let delta = "—";
      let noise = "";
      if (r.configId === "vanilla") {
        delta = "(baseline)";
      } else if (baseline && baseline.summary.median && r.summary.median) {
        const pct = ((r.summary.median - baseline.summary.median) / baseline.summary.median) * 100;
        const sign = pct >= 0 ? "+" : "";
        delta = `${sign}${pct.toFixed(0)}%`;
        noise = compareReal(r, baseline) === "noise" ? "tie" : "real";
      }
      const rec = r.configId === recId ? "★" : "";
      lines.push(`| ${r.label} | ${med} | ${acc} | ${delta} | ${noise} | ${rec} |`);
    }
    lines.push("");
  };
  writeGroup("Fast path — thinking off (raw output speed)", fast);
  writeGroup("Beauty path — thinking on (includes reasoning tokens)", beauty);
  lines.push("≈ tie = difference inside 2× the within-config noise (MAD); not a real difference. ★ = recommended.");
  lines.push("");
  if (recommendation.ok) {
    lines.push("## Recommendation");
    lines.push("");
    lines.push(recommendation.reasoning);
    lines.push("");
    const s = JSON.stringify(recommendation.recommendation.settings, null, 2);
    lines.push("```json");
    lines.push(s);
    lines.push("```");
  } else {
    lines.push("## Recommendation");
    lines.push("");
    lines.push("No usable measurements — sweep did not produce a median tps for any config.");
  }
  await writeFile(join(runDir, "results.md"), lines.join("\n") + "\n");
}

// ── ⑥⑦ Apply / Discard ──────────────────────────────────────────────────────

/**
 * Discard the sweep's settings changes. If the model had a prior settings
 * entry, restore it exactly. If it had none (oMLX has no delete-entry API),
 * reset to the clean all-off vanilla baseline — the closest honest
 * approximation of "revert to pre-sweep" for a model the sweep created an
 * entry for. Used at every post-sweep discard site.
 */
async function discardSweep(baseUrl, runDir, modelId, baselineSettings) {
  const restore = await restoreSettingsSnapshot(apiRootUrl(baseUrl), runDir);
  if (restore.ok) {
    console.log(status({ kind: "success", message: "Original settings restored." }));
    return;
  }
  if (restore.reason === "no-entry-to-restore") {
    const reset = await putOmlxModelSettings(apiRootUrl(baseUrl), modelId, baselineSettings);
    if (reset.ok) {
      console.log(status({ kind: "success", message: "No prior settings entry — reset to a clean all-off baseline (oMLX has no delete-entry API)." }));
    } else {
      console.log(status({ kind: "warning", message: `Could not reset to baseline: ${omlxSettingsFailureHint(reset)}` }));
    }
    return;
  }
  console.log(status({ kind: "warning", message: `Restore incomplete: ${restore.reason}` }));
}

async function applyOrDiscard({ baseUrl, runDir, modelId, recommendation, baselineSettings, autoApply = false }) {
  if (!recommendation.ok) {
    console.log(status({ kind: "warning", message: "No recommendation to apply. Discarding the sweep." }));
    await discardSweep(baseUrl, runDir, modelId, baselineSettings);
    return;
  }
  // No config beat the clean baseline beyond noise — don't dress up a tie as
  // a win. Restore the user's prior settings and say so.
  if (recommendation.noChange) {
    console.log(card({ title: "Recommendation", tone: "accent", body: recommendation.reasoning }));
    console.log(status({ kind: "info", message: "Nothing beat the baseline beyond noise — restoring your original settings." }));
    await discardSweep(baseUrl, runDir, modelId, baselineSettings);
    return;
  }
  const rec = recommendation.recommendation;
  console.log(card({
    title: "Recommended",
    tone: "accent",
    body: recommendation.reasoning,
    rows: [
      ["config", rec.label],
      ["median tps", fmtTps(rec.summary.median)],
      ...(rec.summary.mtp?.acceptPct != null ? [["MTP accept", fmtAccept(rec.summary.mtp)]] : []),
    ],
  }));

  const apply = autoApply || await promptConfirm({ message: `Apply ${rec.label}?`, initialValue: true });
  if (apply) {
    const result = await putOmlxModelSettings(apiRootUrl(baseUrl), modelId, rec.settings);
    if (result.ok) {
      const verb = result.verified === false ? "Applied (not independently verified)" : "Verified";
      console.log(status({ kind: "success", message: `${verb}: ${rec.label} applied to ${modelId}.` }));
    } else {
      console.log(status({ kind: "error", message: `Apply failed: ${omlxSettingsFailureHint(result)}` }));
      console.log(status({ kind: "warning", message: "Discarding the sweep." }));
      await discardSweep(baseUrl, runDir, modelId, baselineSettings);
    }
  } else {
    console.log(status({ kind: "info", message: "Discarding — restoring your original settings." }));
    await discardSweep(baseUrl, runDir, modelId, baselineSettings);
  }
}

// ── Reclaim: restart oMLX after a sweep to free process memory ────────────────
//
// oMLX frees model memory per load/unload (the one-model invariant holds),
// but the server *process* grows over a sweep — macOS pushes its cold pages to
// swap and they aren't returned. Only a restart drops the footprint back to
// baseline. Applied settings persist to ~/.omlx/model_settings.json, so the
// recommendation survives the restart.

async function waitForServerReady(baseUrl, { timeoutMs = 60000, pollMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serverReady(baseUrl)) return true;
    await sleep(pollMs);
  }
  return false;
}

async function reclaimSweepMemory(baseUrl, { nonInteractive }) {
  if (nonInteractive) {
    console.log(status({ kind: "info", message: "Restarting oMLX to reclaim memory freed by the sweep…" }));
    const r = await restartOmlxServer();
    if (!r.ok) {
      console.log(status({ kind: "warning", message: `Could not auto-restart oMLX (${r.reason}). Run \`omlx restart\` to reclaim memory.` }));
      return;
    }
    const ready = await waitForServerReady(baseUrl);
    console.log(ready
      ? status({ kind: "success", message: "oMLX restarted — memory reclaimed." })
      : status({ kind: "warning", message: "oMLX restart sent, but the server is slow to come back. It will be ready shortly." }));
    return;
  }
  // Interactive: offer (default yes) — the user may skip if a session is running.
  const restarted = await offerOmlxRestart("to reclaim memory freed by the sweep (the server process grows over a sweep)");
  if (!restarted) {
    console.log(theme.subtle("The oMLX server process may hold GB of swap from the sweep. Run `omlx restart` later to reclaim it."));
    return;
  }
  const ready = await waitForServerReady(baseUrl);
  if (ready) console.log(status({ kind: "success", message: "oMLX restarted — memory reclaimed." }));
}

// ── Command entry point ──────────────────────────────────────────────────────

export async function autotuneCommand(argv) {
  await ensureDirs();
  const { positional, options } = parseOptions(argv);
  if (!positional[0]) {
    throw new Error("Specify a profile: minimal-ai autotune <profile-id> [--yes | --dry-run]");
  }
  const yes = Boolean(options.yes || options.y);
  const dryRun = Boolean(options["dry-run"]);
  const nonInteractive = yes || dryRun;
  if (!nonInteractive && !process.stdin.isTTY) {
    throw new Error(
      "autotune is interactive. Run from a terminal, or pass --yes (run non-interactively and apply the recommendation) or --dry-run (preview the plan without sweeping).",
    );
  }
  const profile = await readProfile(positional[0]);

  const probed = await probeForAutotune(profile, { nonInteractive });
  const { baseUrl, modelId, model, allModels } = probed;
  const rows = generateGrid(model, allModels);
  const baselineSettings = rows.find((r) => r.id === "vanilla").settings;

  console.log(card({
    title: dryRun ? "Autotune — dry run" : "Autotune — speed tune",
    tone: "accent",
    body: `Model: ${modelId}`,
    rows: [
      ["MTP", model.mtpCompatible ? "compatible" : "not compatible"],
      ["DFlash", model.dflashCompatible ? "compatible" : "not compatible"],
      ["thinking default", String(model.thinkingDefault)],
      ["tested configs", `${rows.filter((r) => r.tested).length}/${rows.length}`],
      ["est. total", `~${estimateGridMinutes(rows)}m`],
    ],
  }));
  console.log("");
  console.log(card({ title: "Dry-run plan", tone: "accent", body: formatGridTable(rows) }));

  // --dry-run: plan only, no sweep, no mutation.
  if (dryRun) {
    console.log(theme.subtle("Dry run — no sweep, no settings changed. Run without --dry-run to sweep."));
    return;
  }

  // Run dir + snapshot + lock (only for a real sweep).
  const runDir = await createRunDir(modelId);
  const snapshot = await snapshotModelSettings(runDir, modelId);
  const lock = await acquireAutotuneLock({ modelId });
  if (!lock.ok) {
    throw new Error(
      `Another autotune sweep is already running (pid ${lock.holder?.pid}, model ${lock.holder?.modelId}). One sweep at a time — the oMLX server has one GPU.`,
    );
  }
  console.log("");
  console.log(theme.subtle(`Run dir: ${runDir} · snapshot ${snapshot.hadEntry ? "captured (restores on discard)" : "no prior entry (resets to baseline on discard)"}`));

  let sweepRan = false;
  try {
    // ② Confirm the sweep. v1 is speed-only; the quality tune is v2 (#20),
    // so there is no mode pick — one confirm after the plan, with room to breathe.
    if (!yes) {
      const testedCount = rows.filter((r) => r.tested).length;
      const start = await promptConfirm({
        message: `Start the speed sweep? (~${estimateGridMinutes(rows)}m, ${testedCount} configs)`,
        initialValue: true,
      });
      if (!start) {
        console.log(theme.subtle("Sweep cancelled. Restoring your original settings."));
        await restoreSettingsSnapshot(apiRootUrl(baseUrl), runDir);
        return;
      }
    }

    // ④ Run.
    const sweep = await runSweep({ baseUrl, runDir, modelId, rows });
    sweepRan = true;
    if (sweep.aborted) {
      console.log(status({ kind: "error", message: `Sweep aborted (${sweep.reason}). Discarding the sweep.` }));
      await discardSweep(baseUrl, runDir, modelId, baselineSettings);
      return;
    }

    // ⑤ Report — read the full result set from the journal (covers resume).
    const journal = await readJournal(runDir);
    const results = resultsFromJournal(journal, rows);
    const baseline = results.find((r) => r.configId === "vanilla");
    const recommendation = recommendOptimal(results);

    await writeResultsMd(runDir, { modelId, results, recommendation, runDir });
    if (recommendation.ok) await writeOptimalJson(runDir, recommendation);

    console.log("");
    console.log(card({
      title: "Speed sweep results",
      tone: "accent",
      body: resultsTable(results, baseline, recommendation),
    }));
    console.log(theme.subtle("  ≈ = within 2× noise (MAD); not a real difference.  ★ = recommended (fastest thinking-off config)."));
    console.log(theme.subtle(`  Full report: ${join(runDir, "results.md")}`));
    console.log("");

    // ⑥⑦ Apply / discard.
    await applyOrDiscard({ baseUrl, runDir, modelId, recommendation, baselineSettings, autoApply: yes });
  } finally {
    await lock.release();
    // A sweep loaded/unloaded models repeatedly — oMLX freed the model memory
    // each cycle, but the server process holds swap that only a restart
    // returns. Reclaim it (skip if the sweep never ran, e.g. cancelled).
    if (sweepRan) await reclaimSweepMemory(baseUrl, { nonInteractive: yes });
  }
}

/**
 * Post-setup hook: after a new oMLX profile is created, offer to autotune it
 * now. Non-intrusive — defaults to no (it's a ~30-60m commitment) and prints
 * the command to run later. No-op for non-oMLX backends or non-TTY runs.
 */
export async function offerAutotuneAfterSetup(profile) {
  if (backendFor(profile.backend).id !== "omlx") return;
  if (!process.stdin.isTTY) return;
  const run = await promptConfirm({
    message: `Autotune ${profile.id} now? Finds the fastest oMLX settings (~30-60m).`,
    initialValue: false,
  });
  if (!run) {
    console.log(theme.subtle(`Later: minimal-ai autotune ${profile.id}`));
    return;
  }
  await autotuneCommand([profile.id]);
}