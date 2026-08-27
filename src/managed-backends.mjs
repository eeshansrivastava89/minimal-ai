// Managed-backend behavior, one home (A2). Adding a 4th managed backend =
// one BACKENDS entry + one row in MANAGED_ACTIONS — no auditing dispatch
// sites across server-lifecycle / server-status / harness-shared.
//
// Lives on top of the leaf runtimes + the leaf server-http.mjs (never the
// reverse) so the module graph stays acyclic: backends.mjs stays a data
// registry, and the actions below are looked up by OBJECT IDENTITY — no
// backend.id-string dispatch anywhere.

import { BACKENDS } from "./backends.mjs";
import { startOmlxServer, putOmlxModelSettings, omlxSettingsFailureHint } from "./omlx-runtime.mjs";
import { startOllamaServer, unloadOllamaModel, ollamaLoadedModels } from "./ollama-runtime.mjs";
import { readOmlxModelSettings } from "./mlx-discovery.mjs";
import { mtpEnabledFor } from "./capabilities.mjs";
import { effectiveModelId } from "./profiles.mjs";
import { status } from "./ui.mjs";
import { apiRootUrl, omlxLoadedModelIds, serverModelIds, responseErrorDetail, modelIdsMatch, expectedModelIds } from "./server-http.mjs";

// ── oMLX model settings: the profile is the source of truth (A4/3.2.x) ──────
// One writer for setup-time and launch-time. Every managed key is derived
// from the profile (explicit off included), compared against the server's
// persisted settings, and only the drift is PUT — so a re-enabled thinking
// or a removed budget actually reaches the server, which the old
// additive-only lifecycle writer could never do. oMLX applies MTP patches at
// model load time, so mtp_enabled must be in model_settings.json before any
// request triggers a load.
const OMLX_SETTING_DEFAULTS = {
  mtp_enabled: false,
  enable_thinking: true,
  thinking_budget_enabled: false,
};

/** The full desired oMLX model settings for a profile — all managed keys,
 *  explicit off included, so drift cannot accumulate silently. */
export function desiredOmlxModelSettings(profile) {
  const settings = {
    mtp_enabled: mtpEnabledFor(profile),
    enable_thinking: profile.thinkingOff !== true,
  };
  if (Number.isFinite(profile.thinkingBudget)) {
    settings.thinking_budget_enabled = true;
    settings.thinking_budget_tokens = profile.thinkingBudget;
  } else {
    settings.thinking_budget_enabled = false;
  }
  return settings;
}

function describeOmlxSetting(key, settings) {
  if (key === "mtp_enabled") return `MTP ${settings.mtp_enabled ? "on" : "off"}`;
  if (key === "enable_thinking") return `thinking ${settings.enable_thinking ? "on" : "off"}`;
  if (key === "thinking_budget_enabled") {
    // "on" rides on the tokens entry; disabled is worth saying on its own.
    return settings.thinking_budget_enabled ? null : "budget disabled";
  }
  if (key === "thinking_budget_tokens") return `budget ${settings.thinking_budget_tokens.toLocaleString()} tokens`;
  return null;
}

/** Diff the profile's desired settings against the server and PUT only the
 *  drift. No-op (silent) when the server already agrees. */
export async function applyProfileSettingsToOmlx(profile) {
  const modelId = effectiveModelId(profile);
  const desired = desiredOmlxModelSettings(profile);
  const current = await readOmlxModelSettings(modelId);
  const drift = Object.entries(desired).filter(([key, value]) => (current?.[key] ?? OMLX_SETTING_DEFAULTS[key] ?? null) !== value);
  if (drift.length === 0) return;
  const settings = Object.fromEntries(drift);

  const result = await putOmlxModelSettings(apiRootUrl(profile.baseUrl), modelId, settings);
  if (!result.ok) {
    console.log(status({ kind: "warning", message: `[omlx] Could not apply model settings: ${omlxSettingsFailureHint(result)}` }));
    return;
  }
  const applied = Object.keys(settings).map((key) => describeOmlxSetting(key, settings)).filter(Boolean).join(", ");
  const verb = result.verified === false ? "Applied (not independently verified)" : "Synced";
  console.log(status({ kind: "success", message: `[omlx] ${verb}: ${applied} for ${modelId}` }));
}

// ── oMLX unload ─────────────────────────────────────────────────────────────

async function unloadOmlxModel(profile) {
  const adminUrl = `${apiRootUrl(profile.baseUrl)}/admin/api/models`;
  const modelId = effectiveModelId(profile);

  try {
    const result = await serverModelIds(profile.baseUrl);
    if (!result.ok) {
      return { unloaded: false, backend: "omlx", modelId, error: `couldn't reach ${profile.baseUrl} to list loaded models for unload` };
    }
    const match = result.ids.find((id) => id.toLowerCase() === modelId.toLowerCase());
    const targetId = match ?? modelId;

    const response = await fetch(`${adminUrl}/${encodeURIComponent(targetId)}/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30000),
    });

    if (response.ok) {
      return { unloaded: true, backend: "omlx", modelId: targetId };
    }

    const detail = await responseErrorDetail(response);

    if (response.status === 400 && /not loaded/i.test(detail)) {
      return { unloaded: true, backend: "omlx", modelId: targetId, reason: "model was not loaded" };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        unloaded: false,
        backend: "omlx",
        modelId: targetId,
        error: "oMLX admin authentication required. Enable skip_api_key_verification in oMLX settings, or unload manually from the admin panel.",
      };
    }

    return { unloaded: false, backend: "omlx", modelId: targetId, error: `HTTP ${response.status}: ${detail}` };
  } catch (err) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      return { unloaded: false, backend: "omlx", modelId, error: "Unload request timed out. The model may still be unloading in the background." };
    }
    return { unloaded: false, backend: "omlx", modelId, error: err.message };
  }
}

async function unloadOllamaModelFromServer(profile) {
  const modelId = effectiveModelId(profile);
  try {
    const ok = await unloadOllamaModel(modelId);
    if (ok) return { unloaded: true, backend: "ollama", modelId };
    return { unloaded: false, backend: "ollama", modelId, error: "Ollama did not confirm unload" };
  } catch (err) {
    return { unloaded: false, backend: "ollama", modelId, error: err.message };
  }
}

// ── Loaded checks ───────────────────────────────────────────────────────────

/** oMLX: is the profile's model currently loaded (null = couldn't tell). */
async function omlxModelLoaded(profile) {
  const { ok, ids } = await omlxLoadedModelIds(profile.baseUrl);
  if (!ok) return null;
  return modelIdsMatch(ids, expectedModelIds(profile));
}

/** Ollama: is the profile's model currently loaded (null = couldn't tell). */
async function ollamaModelLoaded(profile) {
  const { ok, ids } = await ollamaLoadedModels();
  if (!ok) return null;
  const expected = expectedModelIds(profile);
  return ids.some((name) => expected.some((e) => e.toLowerCase() === name.toLowerCase()));
}

// ── Start + action registry ─────────────────────────────────────────────────

const MANAGED_ACTIONS = new Map([
  [BACKENDS.omlx, {
    async startManaged() {
      try {
        await startOmlxServer();
      } catch (err) {
        if (err.message.includes("not installed")) throw new Error(`${BACKENDS.omlx.label} is not installed. Run minimal-ai to install it, or download oMLX from https://github.com/jundot/omlx/releases`, { cause: err });
        throw new Error(`${BACKENDS.omlx.label} could not be auto-started: ${err.message}. Run \`omlx start\` manually.`, { cause: err });
      }
    },
    applyModelSettings: applyProfileSettingsToOmlx,
    modelLoaded: omlxModelLoaded,
    unloadModel: unloadOmlxModel,
  }],
  [BACKENDS.ollama, {
    async startManaged() {
      try {
        await startOllamaServer();
      } catch (err) {
        throw new Error(`${BACKENDS.ollama.label} could not be auto-started: ${err.message}. Run \`ollama serve\` manually.`, { cause: err });
      }
    },
    modelLoaded: ollamaModelLoaded,
    unloadModel: unloadOllamaModelFromServer,
  }],
]);

/** The managed-server actions for a backend object (identity lookup — no id
 *  strings), or {} for backends with none. */
export function managedActions(backend) {
  return MANAGED_ACTIONS.get(backend) ?? {};
}