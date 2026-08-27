import { findLlamaServer } from "./config.mjs";
import { parseModelName } from "./model-name.mjs";
import { scanOmlxModelSizes, lookupOmlxModelInfo } from "./mlx-discovery.mjs";
import { scanOllamaModels, parseOllamaHost } from "./ollama-runtime.mjs";

// ── Backend definitions ────────────────────────────────────────────────────
//
// Data-only registry. MANAGED behavior (start/apply/unload/loaded checks)
// lives in managed-backends.mjs keyed by these objects (A2); this module
// only carries the pure context-window precedence so harness-shared can
// depend on it cycle-free.

const LOCAL_HOST = "127.0.0.1";
const LLAMA_CPP_PORT = 8080;
const OMLX_PORT = 8000;

function baseUrlFor({ host = LOCAL_HOST, port, path = "/v1" }) {
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
    scanModels: async () => (await (await import("./scan.mjs")).scanGgufModels()).models,
    modelIdFields: ["modelAlias"],
    contextWindowFor: (profile, caps) => profile.flags?.ctxSize ?? caps.contextLength ?? null,
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
    modelIdFields: ["omlxModel", "modelAlias"],
    contextWindowFor: (profile, caps) => caps.contextLength ?? profile.flags?.ctxSize ?? null,
  },
  "ollama": {
    id: "ollama",
    label: "Ollama",
    type: "managed-server",
    providerId: "ollama",
    defaultHost: parseOllamaHost().host,
    defaultPort: parseOllamaHost().port,
    defaultBaseUrl: baseUrlFor({ host: parseOllamaHost().host, port: parseOllamaHost().port }),
    apiBaseUrl: baseUrlFor({ host: parseOllamaHost().host, port: parseOllamaHost().port, path: "" }),
    needsCommandFile: false,
    scanModels: () => scanOllamaModels(),
    modelIdFields: ["ollamaModel", "modelAlias"],
    contextWindowFor: (profile, caps) => caps.servedContext ?? profile.flags?.ctxSize ?? caps.contextLength ?? null,
  },
};

export function backendFor(backendId) {
  const backend = BACKENDS[backendId ?? "llama-cpp"];
  if (!backend) throw new Error(`Unknown backend: ${backendId}`);
  return backend;
}

/** The managed-server backend entries (oMLX, Ollama, …) — derived from the
 *  registry, so managed.mjs and friends never keep a hardcoded list. */
export function managedBackends() {
  return Object.values(BACKENDS).filter((backend) => backend.type === "managed-server");
}

export async function backendBinaryFor(backendId) {
  const backend = BACKENDS[backendId ?? "llama-cpp"];
  if (backend.type === "managed-server") return null;
  return await findLlamaServer();
}

export function defaultFlagsForBackend(backendId) {
  const backend = backendFor(backendId);
  return { host: backend.defaultHost ?? LOCAL_HOST, port: backend.defaultPort };
}

// ── oMLX model discovery ───────────────────────────────────────────────

async function scanOmlxModels() {
  const response = await fetch(`${BACKENDS.omlx.defaultBaseUrl}/models`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`oMLX /models returned ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (!Array.isArray(body?.data)) return [];

  const infoMap = await scanOmlxModelSizes();

  // Deduplicate by normalized full name (publisher/model with / separator)
  const seen = new Set();
  const deduped = [];
  for (const model of body.data.filter(isChatOmlxModel)) {
    const info = lookupOmlxModelInfo(model.id, infoMap);
    // Exclude standalone MTP drafters (model_type ends with _mtp) and DFlash
    // draft checkpoints (flagged from config.json during the disk scan).
    if (info?.modelType && info.modelType.toLowerCase().endsWith("_mtp")) continue;
    if (info?.drafter) continue;
    const hasPublisher = model.id.includes("/") || model.id.includes("--");
    const fullName = (!hasPublisher && info?.publisher) ? `${info.publisher}/${model.id}` : model.id;
    const normalized = fullName.replace(/--/g, "/");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(model);
  }

  return deduped
    .map((model) => {
      const info = lookupOmlxModelInfo(model.id, infoMap);
      const hasPublisher = model.id.includes("/") || model.id.includes("--");
      const fullName = (!hasPublisher && info?.publisher) ? `${info.publisher}/${model.id}` : model.id;
      const parsed = parseModelName(fullName, "omlx");
      return {
        id: model.id,
        label: parsed.display,
        aliasSuggestion: model.id,
        sizeBytes: info?.sizeBytes ?? (model.size ?? 0),
        contextLength: model.max_model_len ?? null,
        quant: parsed.quant,
        family: null,
        backend: "omlx",
        source: "omlx",
      };
    }).sort((a, b) => a.label.localeCompare(b.label));
}

function isChatOmlxModel(model) {
  if (typeof model?.id !== "string" || !model.id.trim()) return false;
  const type = String(model.type ?? model.model_type ?? "").toLowerCase();
  if (["embedding", "embeddings", "reranker", "tool", "converter", "markitdown"].includes(type)) return false;
  if (type.endsWith("_mtp")) return false; // standalone MTP drafter, not a chat model
  if (Object.hasOwn(model, "max_model_len") && model.max_model_len === null) return false;
  return true;
}