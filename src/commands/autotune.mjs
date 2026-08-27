// `minimal-ai autotune [profile]` — the speed-tune wizard (v1).
//
// Flow: ① pre-flight (server up, probe) → ② overview + plan → confirm
// (BEFORE any side effects) → ③ run dir + snapshot + lock → ④ run with live
// per-config progress → ⑤ report (results.md + optimal.json + terminal
// summary) → ⑥⑦ apply (echo-verified PUT) / discard (restore snapshot).
//
// oMLX-only: the sweep drives the oMLX admin API. Policy lives in code; the
// LLM never decides what gets PUT or when to load/unload.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDirs } from "../config.mjs";
import { backendFor } from "../backends.mjs";
import { readProfile, effectiveModelId } from "../profiles.mjs";
import { serverReady, apiRootUrl } from "../process.mjs";
import { offerOmlxRestart, putOmlxModelSettings, omlxSettingsFailureHint, restartOmlxServer } from "../omlx-runtime.mjs";
import { sleep } from "../exec.mjs";
import {
  parseOptions, status, theme, renderList, maxWidth, wrapText, renderTable,
  promptConfirm, padEndVisible, visibleLen,
} from "../ui.mjs";
import { probeOmlxModel, fetchOmlxAdminModels, ensureMtplxImported, needsMtplxImport } from "../autotune/probe.mjs";
import {
  acquireAutotuneLock, createRunDir, snapshotModelSettings,
  restoreSettingsSnapshot, readJournal,
} from "../autotune/safety.mjs";
import { generateGrid, estimateGridMinutes } from "../autotune/grid.mjs";
import { sweepConfig } from "../autotune/sweep.mjs";
import { recommendOptimal, writeOptimalJson, resultsFromJournal } from "../autotune/recommend.mjs";
import { sweepBaseline, groupSweepResults, sweepRowDelta, recommendedId } from "../autotune/report.mjs";
import { planMatrix, resultsMatrix, matrixHeaders } from "../autotune/matrix.mjs";


function fmtTps(median) {
  return median != null ? `${median.toFixed(1)} tps` : "—";
}

function fmtAccept(mtp) {
  return mtp?.acceptPct != null ? `${mtp.acceptPct.toFixed(1)}%` : "—";
}

// ── ① Pre-flight ────────────────────────────────────────────────────────────

/** Probe the model + ensure MTP is available. No lock/snapshot yet — safe to
 *  call for --dry-run. Returns { baseUrl, modelId, model, allModels } or throws. */
async function probeForAutotune(profile, { nonInteractive = false, skipImport = false } = {}) {
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
  // skipped on otherwise-MTP-capable checkpoints). Non-destructive, idempotent
  // — but it IS a server mutation, so --dry-run skips it (its "no settings
  // changed" claim must be true).
  let model = probe.model;
  if (skipImport) {
    if (needsMtplxImport(probe.model)) {
      console.log(theme.subtle("Unimported MTPLX side-car detected — the real sweep imports it first, so an MTP row may appear then."));
    }
  } else {
    const mtp = await ensureMtplxImported(baseUrl, probe.model);
    model = mtp.model;
    if (mtp.attempted) {
      if (mtp.flipped) {
        console.log(status({ kind: "success", message: `Imported MTPLX side-car (${mtp.importResult.merged} MTP tensors) — MTP now available.` }));
      } else {
        console.log(status({ kind: "warning", message: `MTPLX side-car import did not flip MTP compatibility (${mtp.importResult?.reason ?? "re-probe unchanged"}); MTP row will be skipped.` }));
      }
    }
  }

  return { baseUrl, modelId, model, allModels: admin.models };
}

// ── ③ Dry-run plan ───────────────────────────────────────────────────────────

/** Cell styling for the result/plan matrices (matrix.mjs stays plain text). */
function styleCell(cell) {
  switch (cell.kind) {
    case "tick": return theme.success(cell.text);
    case "na": return theme.error(cell.text);
    case "empty": return theme.subtle(cell.text);
    case "value-star": return `${theme.success("★")} ${cell.text}`;
    default: return cell.text;
  }
}

/** Color the fixed state tokens in a matrix header: "off" red (disabled
 *  axis), "on" green (enabled axis), "+budget" green (the bound that
 *  tames thinking). Headers follow a fixed grammar, so token styling is
 *  exact, not heuristic. Exported for tests. */
export function styleMatrixHeader(label) {
  return label
    .replace(/(\+\d+)/gu, (match) => theme.success(match))
    .replace(/\b(off)\b/gu, (match) => theme.error(match))
    .replace(/\b(on)\b/gu, (match) => theme.success(match));
}

/** One KV-quant block of the matrix as a bordered table. */
function renderMatrixBlock(headers, block) {
  return renderTable({
    headers: ["Speculative", ...headers.map(styleMatrixHeader)],
    rows: block.rows.map((row) => [row.label, ...row.cells.map(styleCell)]),
  });
}

const MATRIX_FOOTNOTES = [
  "MTP + DFlash are competing drafters — never stacked (separate rows).",
  "NA on DFlash rows: ANE is a batched-engine prefill feature, and the thinking budget is not enforced on the DFlash path.",
  "– = compatible, unmeasured: ANE + KV-quant run isolated on the vanilla baseline only (full cross-product ≈ 40 runs instead of 8).",
];

/** Numbered footnotes under the matrix, one per line. */
function printFooter() {
  for (const [index, note] of MATRIX_FOOTNOTES.entries()) {
    console.log(theme.subtle(`${index + 1}. ${note}`));
  }
}

function renderPlanMatrix(rows) {
  const headers = matrixHeaders(rows);
  const lines = [];
  for (const block of planMatrix(rows)) {
    lines.push("");
    lines.push(theme.bold(`KV-quant: ${block.kv}`));
    lines.push(renderMatrixBlock(headers, block));
  }
  const total = estimateGridMinutes(rows);
  const testedCount = rows.filter((r) => r.tested).length;
  lines.push("");
  lines.push(theme.subtle(`estimated total ~${total}m across ${testedCount} tested configs`));
  lines.push("");
  return lines.join("\n");
}

// ── ④ Run with live progress ─────────────────────────────────────────────────

async function runSweep({ baseUrl, runDir, modelId, rows }) {
  const tested = rows.filter((r) => r.tested);
  const journal = await readJournal(runDir);
  const done = new Set(journal.filter((r) => r.event === "config-done").map((r) => r.configId));
  const fresh = [];
  const labelW = Math.max(...rows.map((r) => visibleLen(r.label)));
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
      // Abort — do NOT rethrow: an uncaught exception here would skip
      // discardSweep and leave the last PUT config live (H2). The abort
      // branch below restores the snapshotted settings.
      return { aborted: true, reason: "exception", detail: err.message };
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
    console.log(`  ${theme.success("✓")} ${padEndVisible(row.label, labelW)}  ${vs}  accept ${acc}`);
  }
  return { aborted: false, fresh };
}

// ── ⑤ Report ────────────────────────────────────────────────────────────────

function resultsTable(results, recommendation) {
  const headers = matrixHeaders(results);
  const lines = [];
  for (const block of resultsMatrix(results, recommendation)) {
    lines.push("");
    lines.push(theme.bold(`KV-quant: ${block.kv}`));
    lines.push(renderMatrixBlock(headers, block));
  }
  return lines.join("\n");
}

async function writeResultsMd(runDir, { modelId, results, recommendation, runDir: rd }) {
  const baseline = sweepBaseline(results);
  const recId = recommendedId(recommendation);
  const { fast, beauty } = groupSweepResults(results);
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
      const d = sweepRowDelta(r, baseline);
      const delta = d.isBaseline ? "(baseline)"
        : d.pct == null ? "—"
          : `${d.pct >= 0 ? "+" : ""}${d.pct.toFixed(0)}%`;
      const noise = d.noise == null ? "" : d.noise ? "tie" : "real";
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
  const restore = await restoreSettingsSnapshot(baseUrl, runDir);
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
    console.log(status({ kind: "info", message: "Nothing beat the baseline beyond noise — restoring your original settings." }));
    console.log(theme.subtle(`  ${recommendation.reasoning}`));
    await discardSweep(baseUrl, runDir, modelId, baselineSettings);
    return;
  }
  const rec = recommendation.recommendation;
  // The reasoning (the numbers behind the pick) must actually print — the old
  // card primitive silently dropped it when rows were present.
  console.log(theme.bold(`Recommended: ${rec.label}`));
  for (const line of wrapText(recommendation.reasoning, maxWidth() - 2)) {
    console.log(theme.subtle(`  ${line}`));
  }
  if (rec.summary.mtp?.acceptPct != null) {
    console.log(`  MTP accept ${fmtAccept(rec.summary.mtp)}`);
  }

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

  // Fail before framing for the wrong backend; everything else (probe
  // warnings, MTPLX import notes) lands UNDER the title so it has context.
  if (backendFor(profile.backend).id !== "omlx") {
    throw new Error(
      `Autotune is an oMLX workflow (it drives the oMLX admin API). Profile "${profile.id}" uses the ${backendFor(profile.backend).label} backend.`,
    );
  }

  console.log("");
  console.log(theme.bold(`Autotune — ${dryRun ? "dry run" : "speed tune"}: ${profile.label}`));
  console.log("");

  const probed = await probeForAutotune(profile, { nonInteractive, skipImport: dryRun });
  const { baseUrl, modelId, model, allModels } = probed;
  const rows = generateGrid(model, allModels);
  const baselineSettings = rows.find((r) => r.id === "vanilla").settings;

  console.log(renderList([
    ["MTP", model.mtpCompatible ? "compatible" : "not compatible"],
    ["DFlash", model.dflashCompatible ? "compatible" : "not compatible"],
    ["thinking default", String(model.thinkingDefault)],
    ["tested configs", `${rows.filter((r) => r.tested).length}/${rows.length}`],
  ]));
  console.log("");
  console.log(theme.bold("Plan"));
  console.log(renderPlanMatrix(rows));
  printFooter();
  console.log(theme.subtle("✓ will measure · – compatible, not measured · NA not possible · ≈ within 2× noise (MAD)"));
  console.log("");

  // --dry-run: plan only, no sweep, no mutation.
  if (dryRun) {
    console.log(theme.subtle("Dry run — no sweep, no settings changed. Run without --dry-run to sweep."));
    return;
  }

  // ② Confirm BEFORE any side effects — previously the run dir, settings
  // snapshot, and experiment lock were all acquired before this prompt, so
  // the "snapshot captured" line read like the sweep had already started.
  if (!yes) {
    const testedCount = rows.filter((r) => r.tested).length;
    const start = await promptConfirm({
      message: `Start the speed sweep? (~${estimateGridMinutes(rows)}m, ${testedCount} configs)`,
      initialValue: true,
    });
    if (!start) {
      console.log(theme.subtle("Sweep cancelled — nothing changed."));
      return;
    }
  }

  // Run dir + snapshot + lock (only for a confirmed real sweep).
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
    const recommendation = recommendOptimal(results);

    await writeResultsMd(runDir, { modelId, results, recommendation, runDir });
    if (recommendation.ok) await writeOptimalJson(runDir, recommendation);

    console.log("");
    console.log(theme.bold("Speed sweep results"));
    console.log(resultsTable(results, recommendation));
    console.log(theme.subtle("✓ measured · – compatible, not measured · NA not possible · ≈ within 2× noise (MAD)"));
    const fastLabel = recommendation.ok ? recommendation.fastPath?.label : null;
    console.log(theme.subtle(`★ recommended: ${fastLabel ?? "—"} (fastest thinking-off) — thinking-on rates count reasoning tokens as output; the quality call is deferred to v2`));
    printFooter();
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