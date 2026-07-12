// Ollama runtime management — discovery, version checking, installation, model scanning.
//
// Ollama is a daemon on port 11434 that manages local LLM models. It provides
// both OpenAI-compatible (/v1/*) and native (/api/*) APIs. On Apple Silicon,
// Ollama 0.19+ auto-selects between GGUF (llama.cpp) and MLX backends.
// offgrid-ai treats Ollama as a managed-server backend: the daemon stays up,
// models auto-load on request and auto-unload after idle timeout.

import { spawn } from "node:child_process";
import { execCommand, execFileAsync, commandExists, sleep } from "./exec.mjs";
import { pc } from "./ui.mjs";
import { parseModelName } from "./model-name.mjs";
import { serverReady } from "./server-check.mjs";

// Respect OLLAMA_HOST env var (same as Ollama itself). Format: "host:port"
// or just "host" (defaults to port 11434). Falls back to 127.0.0.1:11434.
function parseOllamaHost() {
  const raw = process.env.OLLAMA_HOST;
  if (!raw) return { host: "127.0.0.1", port: 11434 };
  // Handle "host:port" or just "host"
  const colonIdx = raw.lastIndexOf(":");
  if (colonIdx > 0 && /^\d+$/.test(raw.slice(colonIdx + 1))) {
    return { host: raw.slice(0, colonIdx), port: Number(raw.slice(colonIdx + 1)) };
  }
  return { host: raw, port: 11434 };
}

const { host: OLLAMA_HOST, port: OLLAMA_PORT } = parseOllamaHost();
const OLLAMA_V1_BASE = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/v1`;
const OLLAMA_API_BASE = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api`;
const RELEASE_API = "https://api.github.com/repos/ollama/ollama/releases/latest";

// ── Discovery ──────────────────────────────────────────────────────────────

/** Find the ollama binary — checks PATH. */
export async function findOllama() {
  if (!(await commandExists("ollama"))) return null;
  try {
    const { stdout } = await execFileAsync("which", ["ollama"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Check if Ollama is installed. */
export async function hasOllama() {
  return (await findOllama()) !== null;
}

// ── Version checking ───────────────────────────────────────────────────────

/** Get installed Ollama version via `ollama --version`. */
async function installedOllamaVersion() {
  const bin = await findOllama();
  if (!bin) return null;
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { timeout: 5000 });
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Check if a newer Ollama release is available. Returns { installed, latest } or null. */
export async function checkOllamaUpdate() {
  const installed = await installedOllamaVersion();
  if (!installed) return null;
  try {
    const response = await fetch(RELEASE_API, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const release = await response.json();
    const latest = release.tag_name?.replace(/^v/u, "");
    if (!latest || installed === latest) return null;
    return { installed, latest };
  } catch {
    return null;
  }
}

// ── Server lifecycle ───────────────────────────────────────────────────────

/**
 * Start the Ollama server via `ollama serve` (detached).
 * On macOS with the DMG install, Ollama auto-starts as a helper app.
 * On Linux or brew install, `ollama serve` must be started explicitly.
 * This is non-blocking — the caller's wait loop handles readiness.
 */
export async function startOllamaServer() {
  const bin = await findOllama();
  if (!bin) throw new Error("Ollama is not installed");
  const child = spawn(bin, ["serve"], { detached: true, stdio: "ignore" });
  child.unref();
}

/** Offer to start Ollama if not running. */
export async function ensureOllamaServer() {
  if (await serverReady(OLLAMA_V1_BASE)) return true;
  const bin = await findOllama();
  if (!bin) throw new Error("Ollama is not installed");
  try {
    await startOllamaServer();
  } catch (err) {
    throw new Error(`Ollama could not be started: ${err.message}. Run \`ollama serve\` manually.`, { cause: err });
  }
  return false;
}

// ── Installation ────────────────────────────────────────────────────────────

/**
 * Install or update Ollama via Homebrew (preferred) or the official curl installer.
 * @param {object} options
 * @param {boolean} options.upgrade - true for update (brew upgrade), false for install (brew install)
 * @returns {Promise<boolean>} true if Ollama is available after the operation
 */
async function installOrUpdateOllama({ upgrade = false } = {}) {
  if (!upgrade && await hasOllama()) {
    console.log(pc.green("Ollama is already installed."));
    await startAndWaitForServer();
    return true;
  }

  const verb = upgrade ? "Updating" : "Installing";
  const brewCmd = upgrade ? "upgrade" : "install";

  // 1. Official curl installer (more reliable — includes all binaries)
  try {
    console.log(pc.dim(`${verb} Ollama via official installer...`));
    await execCommand("/bin/bash", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], { label: "ollama", verbose: true });
    if (await hasOllama()) {
      console.log(pc.green(`✓ Ollama ${upgrade ? "updated" : "installed"}.`));
      await startAndWaitForServer();
      if (!upgrade) console.log(pc.dim("  Run offgrid-ai again to see Ollama models in the picker."));
      return true;
    }
  } catch { /* fall through to Homebrew */ }

  // 2. Homebrew (fallback)
  if (await commandExists("brew")) {
    try {
      console.log(pc.dim(`${verb} Ollama via Homebrew...`));
      try {
        await execCommand("brew", [brewCmd, "ollama"], { label: "ollama", verbose: true });
      } catch (brewErr) {
        if (await hasOllama()) {
          console.log(pc.yellow("Homebrew completed with warnings (link conflicts)."));
          console.log(pc.dim("  You may want to run: brew link --overwrite ollama"));
        } else {
          throw brewErr;
        }
      }
      if (await hasOllama()) {
        console.log(pc.green(`✓ Ollama ${upgrade ? "updated" : "installed"} via Homebrew.`));
        await startAndWaitForServer();
        const version = await installedOllamaVersion();
        if (version) console.log(pc.dim(`  Version: ${version}`));
        if (!upgrade) console.log(pc.dim("  Run offgrid-ai again to see Ollama models in the picker."));
        return true;
      }
    } catch (err) {
      console.log(pc.red(`✗ ${verb} failed: ${err.message}`));
      console.log(pc.dim(`Do manually: curl -fsSL https://ollama.com/install.sh | sh  —  or  brew ${brewCmd} ollama`));
      return false;
    }
  }

  console.log(pc.red(`✗ Ollama was ${upgrade ? "updated" : "installed"} but not found on PATH.`));
  console.log(pc.dim("Restart your terminal and run offgrid-ai again."));
  return false;
}

/** Update Ollama to the latest version. */
export async function updateOllama() {
  return await installOrUpdateOllama({ upgrade: true });
}

/**
 * Install Ollama. If already installed, just starts the server.
 * @returns {Promise<boolean>} true if installation succeeded
 */
export async function installOllama() {
  console.log(pc.cyan("\nOllama — local LLM runner"));
  console.log(pc.dim("  Source: https://github.com/ollama/ollama"));
  console.log(pc.dim("  Manages model downloads, loading, and unloading automatically."));
  console.log(pc.dim("  On Apple Silicon, uses MLX backend for MLX models and llama.cpp for GGUF.\n"));
  return await installOrUpdateOllama({ upgrade: false });
}

/** Start the Ollama server and wait for it to be ready (up to 30s). */
async function startAndWaitForServer() {
  try {
    await startOllamaServer();
  } catch { /* server may already be starting (macOS auto-start) */ }
  if (await serverReady(OLLAMA_V1_BASE)) return;
  process.stdout.write(pc.dim("Starting Ollama server"));
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await serverReady(OLLAMA_V1_BASE)) break;
    process.stdout.write(".");
  }
  console.log("");
  if (await serverReady(OLLAMA_V1_BASE)) {
    console.log(pc.green("✓ Ollama server is running."));
  } else {
    console.log(pc.yellow("Ollama server is starting up — it may take a few more seconds."));
    console.log(pc.dim("  Run offgrid-ai again in a moment to see Ollama models."));
  }
}

// ── Model scanning ─────────────────────────────────────────────────────────

/** Base URLs for Ollama API access. */
export const OLLAMA_URLS = {
  v1: OLLAMA_V1_BASE,
  api: OLLAMA_API_BASE,
  defaultBaseUrl: OLLAMA_V1_BASE,
};

/**
 * Scan local Ollama models via GET /api/tags.
 * Returns models in the same format as other backend scanners.
 */
export async function scanOllamaModels() {
  const response = await fetch(`${OLLAMA_API_BASE}/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Ollama /api/tags returned ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.models)) return [];

  return body.models
    .filter(isChatOllamaModel)
    .map((model) => {
      const name = model.name ?? model.model ?? "";
      const parsed = parseOllamaName(name);
      return {
        id: name,
        label: parsed.display,
        aliasSuggestion: name,
        sizeBytes: model.size ?? 0,
        contextLength: null,
        quant: parsed.quant ?? (model.details?.quantization_level ?? null),
        family: model.details?.family ?? null,
        backend: "ollama",
        source: "ollama",
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function isChatOllamaModel(model) {
  if (typeof model?.name !== "string" || !model.name.trim()) return false;
  return true;
}

/** Parse an Ollama model name into display name + quant. */
function parseOllamaName(ollamaName) {
  // Ollama library: "qwen3:8b" or "gemma4:27b"
  // HuggingFace: "hf.co/org/model:Q4_K_M"
  if (ollamaName.startsWith("hf.co/")) {
    const rest = ollamaName.slice("hf.co/".length);
    return parseModelName(rest, "huggingface");
  }
  const colonIdx = ollamaName.indexOf(":");
  const baseName = colonIdx !== -1 ? ollamaName.slice(0, colonIdx) : ollamaName;
  const tag = colonIdx !== -1 ? ollamaName.slice(colonIdx + 1) : null;
  const parsed = parseModelName(baseName, "local-gguf");
  return { ...parsed, quant: tag || parsed.quant };
}

/**
 * Get detailed model info via POST /api/show.
 * Returns capabilities (vision, tools), parameters, and details.
 */
export async function ollamaModelInfo(modelName) {
  const response = await fetch(`${OLLAMA_API_BASE}/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Ollama /api/show returned ${response.status}`);
  return await response.json();
}

// ── Model management ────────────────────────────────────────────────────────

/**
 * Pull a model via `ollama pull`. Streams progress to stdout.
 * For HuggingFace: ollama pull hf.co/org/model:quant
 * For Ollama library: ollama pull model:tag
 * @returns {Promise<boolean>} true if pull succeeded
 */
export async function pullOllamaModel(modelRef) {
  const bin = await findOllama();
  if (!bin) throw new Error("Ollama is not installed");
  console.log(pc.dim(`\nPulling ${modelRef}...`));
  try {
    await execCommand(bin, ["pull", modelRef], { label: "ollama pull", verbose: true });
    console.log(pc.green(`\n✓ ${modelRef} pulled.`));
    return true;
  } catch (err) {
    console.log(pc.red(`\n✗ Pull failed: ${err.message}`));
    return false;
  }
}

/**
 * Delete a model via DELETE /api/delete.
 * @returns {Promise<boolean>} true if deletion succeeded
 */
export async function deleteOllamaModel(modelName) {
  const response = await fetch(`${OLLAMA_API_BASE}/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName }),
    signal: AbortSignal.timeout(10000),
  });
  return response.ok;
}

/**
 * Unload a model from memory by sending a request with keep_alive: 0.
 * This tells Ollama to release the model weights from memory.
 */
export async function unloadOllamaModel(modelName) {
  const response = await fetch(`${OLLAMA_API_BASE}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName, keep_alive: 0 }),
    signal: AbortSignal.timeout(10000),
  });
  return response.ok;
}

/**
 * List currently loaded models via GET /api/ps.
 * Returns an array of model names currently in memory.
 */
export async function ollamaLoadedModels() {
  try {
    const response = await fetch(`${OLLAMA_API_BASE}/ps`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return [];
    const body = await response.json();
    if (!Array.isArray(body?.models)) return [];
    return body.models.map((m) => m.name ?? m.model ?? "").filter(Boolean);
  } catch {
    return [];
  }
}