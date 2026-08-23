import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadProfiles } from "./profiles.mjs";
import { status, theme } from "./ui.mjs";

// ── Harness-neutral model/profile helpers ────────────────────────────────
// Everything a chat harness (Pi, omp, …) needs to describe minimal-ai
// profiles in its own config format lives here. Adapters only serialize.

/** All saved profiles on the same provider as `profile`, plus `profile` itself. */
async function activeProviderProfiles(currentProfile) {
  const allProfiles = await loadProfiles();
  const byAlias = new Map();
  for (const item of [...allProfiles, currentProfile]) {
    if (item.providerId !== currentProfile.providerId) continue;
    if (item.backend !== "llama-cpp") {
      byAlias.set(item.modelAlias, item);
      continue;
    }
    if (!item.modelPath || !existsSync(item.modelPath)) continue;
    byAlias.set(item.modelAlias, item);
  }
  return Array.from(byAlias.values()).sort((a, b) => a.modelAlias.localeCompare(b.modelAlias));
}

/** How a harness addresses the model: "<providerId>/<modelAlias>". */
export function harnessModelRef(profile) {
  return `${profile.providerId}/${profile.modelAlias}`;
}

/** Neutral model descriptor; each harness adapter maps this into its own schema. */
export function modelDescriptor(profile) {
  const { maxTokens, contextWindow } = resolvedLimits(profile);
  return {
    id: profile.modelAlias,
    name: profile.label,
    input: modelInput(profile),
    maxTokens: maxTokens ?? FALLBACK_MAX_TOKENS,
    contextWindow: contextWindow || undefined,
    // Whether the model can think at all (capability fact, harness-independent).
    thinking: thinkingCapability(profile),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

/**
 * The context window a harness should assume for a profile, resolved from
 * backend-appropriate sources (no hardcoded 16K except as a last resort):
 * - llama.cpp: configured flags.ctxSize (user choice), else detected model max
 * - managed oMLX: server-reported max_model_len, persisted at setup
 * - managed Ollama: served context from /api/ps (runtime fact), else the
 *   legacy llama flag slot it briefly lived in, else the model max
 */
export function resolvedLimits(profile) {
  const caps = profile.capabilities ?? {};
  if (profile.backend === "ollama") {
    const ctx = caps.servedContext ?? profile.flags?.ctxSize ?? caps.contextLength ?? null;
    return ctx ? { maxTokens: ctx, contextWindow: ctx } : { maxTokens: null, contextWindow: null };
  }
  if (profile.backend === "omlx") {
    const ctx = caps.contextLength ?? profile.flags?.ctxSize ?? null;
    return ctx ? { maxTokens: ctx, contextWindow: ctx } : { maxTokens: null, contextWindow: null };
  }
  // llama.cpp: the configured context window governs the harness ceiling.
  const ctx = profile.flags?.ctxSize ?? caps.contextLength ?? null;
  return ctx ? { maxTokens: ctx, contextWindow: ctx } : { maxTokens: null, contextWindow: null };
}

const FALLBACK_MAX_TOKENS = 16384;

function modelInput(profile) {
  if (profile.mmprojPath && existsSync(profile.mmprojPath)) return ["text", "image"];
  if (profile.capabilities?.vision) return ["text", "image"];
  return ["text"];
}

function thinkingCapability(profile) {
  // Dumb renderer: only the stored fact counts. Capability detection
  // (including the name-hint last resort) happens at setup/reconfigure in
  // capabilities.mjs — reconfigure older managed profiles to refresh facts.
  return profile.capabilities?.thinking || undefined;
}

export function modelFamily(profile) {
  return [profile.id, profile.label, profile.modelAlias, profile.omlxModel, profile.ollamaModel].filter(Boolean).join(" ").toLowerCase();
}

/**
 * Provider-level compat shared by all local OpenAI-compatible backends.
 * oMLX's server reads the top-level reasoning_effort field, and Ollama's
 * /v1 maps it to internal think levels (verified 0.32.15: accepts
 * minimal/low/medium/high/xhigh/max verbatim, plus "none" and "ultra").
 * llama.cpp needs chat_template_kwargs (carried per-model in Pi compat).
 */
export function providerCompat(backendId) {
  return { supportsDeveloperRole: false, supportsReasoningEffort: backendId === "omlx" || backendId === "ollama", maxTokensField: "max_tokens" };
}

/** Spawn a harness CLI in the foreground, inheriting stdio. */
function runForeground(cmd, argv, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: "inherit", ...(cwd ? { cwd } : {}) });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)));
  });
}

// ── Shared harness config plumbing ────────────────────────────────────────
// Every chat harness config (Pi models.json, omp models.yml) is a providers
// map with the same block shape; only the file format and per-model fields
// differ. Adapters supply io { configPath, readConfig, writeConfig } and a
// modelConfig(profile) serializer; these helpers own everything else.

/** Write the provider block for profile.providerId with all same-provider models. */
export async function syncProviderConfig(harness, profile, io) {
  const profiles = await activeProviderProfiles(profile);
  const config = await io.readConfig();
  config.providers ??= {};
  config.providers[profile.providerId] = {
    baseUrl: profile.baseUrl,
    api: "openai-completions",
    apiKey: "none",
    compat: providerCompat(profile.backend),
    models: profiles.map((item) => harness.modelConfig(item)),
  };
  await io.writeConfig(config);
  console.log(status({ kind: "success", message: `Synced ${harness.label} config: ${io.configPath} (${profiles.length} model${profiles.length === 1 ? "" : "s"})` }));
}

/** Remove a model from its provider block; drop the provider when empty. */
export async function removeProviderModel(harness, profile, io) {
  const config = await io.readConfig();
  config.providers ??= {};
  const provider = config.providers[profile.providerId];
  if (!provider?.models) return { cleaned: false, reason: `no ${profile.providerId} provider in ${harness.label} config` };
  const before = provider.models.length;
  provider.models = provider.models.filter((m) => m.id !== profile.modelAlias);
  if (provider.models.length === 0) delete config.providers[profile.providerId];
  if (before > provider.models.length) {
    await io.writeConfig(config);
    return { cleaned: true, removed: before - provider.models.length };
  }
  return { cleaned: false, reason: `${profile.modelAlias} not in ${harness.label} config` };
}

/** Whether the profile's model is present in the harness config. */
export async function providerHasModel(profile, io) {
  const config = await io.readConfig();
  return Boolean(config?.providers?.[profile.providerId]?.models?.some?.((m) => m.id === profile.modelAlias));
}

/** Launch the harness CLI in the foreground against the profile's model. */
export async function launchModel(harness, profile, { cwd, message, thinking } = {}) {
  const model = harnessModelRef(profile);
  const args = ["--model", model];
  if (thinking) args.push("--thinking", thinking);
  if (message) args.push(message);
  console.log(theme.bold(`[${harness.id}] ${harness.bin} --model ${model}`));
  await runForeground(harness.bin, args, { cwd });
}
