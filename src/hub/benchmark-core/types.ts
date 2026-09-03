export type RunStatus =
  | "prepared"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type RunKind = "visual" | "data-science";

export type RunnerMode =
  | "manual"
  | "openai-compatible"
  | "external";

export interface BenchmarkRecord {
  id: string;
  title: string;
  description: string;
  prompt: string;
  sourcePath?: string;
}

export interface LMStudioModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  localPath?: string;
}

export interface OmlxModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export type ModelSourceId = "ollama" | "omlx" | "llama-cpp" | "llama-cpp-mtp" | "cloud";

export interface RunModelRecord {
  id: string;
  slug: string;
  displayName?: string;
}

export interface ViewportSettings {
  width: number;
  height: number;
}

export interface PreviewSettings {
  captureAtMs: number;
  viewport: ViewportSettings;
  video: boolean;
}

export interface CaptureSettings {
  preview: PreviewSettings;
}

export type DataScienceAssets = {
  notebook?: string;
  summary?: string;
  scorecard?: string;
  judgeScorecard?: string;
  chartDistribution?: string;
  chartTreatmentEffect?: string;
  chartCompletionRates?: string;
};

export interface RunAssets {
  metadata: string;
  prompt?: string;
  rawResponse?: string;
  request?: string;
  stream?: string;
  response?: string;
  command?: string;
  html?: string;
  preview?: string;
  video?: string;
  videoMp4?: string;
  /** Data-science run assets (notebook, summary JSON, chart PNGs). */
  ds?: DataScienceAssets;
}

export interface RunError {
  message: string;
  stack?: string;
}

export type CaptureAssetStatus = "ready" | "failed" | "skipped";

export interface RunCaptureAsset {
  status: CaptureAssetStatus;
  path?: string;
  capturedAt?: string;
  reason?: string;
  error?: RunError;
  quality?: {
    measuredFps?: number;
    minFps?: number;
    sampleMs?: number;
    frames?: number;
    viewport?: ViewportSettings;
    launchArgs?: string[];
  };
}

export interface RunCaptureMetadata {
  preview?: RunCaptureAsset;
  video?: RunCaptureAsset;
}

export interface RunTokenMetrics {
  reported: boolean;
  estimated?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface RunRunnerMetadata {
  mode: RunnerMode;
  modelSource?: ModelSourceId;
  intendedRunner?: string;
  actualRunner?: string;
  harnessLabel?: string;
  harnessVersion?: string;
  backendLabel?: string;
  baseUrl?: string;
  model?: string;
  launchCommand?: string;
  requestAsset?: string;
  streamAsset?: string;
  responseAsset?: string;
  commandAsset?: string;
  metricSource?: string;
  retries?: number;
  fallbacksUsed?: string[];
  tokenMetrics?: RunTokenMetrics;
}

export interface DsScorecard {
  total: number;
  earned: number;
  pct: number;
  checks?: Record<string, { label: string; max: number; earned: number; pass: boolean; detail: string }>;
}

export interface DsJudgeScorecard {
  notebook_structure: number;
  visualization_quality: number;
  statistical_interpretation: number;
  grounding: number;
  product_recommendation: number;
  notes: string;
}

export interface DsSummary {
  status?: string;
  recommended_variant?: "A" | "B" | null;
  decision?: string;
  metrics?: Array<{ label: string; value?: string; delta?: string; delta_direction?: string; context?: string }>;
  warnings?: string[];
}

export interface RunMetadata {
  schemaVersion?: number;
  kind?: RunKind;
  runId: string;
  benchmark: BenchmarkRecord;
  model: RunModelRecord;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  runDirectory: string;
  settings?: CaptureSettings;
  assets: RunAssets;
  promptText?: string;
  dsSummary?: DsSummary;
  dsScorecard?: DsScorecard;
  preparedAt?: string;
  tool?: "opencode" | "pi" | "hermes" | "generic";
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  skippedAt?: string;
  error?: RunError;
  capture?: RunCaptureMetadata;
  runner?: RunRunnerMetadata;
  notes?: string;
}

export interface PreparedRun {
  run: RunMetadata;
  prompt: string;
  command?: string;
  paths: {
    runDirectory: string;
    promptPath: string;
    commandPath: string;
    htmlPath: string;
    metadataPath: string;
    previewPath: string;
  };
}
