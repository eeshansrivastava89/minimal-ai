import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { pc } from "./ui.mjs";

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
  // Dedupe (a user may list a default dir explicitly) so we never scan twice.
  return [...DEFAULT_MODEL_DIRS, ...config.modelScanDirs].filter((dir, i, arr) => arr.indexOf(dir) === i);
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

/**
 * Install Homebrew non-interactively and add it to PATH for this process.
 * Returns true if Homebrew is available after installation.
 */
export async function installHomebrew(run) {
  await run("/bin/bash", ["-c", 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'], "Homebrew");
  for (const path of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    if (existsSync(path)) {
      process.env.PATH = `${path}:${process.env.PATH}`;
      break;
    }
  }
  return await hasHomebrew();
}

/**
 * Ensure Homebrew is installed, prompting the user if necessary.
 * @param {object} prompt - UI prompt interface (needs yesNo)
 * @param {function} run - runCommand function for verbose command execution
 * @param {string} label - what we're installing (for the prompt message)
 * @returns {Promise<boolean>} true if Homebrew is available
 */
export async function ensureHomebrewFor(prompt, run, label) {
  if (await hasHomebrew()) return true;
  const install = await prompt.yesNo(`Homebrew is needed to install ${label}. Install Homebrew now?`, true);
  if (!install) {
    console.log(pc.dim(`Install ${label} manually, or install Homebrew from https://brew.sh and run offgrid-ai again.`));
    return false;
  }
  console.log(pc.cyan("Installing Homebrew..."));
  try {
    const success = await installHomebrew(run);
    if (!success) {
      console.log(pc.red("Homebrew was installed but not found on PATH. Restart your terminal and run offgrid-ai again."));
      return false;
    }
  } catch {
    console.log(pc.red("✗ Homebrew installation failed."));
    console.log(pc.dim("Install it manually from https://brew.sh, then run offgrid-ai again."));
    return false;
  }
  console.log(pc.green("✓ Homebrew found"));
  return true;
}