// The workbench's filter/group/card logic — ported from the benchmark
// gallery's runs.js so the hub's /benchmarks page behaves identically:
// same kind split, same filters, same grouping, same card states, same
// summary text. Sorting is inherited from the API (recency), as in the
// gallery. Pure functions; the page stays thin.

import type { Run } from "@/data/types";

export type RunKind = "visual" | "data-science";

// The A/B analysis is the one data-science benchmark (same rule as the
// gallery's runs.js and the CLI loader).
const DS_BENCHMARK_IDS = new Set(["ab-test-analysis"]);

export function benchmarkMatchesKind(benchmarkId: string, kind: RunKind): boolean {
  return kind === "data-science"
    ? DS_BENCHMARK_IDS.has(benchmarkId)
    : !DS_BENCHMARK_IDS.has(benchmarkId);
}

export function runKind(run: Run): RunKind {
  return (run.kind as RunKind) ?? "visual";
}

export function isCloudRun(run: Run): boolean {
  return run.source === "cloud";
}

// The model · backend · harness stack label (stackAttemptIdentity).
export function stackLabel(run: Run): string {
  return [run.model, run.backend, run.harness].filter(Boolean).join(" · ");
}

// ── Card state (runCardState) ───────────────────────────────────────────────

export interface RunCardState {
  status: string; // StatusBadge key
  label: string; // short state text under the preview
}

export function runCardState(run: Run): RunCardState {
  if (runKind(run) === "data-science") {
    return run.ds ? { status: "completed", label: "analysis" } : { status: "prepared", label: "slot" };
  }
  if (run.video) return { status: "completed", label: "video" };
  if (run.status === "failed" || run.status === "cancelled") {
    return { status: run.status, label: run.status };
  }
  if (run.html) return { status: "prepared", label: "capture" };
  if (run.preview) return { status: "completed", label: "preview" };
  return { status: "prepared", label: "slot" };
}

// ── Media message (runCardMediaMessage) ──────────────────────────────────────

export function runCardMediaMessage(run: Run): string {
  if (runKind(run) === "data-science") {
    if (run.ds) return "Scored";
    if (run.status === "failed") return "Analysis failed";
    return "Waiting for analysis outputs";
  }
  if (run.video) {
    return run.fps != null && run.minFps != null && run.fps < run.minFps
      ? `Video ready · slow render ${run.fps} FPS`
      : "Video ready";
  }
  if (run.status === "failed") return "Capture failed";
  if (run.html) return "Needs media capture";
  if (run.preview) return "Preview ready";
  return "Waiting for index.html source";
}

// ── Identity (runCardIdentity) ───────────────────────────────────────────────

export function runCardIdentity(run: Run, mode: "model" | "benchmark"): { primary: string; secondary: string } {
  const promptTitle = run.benchTitle ?? run.bench;
  const modelId = run.model ?? "Unknown model";
  if (mode === "benchmark") {
    // By-prompt groups: the card names the model; the stack is the sub-line.
    const stack = [run.backend, run.harness].filter(Boolean).join(" · ");
    return { primary: modelId, secondary: stack };
  }
  // By-model groups: the card names the prompt; the harness is the sub-line.
  return { primary: promptTitle, secondary: run.harness ?? "" };
}

// ── Summary line (runSummaryText) ────────────────────────────────────────────

export function runSummaryText(runs: Run[], kind: RunKind): string {
  const prepared = runs.filter((r) => r.status === "prepared" && !r.video).length;
  const failed = runs.filter((r) => r.status === "failed").length;
  if (kind === "data-science") {
    const scored = runs.filter((r) => r.ds).length;
    return `${scored} scored, ${prepared} prepared, ${failed} failed`;
  }
  const videoReady = runs.filter((r) => r.video).length;
  const needsCapture = runs.filter((r) => r.html && (!r.preview || !r.video)).length;
  return `${videoReady} with video, ${needsCapture} need capture, ${prepared} prepared, ${failed} failed`;
}

// ── Filters (filteredRuns) ───────────────────────────────────────────────────

export interface RunFilters {
  kind: RunKind;
  model: string; // "all" | model id
  benchmark: string; // "all" | benchmark id
  harness: string; // "all" | harness label
  search: string;
  includeCloud: boolean;
}

function searchableRunText(run: Run): string {
  return [
    run.id,
    runKind(run),
    run.status,
    run.harness,
    run.bench,
    run.benchTitle,
    run.model,
    run.slug,
    run.backend,
    run.source,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function filterRuns(runs: Run[], f: RunFilters): Run[] {
  const needle = f.search.trim().toLowerCase();
  return runs.filter((run) => {
    const kindMatch = runKind(run) === f.kind;
    const modelMatch = f.model === "all" || run.model === f.model;
    const benchmarkMatch = f.benchmark === "all" || run.bench === f.benchmark;
    const harnessMatch = f.harness === "all" || run.harness === f.harness;
    const searchMatch = !needle || searchableRunText(run).includes(needle);
    const cloudMatch = f.includeCloud || !isCloudRun(run);
    return kindMatch && modelMatch && benchmarkMatch && harnessMatch && searchMatch && cloudMatch;
  });
}

// ── Grouping (groupRuns) — insertion order = recency, like the gallery ───────

export interface RunGroup {
  title: string;
  subtitles: string[];
  runs: Run[];
  /** Group-level facts the hub adds on top of the gallery port. */
  historical: boolean; // no run's model is in the live catalog
}

export function groupRuns(
  runs: Run[],
  titleForRun: (r: Run) => string,
  subtitleForRun: (r: Run) => string
): RunGroup[] {
  const groups = new Map<string, { titles: Set<string>; subtitles: Set<string>; runs: Run[]; live: boolean }>();
  for (const run of runs) {
    const title = titleForRun(run);
    let group = groups.get(title);
    if (!group) {
      group = { titles: new Set(), subtitles: new Set(), runs: [], live: false };
      groups.set(title, group);
    }
    group.subtitles.add(subtitleForRun(run));
    group.runs.push(run);
    if (run.ownerRef) group.live = true;
  }
  return Array.from(groups.entries()).map(([title, g]) => ({
    title,
    subtitles: Array.from(g.subtitles),
    runs: g.runs,
    historical: g.runs.length > 0 && !g.live,
  }));
}

// Filter option lists (modelsFromRuns / harnessesFromRuns).
export function filterOptions(runs: Run[]): { models: string[]; benchmarks: string[]; harnesses: string[] } {
  const uniq = (values: (string | null | undefined)[]) =>
    Array.from(new Set(values.filter((v): v is string => Boolean(v)))).sort((a, b) => a.localeCompare(b));
  return {
    models: uniq(runs.map((r) => r.model)),
    benchmarks: uniq(runs.map((r) => r.bench)),
    harnesses: uniq(runs.map((r) => r.harness)),
  };
}