// Autotune job executor — the CLI wizard's sweep as one hub job: probe →
// grid → snapshot + lock → per-config sweep (safety layer unchanged: one
// model loaded at a time, RAM gate, journal, verified PUTs) → recommendation
// → apply (or discard) → memory reclaim (oMLX restart). The grid/report
// modules are reused as-is; the live matrix rides the job's metrics column.
//
// Cancel: takes effect between configs (each config is one cold load + warm
// runs); the finally block always restores the snapshotted settings so a
// cancelled or failed sweep never leaves the last measured config live.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { backendFor } from "../../backends.mjs";
import { effectiveModelId } from "../../profiles.mjs";
import { serverReady, apiRootUrl } from "../../process.mjs";
import { restartOmlxServer, putOmlxModelSettings } from "../../omlx-runtime.mjs";
import { sleep } from "../../exec.mjs";
import {
  acquireAutotuneLock,
  appendJournal,
  createRunDir,
  restoreSettingsSnapshot,
  readJournal,
  snapshotModelSettings,
} from "../../autotune/safety.mjs";
import { generateGrid, estimateGridMinutes } from "../../autotune/grid.mjs";
import { probeOmlxModel, fetchOmlxAdminModels, ensureMtplxImported } from "../../autotune/probe.mjs";
import { sweepConfig } from "../../autotune/sweep.mjs";
import { recommendOptimal, resultsFromJournal, writeOptimalJson } from "../../autotune/recommend.mjs";

import { BACKENDS } from "../../backends.mjs";
import { baseProfileFor } from "./executors.ts";
import { parseModelRef } from "../api/model-ref.ts";
import type { JobContext } from "./runner.ts";

// ── Probe + plan (shared by the sweep job and the plan endpoint) ────────────

/** Probe the model on the oMLX admin API and derive the sweep grid.
 *  importSidecar: the real sweep merges an MTPLX side-car first (a server
 *  mutation); plan previews pass false so they stay read-only. */
export async function probeForSweep(baseUrl: string, modelId: string, { importSidecar = true } = {}): Promise<{
  model: any;
  allModels: any[];
  rows: any[];
}> {
  if (!(await serverReady(baseUrl))) {
    throw new Error("oMLX server is not running. Start it with `omlx start` and try again.");
  }
  const admin: any = await fetchOmlxAdminModels(baseUrl);
  if (!admin.ok) throw new Error(`could not reach the oMLX admin API (${admin.reason})`);
  const probe: any = await probeOmlxModel(baseUrl, modelId);
  if (!probe.model) throw new Error(`model "${modelId}" is not discovered on the oMLX server — download it first`);
  let model = probe.model;
  if (importSidecar) {
    const mtp = await ensureMtplxImported(baseUrl, model);
    model = mtp.model;
  }
  return { model, allModels: admin.models, rows: generateGrid(model, admin.models) };
}

// ── Settings end-state helpers (mirror the CLI's apply/discard rules) ───────

async function discardSweep(
  ctx: JobContext,
  baseUrl: string,
  runDir: string,
  modelId: string,
  baselineSettings: Record<string, unknown>
): Promise<void> {
  const restore: any = await restoreSettingsSnapshot(baseUrl, runDir);
  if (restore.ok) {
    ctx.log("[hub] original settings restored");
    return;
  }
  if (restore.reason === "no-entry-to-restore") {
    const reset: any = await putOmlxModelSettings(apiRootUrl(baseUrl), modelId, baselineSettings);
    ctx.log(
      reset.ok
        ? "[hub] no prior settings entry — reset to a clean all-off baseline (oMLX has no delete-entry API)"
        : `[hub] baseline reset failed: ${reset.reason}`
    );
    return;
  }
  ctx.log(`[hub] settings restore incomplete: ${restore.reason}`);
}

/** oMLX restart to reclaim process memory the sweep pushed to swap — the
 *  server frees model memory per load/unload, but only a restart returns
 *  the process footprint to baseline. Settings persist across restarts. */
async function reclaimMemory(ctx: JobContext, baseUrl: string): Promise<void> {
  ctx.log("[hub] restarting oMLX to reclaim memory freed by the sweep…");
  const r: any = await restartOmlxServer();
  if (!r.ok) {
    ctx.log(`[hub] could not auto-restart oMLX (${r.reason}) — run \`omlx restart\` to reclaim memory`);
    return;
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await serverReady(baseUrl)) {
      ctx.log("[hub] oMLX restarted — memory reclaimed");
      return;
    }
    await sleep(2000);
  }
  ctx.log("[hub] oMLX restart sent, but the server is slow to come back — it will be ready shortly");
}

export interface AutotuneOptions {
  reclaim?: (ctx: JobContext, baseUrl: string) => Promise<void>; // test seam
  sweep?: (baseUrl: string, runDir: string, modelId: string, row: any, options?: any) => Promise<any>; // test seam
}

export function autotuneExecutor(options: AutotuneOptions = {}) {
  const sweep = options.sweep ?? sweepConfig;
  const reclaim = options.reclaim ?? reclaimMemory;
  return async function autotune(ctx: JobContext) {
    const ref = parseModelRef(ctx.job.ref ?? "");
    if (!ref) throw new Error("autotune job is missing its model ref");
    const { apply = true } = ctx.job.payload as { apply?: boolean };
    const { profile } = await baseProfileFor(ref, false);
    if (!profile) throw new Error("no saved profile for this model — set it up first");
    if (backendFor(profile.backend).id !== "omlx") {
      throw new Error("autotune is an oMLX workflow (it drives the oMLX admin API)");
    }
    const baseUrl = profile.baseUrl;
    const modelId = effectiveModelId(profile);

    ctx.progress(null, "probing the oMLX server");
    const { model, allModels, rows } = await probeForSweep(baseUrl, modelId);
    const tested = rows.filter((r: any) => r.tested);
    const baselineSettings = rows.find((r: any) => r.id === "vanilla").settings;
    ctx.log(
      `[hub] grid: ${tested.length}/${rows.length} configs (~${estimateGridMinutes(rows)}m) — ` +
        `MTP ${model.mtpCompatible ? "compatible" : "off"}, DFlash ${model.dflashCompatible ? "compatible" : "off"}`
    );

    const runDir = await createRunDir(modelId);
    // The plan is part of the durable record: the results DTO reads settings
    // from here (journal rows carry them too, but the plan is the full grid
    // including skipped rows).
    await writeFile(join(runDir, "plan.json"), `${JSON.stringify(rows, null, 2)}\n`);
    const snapshot = await snapshotModelSettings(runDir, modelId);
    const lock: any = await acquireAutotuneLock({ modelId });
    if (!lock.ok) {
      throw new Error(
        `another autotune sweep is already running (pid ${lock.holder?.pid}, model ${lock.holder?.modelId}) — one sweep at a time, the oMLX server has one GPU`
      );
    }
    ctx.log(`[hub] run dir: ${runDir} · snapshot ${snapshot.hadEntry ? "captured" : "no prior entry"}`);

    // The live matrix rides the job's metrics: plan rows first, then each
    // config's summary as it lands. The web merges the two.
    const metrics: Record<string, unknown> = {
      runDir,
      modelId,
      total: tested.length,
      done: 0,
      plan: rows.map((r: any) => ({ id: r.id, label: r.label, family: r.family, settings: r.settings, tested: r.tested })),
      results: [] as unknown[],
    };
    ctx.setMetrics({ ...metrics });

    let sweepRan = false; // reclaim only if the sweep actually touched the server
    let settled = false; // settings reached a final state (applied or discarded)
    try {
      // Resume: skip configs the journal already measured.
      const journal = await readJournal(runDir);
      const doneIds = new Set(journal.filter((r: any) => r.event === "config-done").map((r: any) => r.configId));
      const results = [...(metrics.results as unknown[])];
      let i = 0;
      for (const row of tested) {
        i += 1;
        if (ctx.signal.aborted) break;
        if (doneIds.has(row.id)) continue;
        ctx.progress((100 * (i - 1)) / tested.length, `${row.label} (${i}/${tested.length})`);
        let result: any;
        try {
          result = await sweep(baseUrl, runDir, modelId, row);
        } catch (err) {
          ctx.log(`[hub] ${row.label} failed: ${(err as Error).message}`);
          await discardSweep(ctx, baseUrl, runDir, modelId, baselineSettings);
          settled = true;
          throw new Error(`sweep aborted after exception in ${row.label} — settings restored`);
        }
        sweepRan = true;
        if (!result.ok) {
          ctx.log(`[hub] ${row.label} failed: ${result.reason}`);
          // Non-fatal measurement failure — journal it so the results page
          // shows the config was attempted (and why it has no number). Resume
          // still retries it (only config-done rows are skipped).
          await appendJournal(runDir, { event: "config-failed", configId: row.id, label: row.label, reason: result.reason });
          if (["precheck", "put", "ram-gate"].includes(result.reason)) {
            await discardSweep(ctx, baseUrl, runDir, modelId, baselineSettings);
            settled = true;
            throw new Error(`sweep aborted (${result.reason}) — settings restored`);
          }
          continue; // measurement failure is recorded, not fatal
        }
        results.push({
          configId: result.configId,
          label: result.label,
          family: result.family,
          settings: result.settings,
          summary: result.summary,
        });
        metrics.results = results;
        metrics.done = results.length;
        ctx.setMetrics({ ...metrics });
        ctx.log(
          `[hub] ✓ ${result.label} — ${result.summary.median != null ? `${result.summary.median.toFixed(1)} tps` : "no samples"}` +
            (result.summary.mtp?.acceptPct != null ? ` · accept ${result.summary.mtp.acceptPct.toFixed(1)}%` : "")
        );
        if (ctx.signal.aborted) break;
      }

      if (ctx.signal.aborted) {
        ctx.log("[hub] sweep cancelled — restoring original settings");
        return metrics; // finally block discards
      }

      // Recommendation from the journal (covers resume + partial runs).
      ctx.progress(null, "recommending");
      const finalResults: any[] = resultsFromJournal(await readJournal(runDir), rows);
      const recommendation: any = recommendOptimal(finalResults);
      metrics.recommendation = recommendation.ok
        ? { configId: recommendation.recommendation.configId, label: recommendation.recommendation.label, reasoning: recommendation.reasoning, noChange: recommendation.noChange }
        : null;
      ctx.setMetrics({ ...metrics });
      if (recommendation.ok) await writeOptimalJson(runDir, recommendation);

      if (!recommendation.ok) {
        ctx.log("[hub] no usable measurements — discarding the sweep");
        await discardSweep(ctx, baseUrl, runDir, modelId, baselineSettings);
      } else if (recommendation.noChange) {
        ctx.log("[hub] nothing beat the baseline beyond noise — restoring your original settings");
        await discardSweep(ctx, baseUrl, runDir, modelId, baselineSettings);
      } else if (apply) {
        const rec = recommendation.recommendation;
        const put: any = await putOmlxModelSettings(apiRootUrl(baseUrl), modelId, rec.settings);
        if (put.ok) {
          ctx.log(`[hub] applied ${rec.label} to ${modelId}${put.verified === false ? " (not independently verified)" : ""}`);
        } else {
          ctx.log(`[hub] apply failed (${put.reason}) — discarding the sweep`);
          await discardSweep(ctx, baseUrl, runDir, modelId, baselineSettings);
        }
      } else {
        ctx.log("[hub] apply skipped — restoring your original settings");
        await discardSweep(ctx, baseUrl, runDir, modelId, baselineSettings);
      }
      settled = true;
      metrics.applied = Boolean(apply && recommendation.ok && !recommendation.noChange);
      ctx.progress(null, metrics.applied ? "recommendation applied" : "done");
      return metrics;
    } finally {
      if (!settled) await discardSweep(ctx, baseUrl, runDir, modelId, baselineSettings);
      await lock.release();
      if (sweepRan) await reclaim(ctx, baseUrl);
    }
  };
}

/** Default oMLX base URL for models without a saved profile (plan previews). */
export function omlxDefaultBaseUrl(): string {
  return BACKENDS.omlx.apiBaseUrl;
}