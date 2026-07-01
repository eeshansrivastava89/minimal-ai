// ── Benchmark module (thin facade) ──────────────────────────────────────────
// Submodules handle the actual logic. This file re-exports for backward compatibility.

export { slugModelId, createRunId, buildToolPrompt, loadBenchmarks, piModelString } from "./benchmark/shared.mjs";
export { findBenchmarkRepo, linkBenchmarkRepo } from "./benchmark/repo.mjs";
export { prepareBenchmarkRun } from "./benchmark/prepare.mjs";
export { runBenchmarkInPi } from "./benchmark/sdk-runner.mjs";
export { queryServerMetrics } from "./benchmark/metrics.mjs";
// unloadModelFromServer now lives in src/process.mjs (managed-server counterpart to stopProfile).
export { unloadModelFromServer } from "./process.mjs";
export { finalizeBenchmarkRun, renderBenchmarkSummary } from "./benchmark/finalize.mjs";
export { benchmarkForProfile, benchmarkFlow } from "./benchmark/flow.mjs";