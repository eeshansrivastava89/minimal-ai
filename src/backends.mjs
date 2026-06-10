import { findLlamaServer } from "./config.mjs";
import { scanGgufModels } from "./scan.mjs";

// ── Backend definitions ────────────────────────────────────────────────────

export const LOCAL_HOST = "127.0.0.1";
export const LLAMA_CPP_PORT = 8080;
export const LLAMA_CPP_MTP_PORT = 8081;
export const OLLAMA_PORT = 11434;
export const OMLX_PORT = 8000;

export function baseUrlFor({ host = LOCAL_HOST, port, path = "/v1" }) {
  return `http://${host}:${port}${path}`;
}

export function baseUrlForFlags(flags) {
  return baseUrlFor({ host: flags.host, port: flags.port });
}

export const BACKENDS = {
  "llama-cpp": {
    id: "llama-cpp",
    label: "llama.cpp",
    type: "local-server",
    providerId: "llama-cpp",
    defaultHost: LOCAL_HOST,
    defaultPort: LLAMA_CPP_PORT,
    defaultBaseUrl: baseUrlFor({ port: LLAMA_CPP_PORT }),
    needsCommandFile: true,
    scanModels: async () => (await scanGgufModels()).models,
  },
  "llama-cpp-mtp": {
    id: "llama-cpp-mtp",
    label: "llama.cpp MTP",
    type: "local-server",
    providerId: "llama-cpp-mtp",
    defaultHost: LOCAL_HOST,
    defaultPort: LLAMA_CPP_MTP_PORT,
    defaultBaseUrl: baseUrlFor({ port: LLAMA_CPP_MTP_PORT }),
    needsCommandFile: true,
    scanModels: async () => (await scanGgufModels()).models,
  },
  "ollama": {
    id: "ollama",
    label: "Ollama",
    type: "managed-server",
    providerId: "ollama",
    defaultHost: "localhost",
    defaultPort: OLLAMA_PORT,
    defaultBaseUrl: baseUrlFor({ host: "localhost", port: OLLAMA_PORT }),
    apiBaseUrl: baseUrlFor({ host: "localhost", port: OLLAMA_PORT, path: "" }),
    needsCommandFile: false,
    scanModels: () => scanOllamaModels(),
  },
  "omlx": {
    id: "omlx",
    label: "oMLX",
    type: "managed-server",
    providerId: "omlx",
    defaultHost: LOCAL_HOST,
    defaultPort: OMLX_PORT,
    defaultBaseUrl: baseUrlFor({ port: OMLX_PORT }),
    apiBaseUrl: baseUrlFor({ port: OMLX_PORT, path: "" }),
    needsCommandFile: false,
    scanModels: () => scanOmlxModels(),
  },
};

export function backendFor(backendId) {
  const backend = BACKENDS[backendId ?? "llama-cpp"];
  if (!backend) throw new Error(`Unknown backend: ${backendId}`);
  return backend;
}

export async function backendBinaryFor(backendId) {
  const backend = BACKENDS[backendId ?? "llama-cpp"];
  if (backend.type === "managed-server") return null;
  const discovered = await findLlamaServer();
  return discovered; // null means "not found — trigger onboarding"
}

export function defaultFlagsForBackend(backendId) {
  const backend = backendFor(backendId);
  return { host: backend.defaultHost ?? LOCAL_HOST, port: backend.defaultPort };
}

// ── Ollama model discovery ──────────────────────────────────────────────

async function scanOllamaModels() {
  try {
    const response = await fetch(`${BACKENDS.ollama.apiBaseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return [];
    const body = await response.json();
    if (!Array.isArray(body?.models)) return [];
    return body.models
      .filter((model) => isLocalOllamaModel(model))
      .map((model) => ({
        id: model.name,
        label: ollamaLabel(model.name),
        aliasSuggestion: model.name,
        sizeBytes: model.size ?? 0,
        quant: model.details?.quantization_level,
        family: model.details?.family,
        backend: "ollama",
        source: "ollama",
      })).sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    return [];
  }
}

// ── oMLX model discovery ───────────────────────────────────────────────

async function scanOmlxModels() {
  try {
    const response = await fetch(`${BACKENDS.omlx.defaultBaseUrl}/models`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return [];
    const body = await response.json();
    if (!Array.isArray(body?.data)) return [];
    return body.data.map((model) => ({
      id: model.id,
      label: omlxLabel(model.id),
      aliasSuggestion: model.id,
      sizeBytes: 0,
      quant: null,
      family: null,
      backend: "omlx",
      source: "omlx",
    })).sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    return [];
  }
}

// ── Labels ──────────────────────────────────────────────────────────────

function isLocalOllamaModel(model) {
  const name = String(model?.name ?? "");
  if (/:cloud(?:$|\b)/i.test(name)) return false;
  if (!Number.isFinite(model?.size) || model.size <= 0) return false;
  return true;
}

function ollamaLabel(name) {
  return name.replace(/[-_]/g, " ").replace(/^gemma\b/i, "Gemma").replace(/^qwen/i, "Qwen");
}

function omlxLabel(id) {
  return id.replace(/[-_]/g, " ").replace(/^gemma-4/i, "Gemma 4").replace(/^qwen/i, "Qwen");
}