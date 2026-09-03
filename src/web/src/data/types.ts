// Shared entity/API types live at the hub seam (src/hub/api/types.ts) —
// re-exported here so views keep one import path. Mock-only shapes (the
// static snapshot the not-yet-live pages read) stay below.

export type {
  Profile,
  MemoryHeatmap,
  AutotuneConfig,
  AutotuneRun,
  DsScorecard,
  DsSummary,
  Run,
  MachineInfo,
  BackendStatus,
  ModelSummary,
  ModelsResponse,
  ModelDetail,
  Benchmark,
  LogEntry,
  Job,
  JobStatus,
  JobType,
} from "@hub/api/types";

import type { Profile, MemoryHeatmap, AutotuneRun, Benchmark } from "@hub/api/types";

// Per-model setup read: heatmap (llama.cpp only) + the profile riding
// along + detected capabilities / max context before a profile exists.
export interface SetupInfo {
  ref: string;
  heatmap: MemoryHeatmap | null;
  profile?: Profile;
  capabilities?: Record<string, unknown>;
  maxCtx?: number;
}

// Static mock snapshot — only pages not yet on live data read this
// (jobs, learn, settings, and the Phase 3–5 write flows).
export interface HubData {
  meta: { app: string; version: string; capturedAt: string; note: string };
  hardware: { chip: string; ramBytes: number; ramLabel: string; metal: string; platform: string };
  config: Record<string, unknown>;
  backends: { id: string; label: string; type: string; port: number; baseUrl: string; version?: string }[];
  omlxStatus: Record<string, unknown>;
  profiles: Profile[];
  omlxModels: { id: string; maxModelLen: number | null; kind: string }[];
  ollamaModels: { id: string; sizeBytes: number; quant: string; capabilities: string[] }[];
  ggufModels: Record<string, unknown>[];
  memoryHeatmaps: MemoryHeatmap[];
  autotune: AutotuneRun[];
  benchmarks: Benchmark[];
  omlxSettingKeys: { key: string; label: string; group: string }[];
  omlxModelSettings: Record<string, Record<string, unknown>>;
  omlxServerSettings: Record<string, Record<string, unknown>>;
  learn: { id: string; title: string; tag: string; body: string }[];
}
