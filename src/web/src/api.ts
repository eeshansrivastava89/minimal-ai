// API client — thin fetch wrappers over the hub's read endpoints.
// Used through TanStack Query; every function throws on non-2xx.

import type {
  AutotuneRun,
  BackendStatus,
  Benchmark,
  LogEntry,
  MachineInfo,
  ModelDetail,
  ModelsResponse,
  Profile,
  MemoryHeatmap,
  Run,
} from "@/data/types";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// Refs arrive decoded from router params (llama-cpp refs contain slashes) —
// always re-encode before putting one in a URL path segment.
const seg = encodeURIComponent;

export const api = {
  machine: () => get<MachineInfo>("/api/machine"),
  backends: () => get<BackendStatus[]>("/api/backends"),
  models: () => get<ModelsResponse>("/api/models"),
  model: (ref: string) => get<ModelDetail>(`/api/models/${seg(ref)}`),
  setup: (ref: string) =>
    get<{ ref: string; heatmap: MemoryHeatmap | null; profile?: Profile }>(`/api/models/${seg(ref)}/setup`),
  autotune: (ref: string) => get<AutotuneRun | null>(`/api/models/${seg(ref)}/autotune`),
  modelRuns: (ref: string) => get<Run[]>(`/api/models/${seg(ref)}/runs`),
  modelLogs: (ref: string) => get<LogEntry[]>(`/api/models/${seg(ref)}/logs`),
  runs: () => get<Run[]>("/api/runs"),
  allAutotune: () => get<AutotuneRun[]>("/api/autotune"),
  benchmarks: () => get<Benchmark[]>("/api/benchmarks"),
};
