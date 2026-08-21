import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadProfiles } from "./profiles.mjs";
import { nameHintsThinking } from "./autodetect.mjs";

// ── Harness-neutral model/profile helpers ────────────────────────────────
// Everything a chat harness (Pi, omp, …) needs to describe minimal-ai
// profiles in its own config format lives here. Adapters only serialize.

/** All saved profiles on the same provider as `profile`, plus `profile` itself. */
export async function activeProviderProfiles(currentProfile) {
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
  return {
    id: profile.modelAlias,
    name: profile.label,
    input: modelInput(profile),
    maxTokens: profile.flags?.ctxSize ?? 16384,
    contextWindow: profile.flags?.ctxSize || undefined,
    // Whether the model can think at all (capability fact, harness-independent).
    thinking: thinkingCapability(profile),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function modelInput(profile) {
  if (profile.mmprojPath && existsSync(profile.mmprojPath)) return ["text", "image"];
  if (profile.capabilities?.vision) return ["text", "image"];
  return ["text"];
}

function thinkingCapability(profile) {
  // GGUF profiles get thinking detection from metadata at setup time.
  // Managed models (oMLX/Ollama) have no readable metadata — fall back to
  // the same name hints autodetect uses.
  if (profile.capabilities?.thinking !== undefined) return profile.capabilities.thinking;
  return nameHintsThinking(modelFamily(profile)) || undefined;
}

export function modelFamily(profile) {
  return [profile.id, profile.label, profile.modelAlias, profile.omlxModel, profile.ollamaModel].filter(Boolean).join(" ").toLowerCase();
}

/** Provider-level compat shared by all local OpenAI-compatible backends. */
export function providerCompat() {
  return { supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens" };
}

/** Spawn a harness CLI in the foreground, inheriting stdio. */
export function runForeground(cmd, argv, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: "inherit", ...(cwd ? { cwd } : {}) });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`)));
  });
}
