import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

// ── Base directories ──────────────────────────────────────────────────────

export const DATA_DIR = process.env.OFFGRID_DIR || join(homedir(), ".offgrid-ai");
export const PROFILE_DIR = join(DATA_DIR, "profiles");
export const LOG_DIR = join(DATA_DIR, "logs");
export const RUN_DIR = join(DATA_DIR, "run");
export const RUNTIME_DIR = join(DATA_DIR, "runtime");
export const MANAGED_LLAMA_SERVER = join(RUNTIME_DIR, "bin", "llama-server");

// ── Default scan directories ──────────────────────────────────────────────

// HuggingFace hub cache: $HF_HUB_CACHE, else $HF_HOME/hub, else
// ~/.cache/huggingface/hub. This is where huggingface_hub stores
// models--org--name/... and where offgrid-ai scans + downloads. Pointing at the
// hub (not the HF root) keeps the GGUF scanner and the downloader on the
// same layout.
export const HF_HUB_DIR = process.env.HF_HUB_CACHE
  || (process.env.HF_HOME ? join(process.env.HF_HOME, "hub") : join(homedir(), ".cache", "huggingface", "hub"));

export const DEFAULT_MODEL_DIRS = [
  join(homedir(), ".lmstudio", "models"),
  join(homedir(), ".omlx", "models"),
  HF_HUB_DIR,
];

// ── External config paths ─────────────────────────────────────────────────

export const PI_CONFIG = join(homedir(), ".pi", "agent", "models.json");

// ── Ensure data directories exist ─────────────────────────────────────────

export async function ensureDirs() {
  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(RUN_DIR, { recursive: true });
}

// ── User config ───────────────────────────────────────────────────────────

const CONFIG_PATH = join(DATA_DIR, "config.json");

const DEFAULT_CONFIG = {
  modelScanDirs: [],
  binaryOverrides: {},
  enable_omlx: false,
  enable_ollama: false,
};

export async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      // Auto-create config.json with defaults so the user can find and edit it
      await mkdir(dirname(CONFIG_PATH), { recursive: true });
      await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8").catch(() => {});
      return { ...DEFAULT_CONFIG };
    }
    throw new Error(
      `Failed to read config at ${CONFIG_PATH}: ${error.message}. ` +
      `Fix or remove the file, then try again.`,
      { cause: error }
    );
  }
}

async function saveConfig(config) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ── Feature flags ──────────────────────────────────────────────────────────

const OMLX_MODELS_DIR = join(homedir(), ".omlx", "models");

/**
 * Check if oMLX backend is enabled.
 * Disabled by default — enable via config.json ("enable_omlx": true).
 * When disabled, all oMLX UI, scanning, profiling, and download paths are
 * hidden. Existing oMLX profiles are preserved on disk but not shown.
 * To enable for all users later, change the default below from === true
 * to !== false (one line, no other code changes needed).
 * @param {object} [config] - pre-loaded config (avoids redundant read)
 */
export async function omlxEnabled(config) {
  const cfg = config ?? await loadConfig();
 return cfg.enable_omlx === true;
}

/**
 * Check if Ollama backend is enabled.
 * Same pattern as oMLX — disabled by default, enable via config.json.
 */
export async function ollamaEnabled(config) {
  const cfg = config ?? await loadConfig();
  return cfg.enable_ollama === true;
}

// ── Model scan directories ────────────────────────────────────────────────

export async function getModelScanDirs() {
  const config = await loadConfig();
  const dirs = [...DEFAULT_MODEL_DIRS, ...config.modelScanDirs];
  // Exclude ~/.omlx/models when oMLX is disabled
  if (!(await omlxEnabled(config))) {
    return dirs.filter((d) => d !== OMLX_MODELS_DIR).filter((dir, i, arr) => arr.indexOf(dir) === i);
  }
  return dirs.filter((dir, i, arr) => arr.indexOf(dir) === i);
}

export async function addModelScanDir(dir) {
  const config = await loadConfig();
  config.modelScanDirs ??= [];
  if (!config.modelScanDirs.includes(dir)) {
    config.modelScanDirs.push(dir);
    await saveConfig(config);
  }
}

export async function removeModelScanDir(dir) {
  const config = await loadConfig();
  config.modelScanDirs = (config.modelScanDirs ?? []).filter((d) => d !== dir);
  await saveConfig(config);
}

// ── Binary discovery ──────────────────────────────────────────────────────

import { execFileAsync } from "./exec.mjs";

export async function findLlamaServer() {
  // 1. Env override
  if (process.env.LLAMA_SERVER_BINARY && existsSync(process.env.LLAMA_SERVER_BINARY)) {
    return process.env.LLAMA_SERVER_BINARY;
  }

  // 2. User config override
  const config = await loadConfig();
  const configured = config.binaryOverrides?.llamaServer ?? config.binaryOverrides?.["llama-server"];
  if (configured && existsSync(configured)) return configured;

  // 3. offgrid-ai managed runtime
  if (existsSync(MANAGED_LLAMA_SERVER)) return MANAGED_LLAMA_SERVER;

  // 4. PATH
  try {
    const { stdout } = await execFileAsync("which", ["llama-server"]);
    const path = stdout.trim();
    if (path && existsSync(path)) return path;
  } catch { /* not on PATH */ }

  // 5. Homebrew fallback
  try {
    const { stdout } = await execFileAsync("brew", ["--prefix", "llama.cpp"]);
    const prefix = stdout.trim();
    const candidate = join(prefix, "bin", "llama-server");
    if (existsSync(candidate)) return candidate;
  } catch { /* Homebrew not installed or llama.cpp not brewed */ }

  // No llama-server found — caller must present actionable error or onboarding.
  return null;
}

export async function hasHomebrew() {
  try {
    await execFileAsync("which", ["brew"]);
    return true;
  } catch {
    return false;
  }
}