import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { PI_CONFIG } from "./config.mjs";
import { loadProfiles } from "./profiles.mjs";
import { readJson, writeJson } from "./json.mjs";
import pc from "picocolors";

// ── Sync Pi config ─────────────────────────────────────────────────────────

export async function syncPiConfig(profile) {
  const profiles = await activeProviderProfiles(profile);
  const config = await readJson(PI_CONFIG, { providers: {} });
  config.providers ??= {};
  config.providers[profile.providerId] = {
    baseUrl: profile.baseUrl,
    api: "openai-completions",
    apiKey: piApiKey(profile.providerId),
    compat: providerCompat(profile.providerId),
    models: profiles.map(piModelConfig),
  };
  await writeJson(PI_CONFIG, config);
  console.log(pc.green(`Synced Pi config: ${PI_CONFIG} (${profiles.length} model${profiles.length === 1 ? "" : "s"})`));
}

// ── Remove from Pi config ──────────────────────────────────────────────────

export async function removeFromPiConfig(profile) {
  const config = await readJson(PI_CONFIG, { providers: {} });
  config.providers ??= {};
  const provider = config.providers[profile.providerId];
  if (!provider?.models) return { cleaned: false, reason: `no ${profile.providerId} provider in Pi config` };
  const before = provider.models.length;
  provider.models = provider.models.filter((m) => m.id !== profile.modelAlias);
  if (provider.models.length === 0) delete config.providers[profile.providerId];
  if (before > provider.models.length) {
    await writeJson(PI_CONFIG, config);
    return { cleaned: true, removed: before - provider.models.length };
  }
  return { cleaned: false, reason: `${profile.modelAlias} not in Pi config` };
}

// ── Check if Pi has the model ──────────────────────────────────────────────

export async function hasPiModel(profile) {
  const config = await readJson(PI_CONFIG, null);
  return Boolean(config?.providers?.[profile.providerId]?.models?.some?.((m) => m.id === profile.modelAlias));
}

// ── Launch Pi ──────────────────────────────────────────────────────────────

export async function launchPi(profile) {
  const model = profile.harnesses?.pi?.model ?? `${profile.providerId}/${profile.modelAlias}`;
  console.log(pc.bold(`[pi] pi --model ${model}`));
  await runForeground("pi", ["--model", model]);
}

// ── Check if Pi is installed ───────────────────────────────────────────────

export async function hasPi() {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("which", ["pi"]);
    return true;
  } catch {
    return false;
  }
}

// ── Internals ──────────────────────────────────────────────────────────────

async function activeProviderProfiles(currentProfile) {
  const allProfiles = await loadProfiles();
  const byAlias = new Map();
  for (const item of [...allProfiles, currentProfile]) {
    if (item.providerId !== currentProfile.providerId) continue;
    if (item.backend !== "llama-cpp" && item.backend !== "llama-cpp-mtp") {
      byAlias.set(item.modelAlias, item);
      continue;
    }
    if (!item.modelPath || !existsSync(item.modelPath)) continue;
    byAlias.set(item.modelAlias, item);
  }
  return Array.from(byAlias.values()).sort((a, b) => a.modelAlias.localeCompare(b.modelAlias));
}

function piModelConfig(profile) {
  const compat = modelCompat(profile);
  const reasoning = modelReasoning(profile);
  return {
    id: profile.modelAlias,
    name: profile.label,
    input: modelInput(profile),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(compat ? { compat } : {}),
    ...(profile.flags?.ctxSize ? { contextWindow: profile.flags.ctxSize } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function modelInput(profile) {
  if (profile.mmprojPath && existsSync(profile.mmprojPath)) return ["text", "image"];
  if (profile.capabilities?.vision) return ["text", "image"];
  return ["text"];
}

function modelCompat(profile) {
  if (profile.compat) return profile.compat;
  const family = modelFamily(profile);
  if (family.includes("qwen") || family.includes("gemma-4") || family.includes("gemma 4")) {
    return { thinkingFormat: "qwen-chat-template" };
  }
  return null;
}

function modelReasoning(profile) {
  if (profile.reasoning !== undefined) return Boolean(profile.reasoning);
  const family = modelFamily(profile);
  if (family.includes("qwen") || family.includes("gemma-4") || family.includes("gemma 4")) return true;
  return undefined;
}

function modelFamily(profile) {
  return [profile.id, profile.label, profile.modelAlias, profile.modelPath, profile.ollamaModel, profile.omlxModel].filter(Boolean).join(" ").toLowerCase();
}

function piApiKey(providerId) {
  return providerId === "ollama" ? "ollama" : "none";
}

function providerCompat(providerId) {
  if (providerId === "ollama") return { supportsDeveloperRole: true, supportsReasoningEffort: false };
  return { supportsDeveloperRole: false, supportsReasoningEffort: false };
}

function runForeground(cmd, argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)));
  });
}