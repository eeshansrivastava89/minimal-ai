import { findLlamaServer } from "./config.mjs";
import { scanGgufModels } from "./scan.mjs";
import { parseModelName } from "./model-name.mjs";
import { scanMlxModels } from "./mlx-discovery.mjs";
import { DEFAULT_PORT as MLX_VLM_PORT } from "./mlx-flags.mjs";

// ── Backend definitions ────────────────────────────────────────────────────

export const LOCAL_HOST = "127.0.0.1";
export const LLAMA_CPP_PORT = 8080;
export const LLAMA_CPP_MTP_PORT = 8081;
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
  "mlx-vlm": {
    id: "mlx-vlm",
    label: "mlx-vlm",
    type: "local-server",
    providerId: "mlx-vlm",
    defaultHost: LOCAL_HOST,
    defaultPort: MLX_VLM_PORT,
    defaultBaseUrl: baseUrlFor({ port: MLX_VLM_PORT }),
    needsCommandFile: true,
    scanModels: async () => scanMlxModels(),
  },
};

export function backendFor(backendId) {
  const backend = BACKENDS[backendId ?? "llama-cpp"];
  if (!backend) throw new Error(`Unknown backend: ${backendId}`);
  return backend;
}

export async function backendBinaryFor(backendId) {
  const backend = BACKENDS[backendId ?? "llama-cpp"];
  if (backend.id === "mlx-vlm") return "python3"; // mlx-vlm spawns via python3 + the strict=False wrapper
  if (backend.type === "managed-server") return null;
  const discovered = await findLlamaServer();
  return discovered; // null means "not found — trigger onboarding"
}

export function defaultFlagsForBackend(backendId) {
  const backend = backendFor(backendId);
  return { host: backend.defaultHost ?? LOCAL_HOST, port: backend.defaultPort };
}

// ── oMLX model discovery ───────────────────────────────────────────────

async function scanOmlxModels() {
  const response = await fetch(`${BACKENDS.omlx.defaultBaseUrl}/models`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) {
    throw new Error(`oMLX /models returned ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (!Array.isArray(body?.data)) return [];
  return body.data
    .filter((model) => isChatOmlxModel(model))
    .map((model) => ({
      id: model.id,
      label: parseModelName(model.id, "omlx").display,
      aliasSuggestion: model.id,
      sizeBytes: model.size ?? 0,
      contextLength: model.max_model_len ?? null,
      quant: null,
      family: null,
      backend: "omlx",
      source: "omlx",
    })).sort((a, b) => a.label.localeCompare(b.label));
}

// ── Labels ──────────────────────────────────────────────────────────────

function isChatOmlxModel(model) {
  if (typeof model?.id !== "string" || !model.id.trim()) return false;
  const type = String(model.type ?? model.model_type ?? "").toLowerCase();
  if (["embedding", "embeddings", "reranker", "tool", "converter", "markitdown"].includes(type)) return false;
  if (Object.hasOwn(model, "max_model_len") && model.max_model_len === null) return false;
  return true;
}

// (ollamaLabel and omlxLabel removed — parseModelName in model-name.mjs is the single path)
// (Ollama backend removed — offgrid-ai now uses llama-server + mlx-vlm + oMLX)