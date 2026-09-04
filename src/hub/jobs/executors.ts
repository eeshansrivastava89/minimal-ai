// Job executors — download, setup, launch. Each takes a JobContext and
// returns metrics (stored in the job row's nullable metrics JSON column).
// They reuse the service layer as-is: files stay the source of truth, the
// hub is the only driver.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

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
import { HF_HUB_DIR, DATA_DIR } from "../../config.mjs";
import { createProfileFromModel } from "../../profiles.mjs";
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
import { backendFor } from "../../backends.mjs";
import { configuredHarness, harnessFor } from "../../harnesses.mjs";
import {
  startServer,
  stopOrUnload,
  waitForReady,
  serverReady,
  serverMatchesProfile,
  modelAvailableOnServer,
  preflightInference,
  computeServerCommand,
} from "../../process.mjs";
import { applyProfileSettingsToOmlx } from "../../managed-backends.mjs";
import { quoteShell } from "../../server-command.mjs";

import { profileMatchesModel } from "../api/data.ts";
import { catalog } from "../api/data.ts";
import { parseModelRef, type ModelRef } from "../api/model-ref.ts";
import type { JobContext } from "./runner.ts";

// ── download ────────────────────────────────────────────────────────────────

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

  if (ref.backend === "omlx") {
    ctx.log("[hub] applying thinking/MTP settings to the oMLX server…");
    await applyProfileSettingsToOmlx(configured); // warns (not throws) when the server is down
  }
  ctx.progress(null, "profile saved");
  return { profileId: configured.id, created };
}

// ── launch (Run in browser: pi headless, owned by the runner) ────────────────

export interface LaunchOptions {
  piBin?: string; // test seam: stub pi binary
}

/** Stream pi's `--mode json` events into job-log lines: tool calls as they
 *  start/finish, assistant text as it types (flushed per newline). Non-JSON
 *  stdout (banners, stub bins) passes through untouched. */
function piEventLog() {
  let textBuf = "";
  let thinkingBuf = "";
  return (line: string): string | null => {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return line; // not an event line — log it raw
    }
    switch (ev.type) {
      case "session":
        return "[pi] session started";
      case "agent_start":
        return "[pi] agent started";
      case "tool_execution_start": {
        const args = ev.args ?? {};
        const detail =
          typeof args.command === "string" ? args.command.split("\n")[0].slice(0, 160)
          : typeof args.path === "string" ? args.path
          : typeof args.url === "string" ? args.url
          : typeof args.query === "string" ? args.query
          : typeof args.pattern === "string" ? args.pattern
          : "";
        return `[pi] → ${ev.toolName}${detail ? `: ${detail}` : ""}`;
      }
      case "tool_execution_end":
        return ev.isError ? `[pi] ✗ ${ev.toolName} failed` : null;
      case "message_update": {
        const delta = ev.assistantMessageEvent;
        // Model text streams as it types; thinking streams dimmed
        // ("… " prefix, like pi's TUI) as it thinks.
        if (delta?.type === "thinking_delta" && typeof delta.delta === "string") {
          thinkingBuf += delta.delta;
          const parts = thinkingBuf.split("\n");
          thinkingBuf = parts.pop() ?? "";
          const lines = parts.filter((l) => l.trim());
          return lines.length ? lines.map((l) => `[pi] … ${l.trim()}`).join("\n") : null;
        }
        if (delta?.type === "text_delta" && typeof delta.delta === "string") {
          textBuf += delta.delta;
          const parts = textBuf.split("\n");
          textBuf = parts.pop() ?? "";
          return parts.filter((l) => l.trim()).join("\n") || null;
        }
        return null;
      }
      case "message_end": {
        const out: string[] = [];
        if (thinkingBuf.trim()) out.push(`[pi] … ${thinkingBuf.trim()}`);
        if (textBuf.trim()) out.push(textBuf);
        thinkingBuf = "";
        textBuf = "";
        return out.length ? out.join("\n") : null;
      }
      case "agent_end":
        return "[pi] agent finished";
      default:
        return null;
    }
  };
}

/** The one headless launch path: server up → preflight → pi spawn (owned
 *  by the runner). Both "Run in browser" and benchmark runs go through
 *  here — cwd and prompt are the only differences. */
export async function runModelHeadless(
  ctx: JobContext,
  profile: any,
  opts: { piBin?: string; message?: string; thinking?: string; keepServer?: boolean; cwd: string }
): Promise<Record<string, unknown>> {
  const backend = backendFor(profile.backend);
  const started = Date.now();

  ctx.log(`[hub] launching ${profile.label} (${backend.label})`);
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

  const harness = harnessFor((await configuredHarness()).id);
  if (!(await harness.detect())) throw new Error(`${harness.label} is not installed — npm install -g ${harness.npm}`);
  await harness.syncConfig(profile);

  const piBin = opts.piBin ?? harness.bin;
  const args = ["--model", `${profile.providerId}/${profile.modelAlias}`];
  const level = opts.thinking ?? profile.thinkingLevel;
  if (level) args.push("--thinking", level);
  if (opts.message) args.push(opts.message);
  // JSON mode streams live events (tool calls, text deltas) the job log
  // renders — plain text mode prints nothing until the run is over.
  args.unshift("--mode", "json");

  await mkdir(opts.cwd, { recursive: true });
  ctx.progress(null, "pi running");
  ctx.log(`[hub] ${piBin} ${args.join(" ")}`);
  const result = await ctx.spawnOwned(piBin, args, { cwd: opts.cwd, stdoutTransform: piEventLog() });

  const metrics = {
    exitCode: result.code,
    durationMs: Date.now() - started,
    piDurationMs: result.durationMs,
    keepServer: Boolean(opts.keepServer),
    workdir: opts.cwd,
  };
  if (!opts.keepServer) {
    ctx.log("[hub] unloading/stopping the server");
    await stopOrUnload(profile);
  }
  if (result.code !== 0) throw new Error(`pi exited with code ${result.code}`);
  return metrics;
}

export function launchExecutor(options: LaunchOptions = {}) {
  return async function launch(ctx: JobContext) {
    const ref = parseModelRef(ctx.job.ref ?? "");
    if (!ref) throw new Error("launch job is missing its model ref");
    const { message, keepServer, thinking } = ctx.job.payload as {
      message?: string;
      keepServer?: boolean;
      thinking?: string;
    };
    const { profile } = await baseProfileFor(ref, false);
    if (!profile) throw new Error("no saved profile for this model — set it up first");
    return await runModelHeadless(ctx, profile, {
      piBin: options.piBin,
      message,
      keepServer,
      thinking,
      cwd: join(DATA_DIR, "hub", "runs", ctx.job.id),
    });
  };
}

// ── Open in Terminal ────────────────────────────────────────────────────────

/** The interactive-launch script the hub hands to Terminal.app. The hub
 *  never owns this process — read-back is backend state only. Reuses
 *  computeServerCommand so script and launch always match. */
export async function buildTerminalScript(profile: any): Promise<string> {
  const backend = backendFor(profile.backend);
  const harness = harnessFor((await configuredHarness()).id);
  await harness.syncConfig(profile);
  const piLine = `exec ${quoteShell(harness.bin)} --model ${quoteShell(`${profile.providerId}/${profile.modelAlias}`)}`;

  if (backend.type === "managed-server") {
    return [
      "#!/bin/bash",
      `# Generated by Minimal Intelligence Hub — interactive ${harness.label} session`,
      piLine,
      "",
    ].join("\n");
  }

  const command = await computeServerCommand(profile);
  if (!command) throw new Error("no server command for this backend");
  const { binary, argv } = command;
  const start = [quoteShell(binary), ...argv.map(quoteShell)].join(" ");
  const base = profile.baseUrl.replace(/\/v1$/, "");
  return [
    "#!/bin/bash",
    `# Generated by Minimal Intelligence Hub — interactive ${harness.label} session`,
    "# Starts the model server, waits for ready, runs pi; the server stops on exit.",
    `${start} &`,
    "SERVER_PID=$!",
    "trap 'kill $SERVER_PID 2>/dev/null' EXIT",
    `until curl -sf ${quoteShell(`${base}/v1/models`)} > /dev/null 2>&1; do`,
    "  if ! kill -0 $SERVER_PID 2>/dev/null; then echo 'server exited before ready' >&2; exit 1; fi",
    "  sleep 1",
    "done",
    piLine,
    "",
  ].join("\n");
}