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
  Settings,
  Job,
  JobStatus,
  JobType,
} from "@hub/api/types";

// Locally used for the SetupInfo shape below.
import type { MemoryHeatmap, Profile } from "@hub/api/types";


// Per-model setup read: heatmap (llama.cpp only) + the profile riding
// along + detected capabilities / max context before a profile exists.
export interface SetupInfo {
  ref: string;
  heatmap: MemoryHeatmap | null;
  profile?: Profile;
  capabilities?: Record<string, unknown>;
  maxCtx?: number;
}

// Autotune plan preview (GET /api/models/:id/autotune/plan) — probe + grid,
// read-only. Rows feed the shared SweepMatrix (median null = planned).
export interface AutotunePlan {
  model: {
    id: string;
    displayName: string;
    mtpCompatible: boolean;
    dflashCompatible: boolean;
    thinkingDefault: string | null;
  };
  rows: {
    id: string;
    label: string;
    family: string;
    settings: Record<string, unknown>;
    tested: boolean;
    skipReason?: string;
    estMinutes?: number;
  }[];
  testedCount: number;
}
