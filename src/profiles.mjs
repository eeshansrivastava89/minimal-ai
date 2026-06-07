import { existsSync } from "node:fs";
import { mkdir, readdir, rm, unlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROFILE_DIR, RUN_DIR, LOG_DIR } from "./config.mjs";
import { backendFor } from "./backends.mjs";
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

export function profileExists(id) {
  return existsSync(profileJsonPath(id));
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

  // Write JSON command file for llama-server backends
  const backend = backendFor(saved.backend);
  if (backend.needsCommandFile) {
    const cmdPath = commandJsonPath(id);
    if (!existsSync(cmdPath)) {
      await writeJson(cmdPath, { argv: saved.commandArgv ?? saved.flags ?? [] });
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
    host: "127.0.0.1",
    port: backend.defaultPort,
    ...profile.flags,
  };
  if (!profile.baseUrl) {
    profile.baseUrl = `http://${flags.host}:${flags.port}/v1`;
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

export async function createProfileFromModel(model, backendId = "llama-cpp") {
  const { detectCapabilities } = await import("./autodetect.mjs");
  const caps = detectCapabilities(model.path, model.mmprojPath);
  const id = slugFromLabel(model.label);
  const { flags, argv } = computeFlags(caps, model.path, model.mmprojPath, null);

  return normalizeProfile({
    id,
    label: model.label,
    backend: backendId,
    modelAlias: model.aliasSuggestion,
    modelPath: model.path,
    mmprojPath: model.mmprojPath,
    preset: null, // no presets — auto-detected
    flags,
    commandArgv: argv,
  });
}

// ── State files (for running servers) ──────────────────────────────────────

export async function readState(id) {
  return readJson(statePath(id), null);
}

export async function writeState(id, state) {
  await writeJson(statePath(id), state);
}