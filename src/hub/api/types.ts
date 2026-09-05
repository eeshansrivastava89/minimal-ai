// Shared API types — the typed seam between hub server and web client.
// Reads only in Phase 2; write endpoints (Phase 3+) get Zod DTOs.
// The web client imports these via the "@hub/*" alias; the server's
// data.ts builds them from the live service layer.

// ── Entities ────────────────────────────────────────────────────────────────

export interface Profile {
  id: string;
  label: string;
  backend: string;
  providerId: string; // the harness-side provider id (pi --model providerId/modelAlias)
  modelAlias: string;
  modelSizeBytes?: number;
  baseUrl: string;
  thinkingLevel?: string;
  thinkingOff?: boolean;
  source?: string;
  modelPath?: string;
  mmprojPath?: string;
  omlxModel?: string;
  ollamaModel?: string;
  thinkingBudget?: number;
  mtpEnabled?: boolean;
  drafterPath?: string | null;
  capabilities: Record<string, unknown>;
  flags?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  lastUsedAt?: string;
}

// Context × KV-cache memory grid for one model. `grid[i].cells[j]` is the
// total bytes for preset grid[i].ctx with caches[j] on K and V.
export interface MemoryHeatmap {
  modelId: string;
  ramInstalledGB: number;
  ramAvailable: number;
  fixedBytes: number; // model + mmproj + draft + overhead
  modelBytes: number;
  mmprojBytes: number;
  overheadBytes: number;
  kvLayers: number;
  maxCtx: number;
  caches: string[];
  grid: { ctx: number; cells: number[] }[];
}

export interface AutotuneConfig {
  id: string;
  label: string;
  family: string;
  median: number;
  mad: number;
  n: number;
  accept: number | null;
  settings: Record<string, unknown>;
}

export interface AutotuneRun {
  modelId: string;
  profileId: string;
  runId: string;
  recommendedAt: string;
  recommended: string;
  noChange: boolean;
  reasoning: string;
  dflashDraft: string | null;
  configs: AutotuneConfig[];
}

export interface DsScorecard {
  total: number;
  earned: number;
  pct: number;
  checks: { label: string; earned: number; max: number; pass: boolean; detail?: string }[];
}

export interface DsSummary {
  status?: string | null;
  recommendedVariant?: string | null;
  decision?: string | null;
  metrics?: { label: string; value: string; delta?: string | null; context?: string | null }[];
}

export interface Run {
  id: string;
  bench: string;
  benchTitle: string;
  kind: string;
  model: string | null;
  modelDisplay: string | null;
  slug: string | null;
  backend: string | null;
  source: string | null;
  harness: string | null;
  status: string;
  createdAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  html: boolean;
  fps: number | null;
  minFps: number | null;
  frames: number | null;
  viewport: { width: number; height: number } | null;
  promptTok: number | null;
  compTok: number | null;
  totalTok: number | null;
  tokReported: boolean;
  prefill: number | null;
  gen: number | null;
  ttft: number | null;
  specAccept: number | null;
  wallMs: number | null;
  turns: number | null;
  toolCalls: number | null;
  success: boolean;
  preview: string | null;
  // Optional only so the legacy mock snapshot (data/runs.ts) still
  // typechecks; the hub always sets it.
  video?: string | null;
  ds: { scorecard: DsScorecard; summary: DsSummary } | null;
  // ModelRef composite of the catalog model that owns this run, when the
  // run's model is known to this machine (historical/cloud runs: null).
  // Optional only so the legacy mock snapshot (data/runs.ts) still typechecks.
  ownerRef?: string | null;
}

// ── Endpoint responses ──────────────────────────────────────────────────────

export interface MachineInfo {
  version: string;
  devMode: boolean; // running from a git work tree
  capturedAt: string;
  chip: string;
  ramBytes: number;
  ramLabel: string;
  platform: string;
}

export interface BackendStatus {
  id: string;
  label: string;
  type: string;
  port: number;
  baseUrl: string;
  up: boolean;
  version?: string;
  modelsLoaded?: number;
  modelsDiscovered?: number;
  modelCount: number;
  // Backend model ids currently loaded/running — the spinner/badge signal
  // for "this model is in use", including sessions the user started
  // themselves (a copied pi command).
  runningModels: string[];
}

// One row of the catalog; a saved profile rides along when present.
export interface ModelSummary {
  ref: string; // ModelRef composite form
  backend: string;
  id: string;
  title: string;
  sizeBytes?: number;
  contextLength?: number;
  capabilities: Record<string, unknown>;
  status: "ready" | "setup" | "draft" | "helper";
  profileId?: string;
}

export interface ModelsResponse {
  backends: BackendStatus[];
  models: ModelSummary[];
  profiles: Profile[];
}

export interface ModelDetail {
  ref: string;
  backend: string;
  id: string;
  title: string;
  sizeBytes?: number;
  contextLength?: number;
  capabilities: Record<string, unknown>;
  profile?: Profile;
  /** OpenAI-compatible chat API served by the backend when the model is
   *  running (baseUrl + model name to hit). Present iff a profile exists. */
  api?: { baseUrl: string; model: string };
  omlxModelSettings?: Record<string, unknown>;
}

export interface Benchmark {
  id: string;
  title: string;
  kind: string;
  description: string;
  prompt: string;
}

export interface LogEntry {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  kind: "friendly" | "raw" | "server" | "other";
}

// Read-model settings: real config + resolved paths (read-only display —
// editing config.json lands with the v4 parity pass).
export interface Settings {
  version: string;
  dataDir: string;
  logDir: string;
  hfCacheDir: string;
  benchmarkRepoPath: string | null;
  benchmarkRepoFound: boolean;
  scanDirs: string[];
  harness: string;
  harnesses: { id: string; label: string; active: boolean }[];
  config: {
    modelScanDirs: string[];
    binaryOverrides: Record<string, unknown>;
    lastSeenVersion: string | null;
    enable_benchmarking: boolean;
    enable_omlx: boolean;
    enable_ollama: boolean;
  };
  omlxServerSettings: Record<string, Record<string, unknown>> | null;
}

export interface ApiError {
  error: string;
}

// The job queue row as the API exposes it (log paths stay server-side).
// Shape lives in jobs/store.ts; re-exported here so the web client keeps
// one import path (@hub/api/types).
export type { JobDto as Job, JobStatus, JobType } from "../jobs/store.ts";
