// API client — thin fetch wrappers over the hub's read endpoints.
// Used through TanStack Query; every function throws on non-2xx.

import type {
  AutotuneRun,
  BackendStatus,
  Benchmark,
  Job,
  LogEntry,
  MachineInfo,
  MemoryHeatmap,
  ModelDetail,
  ModelsResponse,
  Profile,
  Run,
  SetupInfo,
} from "@/data/types";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `${res.status} ${res.statusText}`);
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
  setup: (ref: string) => get<SetupInfo>(`/api/models/${seg(ref)}/setup`),
  autotune: (ref: string) => get<AutotuneRun | null>(`/api/models/${seg(ref)}/autotune`),
  modelRuns: (ref: string) => get<Run[]>(`/api/models/${seg(ref)}/runs`),
  modelLogs: (ref: string) => get<LogEntry[]>(`/api/models/${seg(ref)}/logs`),
  runs: () => get<Run[]>("/api/runs"),
  allAutotune: () => get<AutotuneRun[]>("/api/autotune"),
  benchmarks: () => get<Benchmark[]>("/api/benchmarks"),

  // ── Jobs (Phase 3) ─────────────────────────────────────────────────────────
  jobs: () => get<Job[]>("/api/jobs"),
  jobLog: async (id: string): Promise<string> => (await fetch(`/api/jobs/${seg(id)}/log`)).text(),
  enqueueDownload: (repo: string, filename?: string | null) =>
    send<Job>("/api/jobs", "POST", { type: "download", title: `Download ${repo}`, payload: { repo, filename: filename ?? null } }),
  cancelJob: (id: string) => send<unknown>(`/api/jobs/${seg(id)}/cancel`, "POST"),
  restartJob: (id: string) => send<Job>(`/api/jobs/${seg(id)}/restart`, "POST"),

  // ── Model write actions (Phase 3) ────────────────────────────────────────
  launchModel: (ref: string, opts?: { message?: string; keepServer?: boolean }) =>
    send<Job>(`/api/models/${seg(ref)}/launch`, "POST", opts ?? {}),
  setupProfile: (ref: string, form: Record<string, unknown>) =>
    send<Job>(`/api/models/${seg(ref)}/profile`, "PUT", form),
  removeProfile: (ref: string) => send<unknown>(`/api/models/${seg(ref)}/profile`, "DELETE"),
  openTerminal: (ref: string) =>
    send<{ opened: boolean; scriptPath: string }>(`/api/models/${seg(ref)}/terminal`, "POST"),
  hfQuants: (repo: string) =>
    get<{ repo: string; files: { path: string; sizeBytes: number }[] }>(`/api/hf/quants?repo=${seg(repo)}`),
};
