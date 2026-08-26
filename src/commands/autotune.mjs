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
import { offerOmlxRestart, putOmlxModelSettings, omlxSettingsFailureHint } from "../omlx-runtime.mjs";
import {
  parseOptions, status, theme, card,
  promptChoice, promptConfirm, withSpinner, padEndVisible,
} from "../ui.mjs";
import { probeOmlxModel, fetchOmlxAdminModels, ensureMtplxImported } from "../autotune/probe.mjs";
import {
  acquireAutotuneLock, createRunDir, snapshotModelSettings,
  restoreSettingsSnapshot, readJournal,
} from "../autotune/safety.mjs";
import { generateGrid, estimateGridMinutes } from "../autotune/grid.mjs";
import { sweepConfig } from "../autotune/sweep.mjs";
import { recommendOptimal, writeOptimalJson, resultsFromJournal, compareReal } from "../autotune/recommend.mjs";

const COL_LABEL = 22;
const COL_TPS = 10;
const COL_ACCEPT = 9;
const COL_DELTA = 10;

function fmtTps(median) {
  return median != null ? `${median.toFixed(1)} tps` : "—";
}

function fmtAccept(mtp) {
  return mtp?.acceptPct != null ? `${mtp.acceptPct.toFixed(1)}%` : "—";
}

// ── ① Pre-flight ────────────────────────────────────────────────────────────

async function preflight(profile) {
  const baseUrl = profile.baseUrl;
  const modelId = effectiveModelId(profile);

  if (backendFor(profile.backend).id !== "omlx") {
    throw new Error(
      `Autotune is an oMLX workflow (it drives the oMLX admin API). Profile "${profile.id}" uses the ${backendFor(profile.backend).label} backend.`,
    );
  }

  // Server up? Offer restart if not.
  if (!(await serverReady(baseUrl))) {
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

  // Run dir + snapshot + lock.
  const runDir = await createRunDir(modelId);
  const snapshot = await snapshotModelSettings(runDir, modelId);
  const lock = await acquireAutotuneLock({ modelId });
  if (!lock.ok) {
    throw new Error(
      `Another autotune sweep is already running (pid ${lock.holder?.pid}, model ${lock.holder?.modelId}). One sweep at a time — the oMLX server has one GPU.`,
    );
  }

  return { baseUrl, modelId, model, allModels: admin.models, runDir, snapshot, release: lock.release };
}

// ── ③ Dry-run plan ───────────────────────────────────────────────────────────

function formatGridTable(rows) {
  const lines = [];
  for (const r of rows) {
    const mark = r.tested ? `${theme.success("✓")}` : `${theme.warning("✗")}`;
    const note = r.tested ? r.notes : r.skipReason;
    const est = r.tested ? `~${r.estMinutes}m` : "";
    lines.push(
      `${padEndVisible(r.label, COL_LABEL)} ${mark}  ${padEndVisible(note ?? "", 34)} ${est}`,
    );
  }
  const total = estimateGridMinutes(rows);
  lines.push("");
  lines.push(theme.subtle(`${" ".repeat(COL_LABEL)} total est. ~${total}m (tested configs only)`));
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
    const result = await withSpinner(
      `config ${i}/${tested.length} · ${row.label} (est ~${row.estMinutes}m)`,
      () => sweepConfig(baseUrl, runDir, modelId, row),
    );
    if (!result.ok) {
      console.log(status({ kind: "error", message: `  ${row.label} failed: ${result.reason}`}));
      if (["precheck", "put", "ram-gate"].includes(result.reason)) {
        return { aborted: true, reason: result.reason, detail: result.detail };
      }
      // A measurement failure (cold-run/warm) is recorded but non-fatal.
      continue;
    }
    fresh.push(result);
    const vs = result.summary.median != null ? `→ ${fmtTps(result.summary.median)}` : "";
    const acc = fmtAccept(result.summary.mtp);
    console.log(`  ${theme.success("✓")} ${padEndVisible(row.label, COL_LABEL)} ${padEndVisible(vs, COL_TPS + 2)} accept ${acc}`);
  }
  return { aborted: false, fresh };
}

// ── ⑤ Report ────────────────────────────────────────────────────────────────

function resultsTable(results, baseline) {
  const lines = [];
  for (const r of results) {
    const med = fmtTps(r.summary.median);
    const acc = fmtAccept(r.summary.mtp);
    let delta = "—";
    if (baseline && r.configId !== "vanilla" && baseline.summary.median && r.summary.median) {
      const pct = ((r.summary.median - baseline.summary.median) / baseline.summary.median) * 100;
      const sign = pct >= 0 ? "+" : "";
      const real = compareReal(r, baseline);
      const flag = real === "noise" ? " †" : "";
      delta = `${sign}${pct.toFixed(0)}%${flag}`;
    }
    lines.push(
      `${padEndVisible(r.label, COL_LABEL)} ${padEndVisible(med, COL_TPS)} ${padEndVisible(acc, COL_ACCEPT)} ${padEndVisible(delta, COL_DELTA)}`,
    );
  }
  return lines.join("\n");
}

async function writeResultsMd(runDir, { modelId, results, recommendation, runDir: rd }) {
  const baseline = results.find((r) => r.configId === "vanilla");
  const lines = [];
  lines.push(`# Autotune report — ${modelId}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Run dir: ${rd}`);
  lines.push("");
  lines.push("## Speed sweep");
  lines.push("");
  lines.push("| config | median tps | accept | vs vanilla | noise |");
  lines.push("|---|---|---|---|---|");
  for (const r of results) {
    const med = r.summary.median != null ? r.summary.median.toFixed(2) : "—";
    const acc = r.summary.mtp?.acceptPct != null ? `${r.summary.mtp.acceptPct.toFixed(1)}%` : "—";
    let delta = "—";
    let noise = "";
    if (baseline && r.configId !== "vanilla" && baseline.summary.median && r.summary.median) {
      const pct = ((r.summary.median - baseline.summary.median) / baseline.summary.median) * 100;
      const sign = pct >= 0 ? "+" : "";
      delta = `${sign}${pct.toFixed(0)}%`;
      noise = compareReal(r, baseline) === "noise" ? "noise" : "real";
    }
    lines.push(`| ${r.label} | ${med} | ${acc} | ${delta} | ${noise} |`);
  }
  lines.push("");
  lines.push("† = difference inside 2× the within-config noise (MAD); treat as a tie.");
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

async function applyOrDiscard({ baseUrl, runDir, modelId, recommendation, baselineSettings }) {
  if (!recommendation.ok) {
    console.log(status({ kind: "warning", message: "No recommendation to apply. Discarding the sweep." }));
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

  const apply = await promptConfirm({ message: "Apply these settings?", initialValue: true });
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

// ── Command entry point ──────────────────────────────────────────────────────

export async function autotuneCommand(argv) {
  await ensureDirs();
  const { positional } = parseOptions(argv);
  if (!positional[0]) throw new Error("Specify a profile: minimal-ai autotune <profile-id>");
  const profile = await readProfile(positional[0]);

  const pre = await preflight(profile);
  const { baseUrl, modelId, model, allModels, runDir, release } = pre;

  try {
    console.log(card({
      title: "Autotune — speed tune",
      tone: "accent",
      body: `Model: ${modelId}\nRun dir: ${runDir}`,
      rows: [
        ["MTP", model.mtpCompatible ? "compatible" : "not compatible"],
        ["DFlash", model.dflashCompatible ? "compatible" : "not compatible"],
        ["thinking default", String(model.thinkingDefault)],
        ["snapshot", pre.snapshot.hadEntry ? "captured (will restore on discard)" : "no prior entry"],
      ],
    }));

    // ② Mode pick — speed-only in v1; quality stubbed.
    const mode = await promptChoice({
      message: "Tune mode",
      choices: [
        { value: "speed", label: "Speed tune", hint: "~30-60 min" },
        { value: "quality", label: "Speed + quality tune", hint: "coming in v2", disabled: true },
      ],
      defaultValue: "speed",
    });
    if (mode === "quality") {
      console.log(status({ kind: "info", message: "Quality tune arrives in v2. Running speed tune." }));
    }

    // ③ Dry-run plan.
    const rows = generateGrid(model, allModels);
    const baselineSettings = rows.find((r) => r.id === "vanilla").settings;
    console.log(card({ title: "Dry-run plan", tone: "accent", body: formatGridTable(rows) }));
    const start = await promptConfirm({ message: "Start the sweep?", initialValue: true });
    if (!start) {
      console.log(theme.subtle("Sweep cancelled. Restoring your original settings."));
      await restoreSettingsSnapshot(apiRootUrl(baseUrl), runDir);
      return;
    }

    // ④ Run.
    const sweep = await runSweep({ baseUrl, runDir, modelId, rows });
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
      body: resultsTable(results, baseline),
    }));
    console.log(theme.subtle("  † = inside 2× noise (MAD); treat as a tie."));

    // ⑥⑦ Apply / discard.
    await applyOrDiscard({ baseUrl, runDir, modelId, recommendation, baselineSettings });
  } finally {
    await release();
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