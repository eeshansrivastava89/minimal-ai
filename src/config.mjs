import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { theme } from "./ui.mjs";
import { writeJson } from "./json.mjs";
import { resolvedPathAllowMissingSync as resolvedDataDirPath } from "./paths.mjs";

// ── Base directories ──────────────────────────────────────────────────────

export const DATA_DIR = process.env.MINIMAL_DIR || join(homedir(), ".minimal-ai");
export const PROFILE_DIR = join(DATA_DIR, "profiles");
export const LOG_DIR = join(DATA_DIR, "logs");
export const RUN_DIR = join(DATA_DIR, "run");
export const RUNTIME_DIR = join(DATA_DIR, "runtime");
export const MANAGED_LLAMA_SERVER = join(RUNTIME_DIR, "bin", "llama-server");
export const DATA_DIR_MARKER = join(DATA_DIR, ".minimal-ai-data");
export const DATA_DIR_MARKER_CONTENT = "minimal-ai-data-v1\n";

/** Return true only for a dedicated absolute data-directory path. */
export function isSafeDataDirPath(target, { homeDir = homedir(), cwd = process.cwd() } = {}) {
  if (typeof target !== "string" || !target || !isAbsolute(target)) return false;
  const candidate = resolve(target);
  const home = resolve(homeDir);
  const working = resolve(cwd);
  if (candidate === parse(candidate).root || candidate === home || candidate === working) return false;
  const contains = (parent, child) => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  return !contains(candidate, home) && !contains(candidate, working);
}
/** Resolve existing symlink components before applying the data-dir policy. */
export { resolvedDataDirPath };

// ── Default scan directories ──────────────────────────────────────────────

// HuggingFace hub cache: $HF_HUB_CACHE, else $HF_HOME/hub, else
// ~/.cache/huggingface/hub. This is where huggingface_hub stores
// models--org--name/... and where minimal-ai scans + downloads. Pointing at the
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
  if (!isSafeDataDirPath(DATA_DIR) || !isSafeDataDirPath(resolvedDataDirPath(DATA_DIR))) {
    throw new Error(`Refusing unsafe MINIMAL_DIR: ${DATA_DIR}. Choose a dedicated absolute data directory.`);
  }
  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(RUN_DIR, { recursive: true });
  await writeFile(DATA_DIR_MARKER, DATA_DIR_MARKER_CONTENT, { flag: "wx" }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
}

// ── User config ───────────────────────────────────────────────────────────

const CONFIG_PATH = join(DATA_DIR, "config.json");

const DEFAULT_CONFIG = {
  modelScanDirs: [],
  binaryOverrides: {},
  enable_benchmarking: false,
  lastSeenVersion: null,
};

export async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const config = { ...DEFAULT_CONFIG, ...parsed };
    // Validate types — wrong types in config.json should not crash at runtime
    if (config.modelScanDirs != null && !Array.isArray(config.modelScanDirs)) {
      config.modelScanDirs = [];
    }
    if (config.binaryOverrides != null && typeof config.binaryOverrides !== "object") {
      config.binaryOverrides = {};
    }
    if (typeof config.enable_benchmarking !== "boolean") config.enable_benchmarking = DEFAULT_CONFIG.enable_benchmarking;
    return config;
  } catch (error) {
    if (error?.code === "ENOENT") {
      // Auto-create config.json with defaults so the user can find and edit it
      await mkdir(dirname(CONFIG_PATH), { recursive: true });
      await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8").catch((err) => {
        console.warn(theme.subtle(`Warning: could not create config at ${CONFIG_PATH}: ${err.message}`));
      });
      return { ...DEFAULT_CONFIG };
    }
    throw new Error(
      `Failed to read config at ${CONFIG_PATH}: ${error.message}. ` +
      `Fix or remove the file, then try again.`,
      { cause: error }
    );
  }
}

export async function saveConfig(config) {
  await writeJson(CONFIG_PATH, config);
}

// ── Feature flags ──────────────────────────────────────────────────────────

/**
 * Dev flag for the unreleased benchmark feature.
 * Off by default — enable via config.json ("enable_benchmarking": true).
 * Flags are dev scaffolding: remove this once the feature ships.
 * @param {object} [config] - pre-loaded config (avoids redundant read)
 */
export async function benchmarkingEnabled(config) {
  const cfg = config ?? await loadConfig();
  return cfg.enable_benchmarking === true;
}

// ── Model scan directories ────────────────────────────────────────────────

export async function getModelScanDirs() {
  const config = await loadConfig();
  const dirs = [...DEFAULT_MODEL_DIRS, ...config.modelScanDirs];
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

import { execFileAsync, commandExists } from "./exec.mjs";

export async function findLlamaServer() {
  // 1. Env override
  if (process.env.LLAMA_SERVER_BINARY && existsSync(process.env.LLAMA_SERVER_BINARY)) {
    return process.env.LLAMA_SERVER_BINARY;
  }

  // 2. User config override
  const config = await loadConfig();
  const configured = config.binaryOverrides?.llamaServer ?? config.binaryOverrides?.["llama-server"];
  if (configured && existsSync(configured)) return configured;

  // 3. minimal-ai managed runtime
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
  return await commandExists("brew");
}