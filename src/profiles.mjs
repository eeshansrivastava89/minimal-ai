import { existsSync } from "node:fs";
import { mkdir, readdir, rm, unlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROFILE_DIR, RUN_DIR, LOG_DIR, omlxEnabled, ollamaEnabled } from "./config.mjs";
import { backendFor, baseUrlForFlags, defaultFlagsForBackend, BACKENDS } from "./backends.mjs";
import { detectCapabilities } from "./autodetect.mjs";
import { computeFlags } from "./autodetect.mjs";
import { readJson, writeJson } from "./json.mjs";

// ── Path helpers ───────────────────────────────────────────────────────────

export function profileDir(id) {
  return join(PROFILE_DIR, sanitizeProfileId(id));
}

export function profileJsonPath(id) {
  return join(profileDir(id), "profile.json");
}

function notesPath(id) {
  return join(profileDir(id), "notes.md");
}

export function statePath(id) {
  return join(RUN_DIR, `${sanitizeProfileId(id)}.state.json`);
}

export function sanitizeProfileId(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-|-$/gu, "") || "profile";
}

/** Resolve the canonical model ID from a profile, checking backend-specific fields. */
export function effectiveModelId(profile) {
  return profile.omlxModel ?? profile.ollamaModel ?? profile.modelAlias ?? profile.id;
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function loadProfiles() {
  const omlxOn = await omlxEnabled();
  const ollamaOn = await ollamaEnabled();
  const entries = await readdir(PROFILE_DIR, { withFileTypes: true }).catch(() => []);
  const ids = entries
    .filter((e) => e.isDirectory() && existsSync(profileJsonPath(e.name)))
    .map((e) => e.name)
    .sort();
  return (await Promise.all(ids.map((id) => readProfile(id))))
    .map((p) => {
      // Migrate legacy llama-cpp-mtp backend → llama-cpp with mtp capability
      if (p.backend === "llama-cpp-mtp") {
        return { ...p, backend: "llama-cpp", providerId: "llama-cpp", capabilities: { ...(p.capabilities ?? {}), mtp: true } };
      }
      return p;
    })
    .filter((p) => BACKENDS[p.backend])
    .filter((p) => (omlxOn || p.backend !== "omlx") && (ollamaOn || p.backend !== "ollama"));
}

export async function readProfile(id) {
  const path = profileJsonPath(id);
  if (!existsSync(path)) throw new Error(`Profile "${id}" not found.`);
  return JSON.parse(await readFile(path, "utf8"));
}

export async function saveProfile(profile) {
  const id = sanitizeProfileId(profile.id);
  const dir = profileDir(id);
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  const existing = await readJson(profileJsonPath(id), null);
  const saved = {
    ...profile,
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await writeJson(profileJsonPath(id), saved);

  // Note: commandArgv is no longer stored — computeServerCommand computes
  // the full command fresh from profile config at launch time.

  if (!existsSync(notesPath(id))) {
    await writeFile(notesPath(id), `# ${saved.label}\n\nNotes for this model profile.\n`, "utf8");
  }
  return saved;
}

export async function deleteProfile(id, options = {}) {
  const dir = profileDir(id);
  const results = { profileDir: false, state: false, logs: [] };
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true });
    results.profileDir = true;
  }
  const stateFile = statePath(id);
  if (existsSync(stateFile)) {
    await unlink(stateFile);
    results.state = true;
  }
  if (!options.keepLogs) {
    const entries = await readdir(LOG_DIR, { withFileTypes: true }).catch(() => []);
    const prefix = `${sanitizeProfileId(id)}-`;
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith(prefix)) {
        await unlink(join(LOG_DIR, entry.name));
        results.logs.push(entry.name);
      }
    }
  }
  return results;
}

// ── Normalize / auto-detect ────────────────────────────────────────────────

export function normalizeProfile(profile) {
  const backend = backendFor(profile.backend);
  const flags = {
    ...defaultFlagsForBackend(backend.id),
    ...profile.flags,
  };
  if (!profile.baseUrl) {
    profile.baseUrl = baseUrlForFlags(flags);
  }

  return {
    ...profile,
    flags,
    providerId: profile.providerId ?? backend.providerId,
    harnesses: profile.harnesses ?? {
      pi: { enabled: true, model: `${profile.providerId ?? backend.providerId}/${profile.modelAlias ?? profile.id}` },
    },
  };
}

// ── Auto-create profile from a discovered model ────────────────────────────

export async function createProfileFromModel(model, backendId, drafterPath) {
  const caps = detectCapabilities(model.path, model.mmprojPath);
  // If a drafter is provided, this model supports MTP regardless of filename
  const hasMtp = caps.mtp || Boolean(drafterPath);
  const backend = backendId ?? "llama-cpp";
  const { flags } = computeFlags(
    { ...caps, mtp: hasMtp },
    model.path,
    model.mmprojPath,
    drafterPath ?? null,
  );

  return normalizeProfile({
    id: sanitizeProfileId(model.label),
    label: model.label,
    backend,
    providerId: backend,
    modelAlias: model.aliasSuggestion,
    source: model.source,
    modelPath: model.path,
    mmprojPath: model.mmprojPath,
    drafterPath: drafterPath ?? null,
    capabilities: summarizeCapabilities({ ...caps, mtp: hasMtp }),
    preset: null, // no presets — auto-detected
    flags,
  });
}

function summarizeCapabilities(caps) {
  return {
    architecture: caps.architecture,
    thinking: caps.thinking,
    vision: caps.vision,
    mtp: caps.mtp,
    qat: caps.qat,
    imatrix: caps.imatrix,
    quant: caps.quant,
    metaCtx: caps.metaCtx,
    mmprojProjectorType: caps.mmprojProjectorType,
    ctxSize: caps.ctxSize,
  };
}

// ── State files (for running servers) ──────────────────────────────────────

export async function readState(id) {
  return readJson(statePath(id), null);
}

export async function writeState(id, state) {
  await writeJson(statePath(id), state);
}