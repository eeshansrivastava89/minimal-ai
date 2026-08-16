import { spawn } from "node:child_process";
import { execCommand, execFileAsync, commandExists, sleep } from "./exec.mjs";
import { status, theme, screenHeader, card } from "./ui.mjs";
import { parseModelName } from "./model-name.mjs";
import { serverReady } from "./server-check.mjs";

export function parseOllamaHost() {
  const raw = process.env.OLLAMA_HOST;
  if (!raw) return { host: "127.0.0.1", port: 11434 };
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

export async function findOllama() {
  if (!(await commandExists("ollama"))) return null;
  try {
    const { stdout } = await execFileAsync("which", ["ollama"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function hasOllama() {
  return (await findOllama()) !== null;
}

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

export async function startOllamaServer() {
  const bin = await findOllama();
  if (!bin) throw new Error("Ollama is not installed");
  const child = spawn(bin, ["serve"], { detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

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

async function installOllamaFlow() {
  if (await hasOllama()) {
    console.log(status({ kind: "success", message: "Ollama is already installed." }));
    await startAndWaitForServer();
    return true;
  }

  try {
    console.log(theme.subtle("Installing Ollama via official installer..."));
    await execCommand("/bin/bash", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], { label: "ollama", verbose: true });
    if (await hasOllama()) {
      console.log(status({ kind: "success", message: "Ollama installed." }));
      await startAndWaitForServer();
      console.log(theme.subtle("  Run minimal-ai again to see Ollama models in the picker."));
      return true;
    }
  } catch { /* fall through to Homebrew */ }

  if (await commandExists("brew")) {
    try {
      console.log(theme.subtle("Installing Ollama via Homebrew..."));
      try {
        await execCommand("brew", ["install", "ollama"], { label: "ollama", verbose: true });
      } catch (brewErr) {
        if (await hasOllama()) {
          console.log(status({ kind: "warning", message: "Homebrew completed with warnings (link conflicts)." }));
          console.log(theme.subtle("  You may want to run: brew link --overwrite ollama"));
        } else {
          throw brewErr;
        }
      }
      if (await hasOllama()) {
        console.log(status({ kind: "success", message: "Ollama installed via Homebrew." }));
        await startAndWaitForServer();
        const version = await installedOllamaVersion();
        if (version) console.log(theme.subtle(`  Version: ${version}`));
        console.log(theme.subtle("  Run minimal-ai again to see Ollama models in the picker."));
        return true;
      }
    } catch (err) {
      console.log(status({ kind: "error", message: `Install failed: ${err.message}` }));
      console.log(theme.subtle("Do manually: curl -fsSL https://ollama.com/install.sh | sh  —  or  brew install ollama"));
      return false;
    }
  }

  console.log(status({ kind: "error", message: "Ollama was installed but not found on PATH." }));
  console.log(theme.subtle("Restart your terminal and run minimal-ai again."));
  return false;
}

export async function installOllama() {
  console.log(screenHeader({ title: "Ollama", subtitle: "local LLM runner" }));
  console.log(card({
    title: "About",
    body: "Source: https://github.com/ollama/ollama\nManages model downloads, loading, and unloading automatically.\nOn Apple Silicon, uses MLX backend for MLX models and llama.cpp for GGUF.",
  }));
  return await installOllamaFlow();
}

async function startAndWaitForServer() {
  try {
    await startOllamaServer();
  } catch { /* server may already be starting (macOS auto-start) */ }
  if (await serverReady(OLLAMA_V1_BASE)) return;
  process.stdout.write(theme.subtle("Starting Ollama server"));
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await serverReady(OLLAMA_V1_BASE)) break;
    process.stdout.write(".");
  }
  console.log("");
  if (await serverReady(OLLAMA_V1_BASE)) {
    console.log(status({ kind: "success", message: "Ollama server is running." }));
  } else {
    console.log(status({ kind: "warning", message: "Ollama server is starting up — it may take a few more seconds." }));
    console.log(theme.subtle("  Run minimal-ai again in a moment to see Ollama models."));
  }
}

export const OLLAMA_URLS = {
  v1: OLLAMA_V1_BASE,
  api: OLLAMA_API_BASE,
  defaultBaseUrl: OLLAMA_V1_BASE,
};

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

function parseOllamaName(ollamaName) {
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

export async function pullOllamaModel(modelRef) {
  const bin = await findOllama();
  if (!bin) throw new Error("Ollama is not installed");
  console.log(theme.subtle(`\nPulling ${modelRef}...`));
  try {
    await execCommand(bin, ["pull", modelRef], { label: "ollama pull", verbose: true });
    console.log(status({ kind: "success", message: `${modelRef} pulled.` }));
    return true;
  } catch (err) {
    console.log(status({ kind: "error", message: `Pull failed: ${err.message}` }));
    return false;
  }
}

export async function deleteOllamaModel(modelName) {
  const response = await fetch(`${OLLAMA_API_BASE}/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName }),
    signal: AbortSignal.timeout(10000),
  });
  if (response.ok) return "deleted";
  if (response.status === 404) return "missing";
  return "failed";
}

export async function unloadOllamaModel(modelName) {
  const response = await fetch(`${OLLAMA_API_BASE}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName, keep_alive: 0 }),
    signal: AbortSignal.timeout(10000),
  });
  return response.ok;
}

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
