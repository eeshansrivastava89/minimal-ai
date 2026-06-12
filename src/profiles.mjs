import { existsSync } from "node:fs";
import { mkdir, readdir, rm, unlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROFILE_DIR, RUN_DIR, LOG_DIR } from "./config.mjs";
import { backendFor, baseUrlForFlags, defaultFlagsForBackend } from "./backends.mjs";
import { computeFlags } from "./autodetect.mjs";
import { readJson, writeJson } from "./json.mjs";

// ── Path helpers ───────────────────────────────────────────────────────────

export function profileDir(id) {
  return join(PROFILE_DIR, sanitizeProfileId(id));
}

export function profileJsonPath(id) {
  return join(profileDir(id), "profile.json");
}

export function commandJsonPath(id) {
  return join(profileDir(id), "command.json");
}

export function notesPath(id) {
  return join(profileDir(id), "notes.md");
}

export function statePath(id) {
  return join(RUN_DIR, `${sanitizeProfileId(id)}.state.json`);
}

export function sanitizeProfileId(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-|-$/gu, "") || "profile";
}

export function slugFromLabel(value) {
  return sanitizeProfileId(value);
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function loadProfiles() {
  const entries = await readdir(PROFILE_DIR, { withFileTypes: true }).catch(() => []);
  const ids = entries
    .filter((e) => e.isDirectory() && existsSync(profileJsonPath(e.name)))
    .map((e) => e.name)
    .sort();
  return Promise.all(ids.map((id) => readProfile(id)));
}

export async function readProfile(id) {
  const path = profileJsonPath(id);
  if (!existsSync(path)) throw new Error(`Profile "${id}" not found.`);
  return JSON.parse(await readFile(path, "utf8"));
}

export async function saveProfile(profile, options = {}) {
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

  // Write JSON command file for llama-server backends
  const backend = backendFor(saved.backend);
  if (backend.needsCommandFile) {
    const cmdPath = commandJsonPath(id);
    if (options.writeCommand || !existsSync(cmdPath)) {
      await writeJson(cmdPath, { argv: saved.commandArgv ?? [] });
    }
  }

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
  const { detectCapabilities } = await import("./autodetect.mjs");
  const caps = detectCapabilities(model.path, model.mmprojPath);
  // If a drafter is provided, this model supports MTP regardless of filename.
  // For Hugging Face Gemma 4 GGUF repos, prefer llama.cpp's -hf companion-file
  // discovery so root mtp-*.gguf drafters do not need offgrid-ai file matching.
  const hfGemma4Mtp = Boolean(model.hfRepo && /gemma-?4/i.test(`${model.hfRepo} ${model.label}`));
  const hasMtp = caps.mtp || Boolean(drafterPath) || hfGemma4Mtp;
  const backend = backendId ?? (hasMtp ? "llama-cpp-mtp" : "llama-cpp");
  const hfSource = model.hfRepo ? { hfRepo: model.hfRepo, hfVariant: model.hfVariant } : {};
  const { flags, argv } = computeFlags(
    { ...caps, mtp: hasMtp, ...hfSource },
    model.path,
    model.mmprojPath,
    drafterPath ?? null,
  );

  return normalizeProfile({
    id: slugFromLabel(model.label),
    label: model.label,
    backend,
    providerId: backend,
    modelAlias: model.aliasSuggestion,
    source: model.hfRepo ? "huggingface" : model.source,
    modelPath: model.path,
    mmprojPath: model.hfRepo ? null : model.mmprojPath,
    ...hfSource,
    drafterPath: drafterPath ?? null,
    capabilities: summarizeCapabilities({ ...caps, mtp: hasMtp, ...hfSource }),
    preset: null, // no presets — auto-detected
    flags,
    commandArgv: argv,
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
    hfRepo: caps.hfRepo,
    hfVariant: caps.hfVariant,
    ctxSize: caps.ctxSize,
  };
}

// ── State files (for running servers) ──────────────────────────────────────

export async function readCommandArgv(profile) {
  const command = await readJson(commandJsonPath(profile.id), null);
  return Array.isArray(command?.argv) ? command.argv.map(String) : (profile.commandArgv ?? []).map(String);
}

export async function readState(id) {
  return readJson(statePath(id), null);
}

export async function writeState(id, state) {
  await writeJson(statePath(id), state);
}