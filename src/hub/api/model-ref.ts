// ModelRef — one canonical model identity across the hub. Profiles, runs,
// sweeps and URLs all key on it. Composite URL-safe form: "backend:<id>"
// with the id percent-encoded (model ids can contain "/"), e.g.
// "omlx:mlx-community%2FQwen3-8B-4bit". Backend is a prefix, never a URL
// path segment (entity-spine law).

export const BACKEND_IDS = ["omlx", "ollama", "llama-cpp"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

export interface ModelRef {
  backend: BackendId;
  id: string;
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.backend}:${encodeURIComponent(ref.id)}`;
}

export function parseModelRef(raw: string): ModelRef | null {
  const i = raw.indexOf(":");
  if (i < 1) return null;
  const backend = raw.slice(0, i) as BackendId;
  if (!BACKEND_IDS.includes(backend)) return null;
  let id: string;
  try {
    id = decodeURIComponent(raw.slice(i + 1));
  } catch {
    return null;
  }
  return id ? { backend, id } : null;
}
