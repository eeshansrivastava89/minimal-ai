// Job executors — download, setup. Each takes a JobContext and
// returns metrics (stored in the job row's nullable metrics JSON column).
// They reuse the service layer as-is: files stay the source of truth, the
// hub is the only driver.

import {
  assertSafeHfFilename,
  getHfTree,
  hasHfCli,
  installHfCli,
  listGgufFiles,
  listMmprojFiles,
  resolveHfDownload,
} from "../../huggingface.mjs";
import { getFreeDiskBytes } from "../../hardware.mjs";
import { formatBytes } from "../../ui.mjs";
import { HF_HUB_DIR } from "../../config.mjs";
import { createProfileFromModel, effectiveModelId, touchProfile } from "../../profiles.mjs";
import { createManagedProfile } from "../../model-catalog.mjs";
import { scanGgufModels, matchDrafter } from "../../scan.mjs";
import {
  applyRuntimeFlagOverrides,
  applyMtpDefaults,
  removeMtpDefaults,
  applyVisionDefaults,
  removeVisionDefaults,
  applyThinkingDefaults,
  removeThinkingDefaults,
} from "../../profile-flags.mjs";
import { configuredHarness, harnessFor } from "../../harnesses.mjs";
import { applyProfileSettingsToOmlx } from "../../managed-backends.mjs";
import { stopOrUnload } from "../../process.mjs";

import { allBenchmarks, catalog, chatApiFor, profileMatchesModel } from "../api/data.ts";
import { parseModelRef, type ModelRef } from "../api/model-ref.ts";
import type { JobContext } from "./runner.ts";
import { backendFor } from "../../backends.mjs";
import {
  modelAvailableOnServer,
  preflightInference,
  serverMatchesProfile,
  serverReady,
  startServer,
  waitForReady,
} from "../../process.mjs";

/** Bring a model fully up: backend server (if needed) + the model loaded
 *  + a preflight token (so "running" means genuinely ready, not just
 *  "server listening"). Shared by the start job and benchmark launches —
 *  the hub owns the lifecycle either way. Also bumps lastUsedAt. */
export async function ensureModelRunning(ctx: JobContext, profile: any): Promise<void> {
  const backend = backendFor(profile.backend);
  const managed = backend.type === "managed-server";
  if (managed) {
    if (!(await serverReady(profile.baseUrl))) {
      ctx.log(`[hub] starting ${backend.label}…`);
      await startServer(profile);
    }
    const available = await modelAvailableOnServer(profile);
    if (available === null) throw new Error(`couldn't reach ${backend.label} at ${profile.baseUrl} to confirm the model is available`);
    if (!available) throw new Error(`${profile.modelAlias} is not available on ${backend.label}`);
  } else {
    if (await serverReady(profile.baseUrl)) {
      const match = await serverMatchesProfile(profile);
      if (!match.matches) throw new Error(`a different server is already responding at ${profile.baseUrl} — ${match.reason}`);
      ctx.log(`[hub] reusing server at ${profile.baseUrl}`);
    } else {
      ctx.log("[hub] starting llama-server…");
      const state = await startServer(profile);
      ctx.progress(null, "waiting for the server");
      await waitForReady(profile, state?.pid, (state as { rawLogPath?: string } | null)?.rawLogPath);
    }
  }

  ctx.progress(null, "preflight inference test");
  const preflight = await preflightInference(profile);
  if (!preflight.ok) {
    try {
      await stopOrUnload(profile);
    } catch {
      /* best effort */
    }
    throw new Error(`model failed to generate a test token: ${preflight.error}`);
  }
  ctx.log("[hub] preflight ok — model loaded");
  // The model ran — bump lastUsedAt so the models table's recency sort and
  // the dashboard's recent list have real data.
  await touchProfile(profile.id);
}

// ── start (bring the model up and leave it running) ──────────────────────

export async function startExecutor(ctx: JobContext) {
  const ref = parseModelRef(ctx.job.ref ?? "");
  if (!ref) throw new Error("start job is missing its model ref");
  const { profile } = await baseProfileFor(ref, false);
  if (!profile) throw new Error("no saved profile for this model — set it up first");
  ctx.log(`[hub] starting ${profile.label} (${backendFor(profile.backend).label})`);
  await ensureModelRunning(ctx, profile);
  const api = chatApiFor(profile);
  ctx.progress(null, "model ready");
  ctx.log(`[hub] model ready — chat API at ${api.baseUrl} (model "${api.model}")`);
  return api;
}

// ── download ───────────────────────────────────────────────────────────────

export async function downloadExecutor(ctx: JobContext) {
  const { repo, filename } = ctx.job.payload as { repo: string; filename?: string | null };
  ctx.progress(null, "fetching repo info");
  const tree = await getHfTree(repo); // throws a clear error on bad repo

  let file = filename ?? null;
  if (!file) {
    const ggufs = await listGgufFiles(repo, { tree });
    if (ggufs.length === 0) file = null; // full-repo download (non-GGUF)
    else if (ggufs.length === 1) file = ggufs[0].path;
    else throw new Error(`${ggufs.length} GGUF files in ${repo} — pick one (quant) first`);
  }

  const downloadRef = file ? `${repo}/${file}` : repo;
  const plan = await resolveHfDownload(downloadRef, { tree });

  // Vision projector rides along automatically (same rule as the CLI);
  // the MTP drafter offer is interactive in the CLI and lands in a later
  // phase here — drafters can still be downloaded by naming the file.
  let extraFiles: string[] = [];
  if (plan.format === "gguf") {
    const mmprojs = await listMmprojFiles(repo, { tree }).catch((err) => {
      ctx.log(`[hub] warning: could not list vision projectors (${(err as Error).message}) — skipping the auto-download`);
      return [];
    });
    if (mmprojs.length > 0) extraFiles.push(mmprojs[0].path);
  }

  const freeBytes = getFreeDiskBytes(HF_HUB_DIR);
  if (plan.totalSizeBytes > 0 && freeBytes < plan.totalSizeBytes * 1.1) {
    throw new Error(`not enough disk space: need ~${formatBytes(plan.totalSizeBytes)}, only ${formatBytes(freeBytes)} free`);
  }

  if (!(await hasHfCli())) {
    ctx.log("[hub] installing HuggingFace CLI…");
    const ok = await installHfCli();
    if (!ok) throw new Error("HuggingFace CLI is required — install with: pip3 install huggingface_hub");
  }

  ctx.progress(null, `downloading ${downloadRef}`);
  ctx.log(`[hub] hf download ${downloadRef} → HF cache (${formatBytes(plan.totalSizeBytes)})`);
  const argv = ["download", repo];
  if (plan.format === "gguf" && plan.files[0]) {
    assertSafeHfFilename(plan.files[0].filename);
    for (const f of extraFiles) assertSafeHfFilename(f);
    argv.push(plan.files[0].filename, "--cache-dir", HF_HUB_DIR, ...extraFiles);
  } else {
    argv.push("--cache-dir", HF_HUB_DIR);
  }
  const result = await ctx.spawnOwned("hf", argv);
  if (result.code !== 0) throw new Error(`hf download exited with code ${result.code}`);

  ctx.log("[hub] download complete — the model appears in the llama.cpp bucket after a rescan");
  return { exitCode: result.code, durationMs: result.durationMs, repo, file, sizeBytes: plan.totalSizeBytes };
}

// ── setup ───────────────────────────────────────────────────────────────────

/** Find the existing profile for a model ref, or create the fresh one the
 *  CLI flows would start from (facts detected, defaults applied). */
export async function baseProfileFor(ref: ModelRef, create: boolean): Promise<{ profile: any; created: boolean }> {
  const { models, profiles } = await catalog();
  const existing = profiles.find((p) => profileMatchesModel(p, ref.backend, ref.id));
  if (existing || !create) return { profile: existing ?? null, created: false };
  if (ref.backend === "llama-cpp") {
    const { models: ggufs, drafters } = await scanGgufModels();
    const g = ggufs.find((m) => m.path === ref.id);
    if (!g) return { profile: null, created: false };
    const drafter = matchDrafter(g.path, drafters);
    return { profile: createProfileFromModel(g, "llama-cpp", drafter?.path ?? null), created: true };
  }
  const m = models.find((x) => x.backend === ref.backend && x.id === ref.id);
  if (!m) return { profile: null, created: false };
  return {
    profile: createManagedProfile(
      { id: m.id, label: m.title, aliasSuggestion: m.id, sizeBytes: m.sizeBytes ?? 0, contextLength: m.contextLength },
      ref.backend
    ),
    created: true,
  };
}

export async function setupExecutor(ctx: JobContext) {
  const ref = parseModelRef(ctx.job.ref ?? "");
  if (!ref) throw new Error("setup job is missing its model ref");
  const form = ctx.job.payload as Record<string, unknown>;
  const { profile, created } = await baseProfileFor(ref, true);
  if (!profile) throw new Error(`model not found: ${ctx.job.ref}`);
  let configured = profile;
  const caps = (configured.capabilities ?? {}) as Record<string, unknown>;
  ctx.log(`[hub] ${created ? "creating" : "reconfiguring"} profile for ${configured.label}`);

  if (ref.backend === "llama-cpp") {
    if (form.mtp !== undefined) {
      configured = form.mtp ? applyMtpDefaults(configured) : removeMtpDefaults(configured);
      if (form.mtp && form.draftTokens !== undefined) {
        configured = applyRuntimeFlagOverrides(configured, { specDraftNMax: form.draftTokens });
      }
    }
    if (form.vision !== undefined && configured.mmprojPath) {
      configured = form.vision ? applyVisionDefaults(configured) : removeVisionDefaults(configured, "user-disabled");
    }
    if (form.thinkingDefaults !== undefined && caps.thinking) {
      configured = form.thinkingDefaults ? applyThinkingDefaults(configured) : removeThinkingDefaults(configured);
    }
    const overrides: Record<string, unknown> = {};
    for (const key of ["nGpuLayers", "ctxSize", "cacheTypeK", "cacheTypeV", "batchSize", "parallel"]) {
      if (form[key] !== undefined) overrides[key] = form[key];
    }
    if (form.flashAttention !== undefined) overrides.flashAttention = form.flashAttention ? "on" : "off";
    if (form.jinja !== undefined) overrides.jinja = form.jinja;
    for (const [k, v] of Object.entries((form.samplers as Record<string, number>) ?? {})) overrides[k] = v;
    configured = applyRuntimeFlagOverrides(configured, overrides);
  } else {
    if (ref.backend === "omlx") {
      if (form.mtpEnabled !== undefined) configured = { ...configured, mtpEnabled: form.mtpEnabled };
      if (form.thinkingOff !== undefined) configured = { ...configured, thinkingOff: form.thinkingOff };
      if (form.thinkingBudget !== undefined) configured = { ...configured, thinkingBudget: form.thinkingBudget };
    }
  }

  if (form.thinkingLevel !== undefined) {
    configured = { ...configured, thinkingLevel: form.thinkingLevel || undefined };
  }

  const { saveProfile } = await import("../../profiles.mjs");
  configured = await saveProfile(configured);
  ctx.log(`[hub] profile saved: ${configured.id}`);

  // Keep the harness config in sync so the model page's copyable launch
  // command (`pi --model <provider>/<alias>`) resolves in the user's pi.
  // Best effort — a missing harness is a warning, not a setup failure.
  try {
    const harness = harnessFor((await configuredHarness()).id);
    await harness.syncConfig(configured);
    ctx.log(`[hub] ${harness.label} config synced — pi --model ${configured.providerId}/${configured.modelAlias} is ready`);
  } catch (err) {
    ctx.log(`[hub] warning: harness config not synced (${(err as Error).message})`);
  }

  if (ref.backend === "omlx") {
    ctx.log("[hub] applying thinking/MTP settings to the oMLX server…");
    await applyProfileSettingsToOmlx(configured); // warns (not throws) when the server is down
  }
  ctx.progress(null, "profile saved");
  return { profileId: configured.id, created };
}
