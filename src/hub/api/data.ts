// Live data assembly for the hub API. Reads the existing service layer
// (src/*.mjs) and benchmark-core directly — files remain the source of
// truth (~/.minimal-ai, runs/). Every function is read-only and never
// throws on missing data: absent dirs/servers yield empty results, not
// errors, so the API works on a fresh machine (and in CI).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKENDS, backendFor } from "../../backends.mjs";
import { loadConfig } from "../../config.mjs";
import { prepareMemoryEstimate, computeMemoryTotal } from "../../estimate.mjs";
import { readOmlxModelSettings, scanOmlxModelSizes } from "../../mlx-discovery.mjs";
import { installedRamGB } from "../../hardware.mjs";
import { findLlamaServer } from "../../config.mjs";
import { DATA_DIR, LOG_DIR } from "../../config.mjs";
import { loadProfiles } from "../../profiles.mjs";
import { scanGgufModels } from "../../scan.mjs";

import { slugModelId } from "../benchmark-core/paths.ts";
import { listRunMetadata } from "../benchmark-core/runs.ts";
import { getSystemStats } from "../benchmark-core/system-stats.ts";
import type { RunMetadata } from "../benchmark-core/types.ts";

import { formatModelRef, type ModelRef } from "./model-ref.ts";
import type {
  AutotuneRun,
  BackendStatus,
  Benchmark,
  LogEntry,
  MachineInfo,
  MemoryHeatmap,
  ModelDetail,
  ModelSummary,
  Profile,
  Run,
} from "./types.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FETCH_TIMEOUT_MS = 2000;

async function fetchJson(url: string): Promise<Record<string, any> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

// ── Machine ─────────────────────────────────────────────────────────────────

export async function machineInfo(): Promise<MachineInfo> {
  const stats = getSystemStats();
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  let devMode = false;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO_ROOT, stdio: "ignore" });
    devMode = true;
  } catch {
    /* not a git checkout */
  }
  const ramBytes = stats.memory.totalBytes;
  return {
    version: pkg.version,
    devMode,
    capturedAt: new Date().toISOString(),
    chip: stats.hardware.chipType ?? stats.cpu.model,
    ramBytes,
    ramLabel: `${Math.round(ramBytes / 1024 ** 3)} GB`,
    platform: `${stats.platform.platform}/${stats.platform.arch}`,
  };
}

// ── Backends ────────────────────────────────────────────────────────────────

interface OmlxStatus {
  up: boolean;
  version?: string;
  modelsLoaded?: number;
  modelsDiscovered?: number;
  liveModels: { id: string; maxModelLen: number | null }[];
}

async function omlxStatus(): Promise<OmlxStatus> {
  const base = BACKENDS.omlx.apiBaseUrl;
  const [status, models] = await Promise.all([
    fetchJson(`${base}/api/status`),
    fetchJson(`${base}/v1/models`),
  ]);
  const liveModels = Array.isArray(models?.data)
    ? (models!.data as any[]).map((m) => ({
        id: String(m.id),
        maxModelLen: typeof m.max_model_len === "number" ? m.max_model_len : null,
      }))
    : [];
  return {
    up: status?.status === "ok" || liveModels.length > 0,
    version: typeof status?.version === "string" ? status.version : undefined,
    modelsLoaded: typeof status?.models_loaded === "number" ? status.models_loaded : undefined,
    modelsDiscovered:
      typeof status?.models_discovered === "number" ? status.models_discovered : undefined,
    liveModels,
  };
}

async function ollamaTags(): Promise<{ up: boolean; version?: string; models: any[] }> {
  const base = BACKENDS.ollama.defaultBaseUrl;
  const [version, tags] = await Promise.all([
    fetchJson(`${base}/api/version`),
    fetchJson(`${base}/api/tags`),
  ]);
  return {
    up: tags != null,
    version: typeof version?.version === "string" ? version.version : undefined,
    models: Array.isArray(tags?.models) ? (tags!.models as any[]) : [],
  };
}

// ── Model catalog ───────────────────────────────────────────────────────────

// Match a saved profile to a discovered model. The profile's backend pins
// the bucket; the id matches the backend's own model field first, then the
// alias (backendFor(...).modelIdFields defines the lookup order).
function profileMatchesModel(p: Profile, backend: string, id: string): boolean {
  if (p.backend !== backend) return false;
  const fields: string[] = backendFor(backend).modelIdFields ?? ["modelAlias"];
  // GGUF identity is the file path; llama.cpp profiles key on modelPath.
  if (backend === "llama-cpp") fields.push("modelPath");
  return fields.some((f) => (p as unknown as Record<string, unknown>)[f] === id);
}

export async function catalog(): Promise<{
  backends: BackendStatus[];
  models: ModelSummary[];
  profiles: Profile[];
}> {
  const [profiles, omlx, ollama, gguf, llamaServer] = await Promise.all([
    loadProfiles() as Promise<Profile[]>,
    omlxStatus(),
    ollamaTags(),
    scanGgufModels(),
    findLlamaServer(),
  ]);

  const omlxDisk = await scanOmlxModelSizes();
  const models: ModelSummary[] = [];

  // oMLX: disk is the catalog (works whether or not the server is up);
  // the live server only enriches with maxModelLen.
  const liveById = new Map(omlx.liveModels.map((m) => [m.id, m]));
  for (const [id, info] of [...omlxDisk.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const profile = profiles.find((p) => profileMatchesModel(p, "omlx", id));
    models.push({
      ref: formatModelRef({ backend: "omlx", id }),
      backend: "omlx",
      id,
      title: id,
      sizeBytes: info.sizeBytes || profile?.modelSizeBytes,
      contextLength:
        liveById.get(id)?.maxModelLen ??
        (profile?.capabilities?.contextLength as number | undefined),
      capabilities: profile?.capabilities ?? {},
      status: info.drafter ? "draft" : profile ? "ready" : "setup",
      profileId: profile?.id,
    });
  }

  for (const m of ollama.models) {
    const id = String(m.name ?? m.model);
    const profile = profiles.find((p) => profileMatchesModel(p, "ollama", id));
    const caps: Record<string, unknown> = Object.fromEntries(
      (Array.isArray(m.capabilities) ? m.capabilities : []).map((c: string) => [c, true])
    );
    if (m.details?.quantization_level) caps.quant = m.details.quantization_level;
    models.push({
      ref: formatModelRef({ backend: "ollama", id }),
      backend: "ollama",
      id,
      title: id,
      sizeBytes: typeof m.size === "number" ? m.size : profile?.modelSizeBytes,
      contextLength: profile?.capabilities?.contextLength as number | undefined,
      capabilities: profile?.capabilities ?? caps,
      status: profile ? "ready" : "setup",
      profileId: profile?.id,
    });
  }

  // GGUF identity is the file path (unique, stable, what runs record).
  for (const g of gguf.models) {
    const profile = profiles.find(
      (p) => p.backend === "llama-cpp" && (p.modelPath === g.path || p.modelAlias === g.aliasSuggestion)
    );
    models.push({
      ref: formatModelRef({ backend: "llama-cpp", id: g.path }),
      backend: "llama-cpp",
      id: g.path,
      title: g.label,
      subtitle: g.path,
      sizeBytes: g.sizeBytes || profile?.modelSizeBytes,
      contextLength:
        (g.contextLength as number | undefined) ??
        (profile?.capabilities?.ctxSize as number | undefined),
      capabilities: profile?.capabilities ?? { quant: g.quant },
      status: profile ? "ready" : "setup",
      profileId: profile?.id,
    });
  }

  const backends: BackendStatus[] = [
    {
      id: "omlx",
      label: BACKENDS.omlx.label,
      type: BACKENDS.omlx.type,
      port: BACKENDS.omlx.defaultPort,
      baseUrl: BACKENDS.omlx.defaultBaseUrl,
      up: omlx.up,
      version: omlx.version,
      modelsLoaded: omlx.modelsLoaded,
      modelsDiscovered: omlx.modelsDiscovered,
      modelCount: models.filter((m) => m.backend === "omlx").length,
    },
    {
      id: "ollama",
      label: BACKENDS.ollama.label,
      type: BACKENDS.ollama.type,
      port: BACKENDS.ollama.defaultPort,
      baseUrl: BACKENDS.ollama.defaultBaseUrl,
      up: ollama.up,
      version: ollama.version,
      modelCount: models.filter((m) => m.backend === "ollama").length,
    },
    {
      id: "llama-cpp",
      label: BACKENDS["llama-cpp"].label,
      type: BACKENDS["llama-cpp"].type,
      port: BACKENDS["llama-cpp"].defaultPort,
      baseUrl: BACKENDS["llama-cpp"].defaultBaseUrl,
      up: Boolean(llamaServer),
      modelCount: models.filter((m) => m.backend === "llama-cpp").length,
    },
  ];

  return { backends, models, profiles };
}

export async function modelDetail(ref: ModelRef): Promise<ModelDetail | null> {
  const { models, profiles } = await catalog();
  const summary = models.find((m) => m.backend === ref.backend && m.id === ref.id);
  if (!summary) return null;
  const profile = profiles.find((p) => p.id === summary.profileId);
  const detail: ModelDetail = {
    ref: summary.ref,
    backend: summary.backend,
    id: summary.id,
    title: summary.title,
    sizeBytes: summary.sizeBytes,
    contextLength: summary.contextLength,
    capabilities: summary.capabilities,
    profile,
  };
  if (ref.backend === "omlx") {
    const settings = await readOmlxModelSettings(ref.id).catch(() => null);
    if (settings && Object.keys(settings).length) detail.omlxModelSettings = settings;
  }
  return detail;
}

// ── Setup (read model) ──────────────────────────────────────────────────────

const HEATMAP_CTXS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
const HEATMAP_CACHES = [
  { label: "f16", k: "f16", v: "f16" },
  { label: "q8", k: "q8_0", v: "q8_0" },
  { label: "q4", k: "q4_0", v: "q4_0" },
];

// llama.cpp only: the heatmap is computed from the GGUF on disk by the real
// estimator. oMLX/Ollama models get null (server-side settings instead).
export async function setupInfo(ref: ModelRef): Promise<{
  ref: string;
  heatmap: MemoryHeatmap | null;
  profile?: Profile;
} | null> {
  const detail = await modelDetail(ref);
  if (!detail) return null;
  let heatmap: MemoryHeatmap | null = null;
  if (ref.backend === "llama-cpp") {
    const { models } = await scanGgufModels();
    const g = models.find((m) => m.path === ref.id);
    if (g?.path) {
      const prepared = prepareMemoryEstimate(g.path, g.mmprojPath ?? null, null);
      const fixedBytes =
        prepared.modelBytes + prepared.mmprojBytes + prepared.draftBytes + prepared.overheadBytes;
      heatmap = {
        modelId: ref.id,
        ramInstalledGB: installedRamGB(),
        ramAvailable: 0,
        fixedBytes,
        modelBytes: prepared.modelBytes,
        mmprojBytes: prepared.mmprojBytes,
        overheadBytes: prepared.overheadBytes,
        kvLayers: prepared.kvParams.layers ?? 0,
        maxCtx: Math.max(...HEATMAP_CTXS),
        caches: HEATMAP_CACHES.map((c) => c.label),
        grid: HEATMAP_CTXS.map((ctx) => ({
          ctx,
          cells: HEATMAP_CACHES.map(
            (c) =>
              computeMemoryTotal(prepared, { ctxSize: ctx, cacheTypeK: c.k, cacheTypeV: c.v })
                .totalBytes
          ),
        })),
      };
    }
  }
  return { ref: detail.ref, heatmap, profile: detail.profile };
}

// ── Autotune ────────────────────────────────────────────────────────────────

export async function autotuneFor(ref: ModelRef): Promise<AutotuneRun | null> {
  const root = join(DATA_DIR, "autotune", slugModelId(ref.id));
  if (!existsSync(root)) return null;
  const runDirs = (await readdir(root)).filter((d) => !d.startsWith(".")).sort().reverse();
  for (const dir of runDirs) {
    const runDir = join(root, dir);
    const optimalPath = join(runDir, "optimal.json");
    if (!existsSync(optimalPath)) continue;
    const optimal = JSON.parse(await readFile(optimalPath, "utf8"));
    // Journal rows carry every probed config; map to the scorecard shape.
    const configs: AutotuneRun["configs"] = [];
    try {
      const journal = await readFile(join(runDir, "sweep.jsonl"), "utf8");
      for (const line of journal.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (!row.configId || !row.summary) continue;
        configs.push({
          id: row.configId,
          label: row.label ?? row.configId,
          family: row.family ?? "",
          median: row.summary.median,
          mad: row.summary.mad,
          n: row.summary.n,
          accept: row.summary.mtp?.accept ?? null,
          settings: row.settings ?? {},
        });
      }
    } catch {
      /* no journal — configs stay empty */
    }
    const { profiles } = await catalog();
    const profile = profiles.find((p) => profileMatchesModel(p, ref.backend, ref.id));
    const rec = optimal.recommended ?? {};
    return {
      modelId: ref.id,
      profileId: profile?.id ?? "",
      runId: dir,
      recommendedAt: optimal.recommendedAt ?? "",
      recommended: rec.label ?? rec.configId ?? "",
      noChange: Boolean(optimal.noChange),
      reasoning: optimal.reasoning ?? "",
      dflashDraft: optimal.dflashDraft ?? null,
      configs,
    };
  }
  return null;
}

// ── Runs ────────────────────────────────────────────────────────────────────

// Runs live in the benchmark gallery repo's runs/ tree (zero migration —
// Phase 6 decides their final home). Resolve non-interactively: config
// first, then the well-known sibling paths.
export async function resolveRunsRoot(): Promise<string | null> {
  const config = await loadConfig();
  const candidates = [
    config.benchmarkRepoPath,
    join(homedir(), "dev", "local-llm-visual-benchmark"),
    join(homedir(), "projects", "local-llm-visual-benchmark"),
    join(homedir(), "local-llm-visual-benchmark"),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "runs"))) return join(candidate, "runs");
  }
  return null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function runFromMetadata(m: RunMetadata): Promise<Run> {
  const cap = (m.capture?.video as any)?.quality ?? {};
  const tok: Record<string, any> = m.runner?.tokenMetrics ?? {};
  const spd = (m.runner as any)?.speedMetrics ?? {};
  const res = (m as any).results ?? {};

  let ds: Run["ds"] = null;
  if (m.dsScorecard && m.dsSummary) {
    ds = { scorecard: m.dsScorecard as Run["ds"] extends null ? never : any, summary: m.dsSummary as any };
  } else if (m.kind === "data-science") {
    try {
      const sc = JSON.parse(await readFile(join(m.runDirectory, "scorecard.json"), "utf8"));
      const su = JSON.parse(await readFile(join(m.runDirectory, "summary.json"), "utf8"));
      ds = {
        scorecard: {
          total: sc.total,
          earned: sc.earned,
          pct: sc.pct,
          checks: Object.values(sc.checks ?? {}).map((c: any) => ({
            label: c.label, earned: c.earned, max: c.max, pass: Boolean(c.pass), detail: c.detail,
          })),
        },
        summary: {
          status: su.status,
          recommendedVariant: su.recommended_variant,
          decision: su.decision,
          metrics: (su.metrics ?? []).map((x: any) => ({
            label: x.label, value: x.value, delta: x.delta, context: x.context,
          })),
        },
      };
    } catch {
      /* no scorecard/summary */
    }
  }

  let preview: string | null = null;
  try {
    const s = await stat(join(m.runDirectory, "preview.png"));
    if (s.isFile()) {
      preview = `/api/media/run/${m.benchmark.id}/${m.model.slug}/${m.runId}/preview.png`;
    }
  } catch {
    /* no preview */
  }

  return {
    id: m.runId,
    bench: m.benchmark.id,
    benchTitle: m.benchmark.title ?? m.benchmark.id,
    kind: m.kind ?? "visual",
    model: m.model?.id ?? null,
    modelDisplay: m.model?.displayName ?? m.model?.id ?? null,
    slug: m.model?.slug ?? null,
    backend: m.runner?.backendLabel ?? null,
    source: m.runner?.modelSource ?? null,
    harness: m.runner?.intendedRunner ?? null,
    status: m.status ?? "prepared",
    createdAt: m.createdAt ?? null,
    completedAt: m.completedAt ?? null,
    fps: num(cap.measuredFps),
    minFps: num(cap.minFps),
    frames: num(cap.frames),
    viewport: cap.viewport ?? null,
    promptTok: num(tok.promptTokens),
    compTok: num(tok.completionTokens),
    totalTok: num(tok.totalTokens),
    tokReported: Boolean(tok.reported),
    prefill: num(spd.prefillTokensPerSecond),
    gen: num(spd.generationTokensPerSecond),
    ttft: num(spd.ttftMs),
    specAccept: num(spd.speculativeDecodeAcceptance),
    wallMs: num(res.wallClockMs),
    turns: num(res.agentTurns),
    toolCalls: num(res.toolCalls),
    success: Boolean(res.success),
    preview,
    ds,
    ownerRef: null, // attached by allRuns once the catalog is known
  };
}

export async function allRuns(): Promise<Run[]> {
  const runsRoot = await resolveRunsRoot();
  if (!runsRoot) return [];
  const [metadata, { models, profiles }] = await Promise.all([listRunMetadata(runsRoot), catalog()]);
  const runs = await Promise.all(metadata.map(runFromMetadata));
  // Attach the owning catalog model (spine: runs are children of models).
  // A run names its model by raw id/slug/display; a model answers to its
  // backend id plus every alias on its profile.
  const namesByRef = new Map<string, Set<string>>();
  for (const m of models) {
    const profile = profiles.find((p) => p.id === m.profileId);
    namesByRef.set(
      m.ref,
      new Set(
        [m.id, slugModelId(m.id), profile?.modelAlias, profile?.omlxModel, profile?.ollamaModel, profile?.label]
          .filter(Boolean) as string[]
      )
    );
  }
  for (const r of runs) {
    r.ownerRef = null;
    for (const [ref, names] of namesByRef) {
      if ((r.model && names.has(r.model)) || (r.slug && names.has(r.slug)) || (r.modelDisplay && names.has(r.modelDisplay))) {
        r.ownerRef = ref;
        break;
      }
    }
  }
  return runs;
}

// All the names a model goes by in run metadata: its backend id, its slug,
// and every alias on its profile.
export async function runsFor(ref: ModelRef): Promise<Run[]> {
  const [runs, { profiles }] = await Promise.all([allRuns(), catalog()]);
  const profile = profiles.find((p) => profileMatchesModel(p, ref.backend, ref.id));
  const names = new Set(
    [ref.id, slugModelId(ref.id), profile?.modelAlias, profile?.omlxModel, profile?.ollamaModel, profile?.label]
      .filter(Boolean) as string[]
  );
  return runs.filter(
    (r) =>
      (r.model && names.has(r.model)) ||
      (r.slug && names.has(r.slug)) ||
      (r.modelDisplay && names.has(r.modelDisplay))
  );
}

// Latest sweep per model that has one — the dashboard's "recent autotune".
export async function allAutotune(): Promise<AutotuneRun[]> {
  const root = join(DATA_DIR, "autotune");
  if (!existsSync(root)) return [];
  const { models } = await catalog();
  const out: AutotuneRun[] = [];
  for (const m of models) {
    const run = await autotuneFor({ backend: m.backend as ModelRef["backend"], id: m.id });
    if (run) out.push(run);
  }
  return out.sort((a, b) => b.recommendedAt.localeCompare(a.recommendedAt));
}

// Benchmark catalog from the gallery repo (prompts + descriptions).
export async function allBenchmarks(): Promise<Benchmark[]> {
  const runsRoot = await resolveRunsRoot();
  if (!runsRoot) return [];
  const benchmarksDir = join(dirname(runsRoot), "benchmarks");
  const { loadBenchmarks } = await import("../benchmark-core/benchmarks.ts");
  try {
    const defs = await loadBenchmarks(benchmarksDir);
    return defs.map((d) => ({
      id: d.id,
      title: d.title,
      kind: ((d as unknown as Record<string, unknown>).kind as string) ?? "visual",
      description: d.description,
      prompt: d.prompt,
    }));
  } catch {
    return [];
  }
}

// ── Logs ────────────────────────────────────────────────────────────────────

function logKind(name: string): LogEntry["kind"] {
  if (name.endsWith(".friendly.log")) return "friendly";
  if (name.endsWith(".raw.log")) return "raw";
  if (name.endsWith(".log")) return "server";
  return "other";
}

export async function logsFor(ref: ModelRef): Promise<LogEntry[]> {
  const { profiles } = await catalog();
  const profile = profiles.find((p) => profileMatchesModel(p, ref.backend, ref.id));
  const names = [profile?.id, ref.id, slugModelId(ref.id)].filter(Boolean) as string[];
  const out: LogEntry[] = [];

  async function collect(dir: string, prefix: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!names.some((n) => e.name.includes(n))) continue;
      const s = await stat(join(dir, e.name));
      out.push({
        name: prefix + e.name,
        sizeBytes: s.size,
        modifiedAt: s.mtime.toISOString(),
        kind: logKind(e.name),
      });
    }
  }

  await collect(LOG_DIR, "");
  // Per-model server log dirs (e.g. omlx-qwen3.5-4b/).
  try {
    for (const e of await readdir(LOG_DIR, { withFileTypes: true })) {
      if (e.isDirectory() && names.some((n) => e.name.includes(n))) {
        await collect(join(LOG_DIR, e.name), `${e.name}/`);
      }
    }
  } catch {
    /* no log dir */
  }

  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
