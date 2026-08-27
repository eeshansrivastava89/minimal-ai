// Types for the real dataset. Loose on purpose — the data is a snapshot,
// not a schema. Views only read a handful of fields.

export interface Profile {
  id: string;
  label: string;
  backend: string;
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
  capabilities: Record<string, unknown>;
  flags?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
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

export interface Benchmark {
  id: string;
  title: string;
  kind: string;
  description: string;
  prompt: string;
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
  ds: { scorecard: DsScorecard; summary: DsSummary } | null;
}

export interface HubData {
  meta: { app: string; version: string; capturedAt: string; note: string };
  hardware: { chip: string; ramBytes: number; ramLabel: string; metal: string; platform: string };
  config: Record<string, unknown>;
  backends: { id: string; label: string; type: string; port: number; baseUrl: string }[];
  omlxStatus: Record<string, unknown>;
  profiles: Profile[];
  omlxModels: { id: string; maxModelLen: number | null; kind: string }[];
  ollamaModels: { id: string; sizeBytes: number; quant: string; capabilities: string[] }[];
  ggufModels: Record<string, unknown>[];
  autotune: AutotuneRun[];
  benchmarks: Benchmark[];
  omlxSettingKeys: { key: string; label: string; group: string }[];
  omlxModelSettings: Record<string, Record<string, unknown>>;
  omlxServerSettings: Record<string, Record<string, unknown>>;
  learn: { id: string; title: string; tag: string; body: string }[];
}
