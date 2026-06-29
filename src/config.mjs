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

export const DEFAULT_MODEL_DIRS = [
  join(homedir(), ".lmstudio", "models"),
  process.env.HF_HOME || join(homedir(), ".cache", "huggingface"),
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
  benchmarkRepoPath: null,
  binaryOverrides: {},
};

export async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (error) {
    if (error?.code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw new Error(
      `Failed to read config at ${CONFIG_PATH}: ${error.message}. ` +
      `Fix or remove the file, then try again.`,
      { cause: error }
    );
  }
}

export async function saveConfig(config) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ── Model scan directories ────────────────────────────────────────────────

export async function getModelScanDirs() {
  const config = await loadConfig();
  return [...DEFAULT_MODEL_DIRS, ...config.modelScanDirs];
}

// ── Binary discovery ──────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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