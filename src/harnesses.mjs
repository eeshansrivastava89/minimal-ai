import { loadConfig, saveConfig } from "./config.mjs";
import { loadProfiles } from "./profiles.mjs";
import { piHarness } from "./harness-pi.mjs";
import { ompHarness } from "./harness-omp.mjs";

// ── Chat harness registry ────────────────────────────────────────────────
// A harness is the chat UI minimal-ai launches against a running model
// server. Each adapter (harness-pi.mjs, harness-omp.mjs) exposes:
//   id, label, bin, npm, thinking — descriptor fields
//   detect()                           — is the CLI installed
//   syncConfig(profile)                — write all same-provider profiles
//   removeModel(profile) / hasModel(profile)
//   launch(profile, { cwd, message })  — foreground TUI
//   setup()?                           — one-time install extras (Pi only)
// Shared profile/model logic lives in harness-shared.mjs so adapters stay
// thin serializers.

const HARNESSES = {
  pi: piHarness,
  omp: ompHarness,
};

const DEFAULT_HARNESS = "pi";

export function listHarnesses() {
  return Object.values(HARNESSES);
}

export function harnessFor(id) {
  const harness = HARNESSES[id];
  if (!harness) throw new Error(`Unknown harness: "${id}". Supported: ${Object.keys(HARNESSES).join(", ")}`);
  return harness;
}

/** The harness chosen in models → Harness (config.json `harness` key). */
export async function configuredHarness() {
  const config = await loadConfig();
  return harnessFor(typeof config.harness === "string" && HARNESSES[config.harness] ? config.harness : DEFAULT_HARNESS);
}

export async function setConfiguredHarness(id) {
  harnessFor(id); // validate
  const config = await loadConfig();
  config.harness = id;
  await saveConfig(config);
}

/** Sync every saved profile into a harness config (one call per provider). */
export async function syncAllProfiles(harness) {
  const profiles = await loadProfiles();
  const byProvider = new Map();
  for (const profile of profiles) {
    if (!byProvider.has(profile.providerId)) byProvider.set(profile.providerId, profile);
  }
  let synced = 0;
  for (const profile of byProvider.values()) {
    await harness.syncConfig(profile);
    synced++;
  }
  return synced;
}
