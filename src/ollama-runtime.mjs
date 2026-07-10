// Ollama runtime management — discovery, version checking, installation, model scanning.
//
// Ollama is a daemon on port 11434 that manages local LLM models. It provides
// both OpenAI-compatible (/v1/*) and native (/api/*) APIs. On Apple Silicon,
// Ollama 0.19+ auto-selects between GGUF (llama.cpp) and MLX backends.
// offgrid-ai treats Ollama as a managed-server backend: the daemon stays up,
// models auto-load on request and auto-unload after idle timeout.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { runCommand, execFileAsync } from "./exec.mjs";
import { pc, formatBytes } from "./ui.mjs";
import { parseModelName } from "./model-name.mjs";

const OLLAMA_PORT = 11434;
const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_V1_BASE = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/v1`;
const OLLAMA_API_BASE = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api`;
const RELEASE_API = "https://api.github.com/repos/ollama/ollama/releases/latest";

// ── Discovery ──────────────────────────────────────────────────────────────

/** Find the ollama binary — checks PATH. */
export async function findOllama() {
  try {
    const { stdout } = await execFileAsync("which", ["ollama"]);
    const path = stdout.trim();
    if (path && existsSync(path)) return path;
  } catch { /* not on PATH */ }
  return null;
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
  if (await serverReady()) return true;
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
 * Install Ollama via Homebrew (preferred) or the official curl installer.
 * @returns {Promise<boolean>} true if installation succeeded
 */
export async function installOllama() {
  console.log(pc.cyan("\nOllama — local LLM runner"));
  console.log(pc.dim("  Source: https://github.com/ollama/ollama"));
  console.log(pc.dim("  Manages model downloads, loading, and unloading automatically."));
  console.log(pc.dim("  On Apple Silicon, uses MLX backend for MLX models and llama.cpp for GGUF.\n"));

  // 1. Homebrew (preferred — handles updates, daemon management)
  try {
    const { stdout } = await execFileAsync("which", ["brew"]);
    if (stdout.trim()) {
      console.log(pc.dim("Installing Ollama via Homebrew..."));
      await runCommand("brew", ["install", "ollama"], { label: "ollama", verbose: true });
      if (await hasOllama()) {
        console.log(pc.green("✓ Ollama installed via Homebrew."));
        await startOllamaServer().catch(() => {});
        const version = await installedOllamaVersion();
        console.log(pc.green(`\n✓ Ollama ${version ? `v${version} ` : ""}installed`));
        console.log(pc.dim("  Run offgrid-ai again to see Ollama models in the picker."));
        return true;
      }
    }
  } catch { /* fall through to curl installer */ }

  // 2. Official curl installer
  try {
    console.log(pc.dim("Installing Ollama via official installer..."));
    await runCommand("/bin/bash", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], { label: "ollama", verbose: true });
    if (await hasOllama()) {
      console.log(pc.green("✓ Ollama installed."));
      await startOllamaServer().catch(() => {});
      return true;
    }
  } catch (err) {
    console.log(pc.red(`✗ Installation failed: ${err.message}`));
    console.log(pc.dim("Install manually: brew install ollama  —  or  curl -fsSL https://ollama.com/install.sh | sh"));
    return false;
  }

  console.log(pc.red("✗ Ollama was installed but not found on PATH."));
  console.log(pc.dim("Restart your terminal and run offgrid-ai again."));
  return false;
}

// ── Model scanning ─────────────────────────────────────────────────────────

/** Base URLs for Ollama API access. */
export const OLLAMA_URLS = {
  v1: OLLAMA_V1_BASE,
  api: OLLAMA_API_BASE,
  defaultBaseUrl: OLLAMA_V1_BASE,
};

/** Check if the Ollama server is responding. */
export async function serverReady() {
  try {
    const response = await fetch(`${OLLAMA_V1_BASE}/models`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Scan local Ollama models via GET /api/tags.
 * Returns models in the same format as other backend scanners.
 */
export async function scanOllamaModels() {
  const response = await fetch(`${OLLAMA_API_BASE}/tags`, { signal: AbortSignal.timeout(3000) });
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
    await runCommand(bin, ["pull", modelRef], { label: "ollama pull", verbose: true });
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