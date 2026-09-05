// Live data assembly for the hub API. Reads the existing service layer
// (src/*.mjs) and benchmark-core directly — files remain the source of
// truth (~/.minimal-ai, runs/). Every function is read-only and never
// throws on missing data: absent dirs/servers yield empty results, not
// errors, so the API works on a fresh machine (and in CI).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKENDS, backendFor } from "../../backends.mjs";
import { loadConfig, getModelScanDirs } from "../../config.mjs";
import { listHarnesses } from "../../harnesses.mjs";
import { bytesForCacheType, prepareMemoryEstimate, computeMemoryTotal } from "../../estimate.mjs";
import { findOmlxModelDir, readOmlxModelConfig } from "../../mlx-discovery.mjs";
import { ollamaModelInfo } from "../../ollama-runtime.mjs";
import { readOmlxModelSettings, scanOmlxModelSizes } from "../../mlx-discovery.mjs";
import { installedRamGB, availableRamBytes } from "../../hardware.mjs";
import { findLlamaServer } from "../../config.mjs";
import { DATA_DIR, HF_HUB_DIR, LOG_DIR } from "../../config.mjs";
import { loadProfiles } from "../../profiles.mjs";
import { effectiveModelId } from "../../profiles.mjs";
import { scanGgufModels, scanOllamaModels } from "../../scan.mjs";

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
  Settings,
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
  runningModels: string[];
}

async function omlxStatus(): Promise<OmlxStatus> {
  const base = BACKENDS.omlx.apiBaseUrl;
  const [status, models, admin] = await Promise.all([
    fetchJson(`${base}/api/status`),
    fetchJson(`${base}/v1/models`),
    fetchJson(`${base}/admin/api/models`),
  ]);
  const liveModels = Array.isArray(models?.data)
    ? (models!.data as any[]).map((m) => ({
        id: String(m.id),
        maxModelLen: typeof m.max_model_len === "number" ? m.max_model_len : null,
      }))
    : [];
  const runningModels = Array.isArray(admin?.models)
    ? admin!.models
        .filter((m: any) => m.loaded === true && (m.engine_type ?? "") !== "markitdown" && m.is_loading !== true)
        .map((m: any) => String(m.id))
    : [];
  return {
    up: status?.status === "ok" || liveModels.length > 0,
    version: typeof status?.version === "string" ? status.version : undefined,
    modelsLoaded: typeof status?.models_loaded === "number" ? status.models_loaded : undefined,
    modelsDiscovered:
      typeof status?.models_discovered === "number" ? status.models_discovered : undefined,
    liveModels,
    runningModels,
  };
}

async function ollamaTags(): Promise<{ up: boolean; version?: string; models: any[]; runningModels: string[] }> {
  const base = BACKENDS.ollama.apiBaseUrl;
  const [version, tags, ps] = await Promise.all([
    fetchJson(`${base}/api/version`),
    fetchJson(`${base}/api/tags`),
    fetchJson(`${base}/api/ps`),
  ]);
  const runningModels = Array.isArray(ps?.models) ? ps!.models.map((m: any) => String(m.model ?? m.name)) : [];
  return {
    up: tags != null,
    version: typeof version?.version === "string" ? version.version : undefined,
    models: Array.isArray(tags?.models) ? (tags!.models as any[]) : [],
    runningModels,
  };
}

// llama.cpp version comes from the binary itself (it's not a daemon) —
// read once per process.
let llamaCppVersion: string | undefined | null;
/** Loaded model ids across every llama.cpp profile's server (deduped by
 *  baseUrl). null fetch = server down — no models running there. */
async function llamaCppRunning(profiles: Profile[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of profiles.filter((x) => x.backend === "llama-cpp")) {
    if (seen.has(p.baseUrl)) continue;
    seen.add(p.baseUrl);
    const models = await fetchJson(`${p.baseUrl}/models`);
    if (Array.isArray(models?.data)) for (const m of models!.data) out.push(String(m.id));
  }
  return out;
}

async function llamaCppInfo(): Promise<{ installed: boolean; version?: string }> {
  const binary = await findLlamaServer();
  if (!binary) return { installed: false };
  if (llamaCppVersion === undefined) {
    llamaCppVersion = null;
    try {
      // llama-server prints --version to stderr.
      const r = spawnSync(binary, ["--version"], { timeout: 5000, encoding: "utf8" });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const build = out.match(/build (\d+)/);
      llamaCppVersion = build ? `build ${build[1]}` : out.split("\n")[0]?.trim() || null;
    } catch {
      /* version unreadable — installed is still true */
    }
  }
  return { installed: true, version: llamaCppVersion ?? undefined };
}

// ── Model catalog ───────────────────────────────────────────────────────────

// Match a saved profile to a discovered model. The profile's backend pins
// the bucket; the id matches the backend's own model field first, then the
// alias (backendFor(...).modelIdFields defines the lookup order).
export function profileMatchesModel(p: Profile, backend: string, id: string): boolean {
  if (p.backend !== backend) return false;
  // Copy before extending — backendFor returns the SHARED BACKENDS entry;
  // pushing onto it would mutate the registry on every call.
  // GGUF identity is the file path; llama.cpp profiles key on modelPath.
  const fields: string[] = [...(backendFor(backend).modelIdFields ?? ["modelAlias"])];
  if (backend === "llama-cpp") fields.push("modelPath");
  return fields.some((f) => (p as unknown as Record<string, unknown>)[f] === id);
}

export async function catalog(): Promise<{
  backends: BackendStatus[];
  models: ModelSummary[];
  profiles: Profile[];
}> {
  const [profiles, omlx, ollama, gguf, llamaCpp] = await Promise.all([
    loadProfiles() as Promise<Profile[]>,
    omlxStatus(),
    ollamaTags(),
    scanGgufModels(),
    llamaCppInfo(),
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

  // Ollama: disk is the catalog (manifests under ~/.ollama/models — works
  // with the server down, same policy as oMLX); live tags enrich with
  // capabilities and reported sizes when the server is up.
  const liveOllama = new Map(ollama.models.map((m) => [String(m.name ?? m.model), m]));
  const ollamaNames = new Set<string>();
  for (const disk of await scanOllamaModels()) {
    ollamaNames.add(disk.name);
    const live = liveOllama.get(disk.name);
    const caps: Record<string, unknown> = Object.fromEntries(
      (Array.isArray(live?.capabilities) ? live!.capabilities : []).map((c: string) => [c, true])
    );
    if (live?.details?.quantization_level) caps.quant = live.details.quantization_level;
    const profile = profiles.find((p) => profileMatchesModel(p, "ollama", disk.name));
    models.push({
      ref: formatModelRef({ backend: "ollama", id: disk.name }),
      backend: "ollama",
      id: disk.name,
      title: disk.name,
      sizeBytes: (typeof live?.size === "number" ? live.size : disk.sizeBytes) || profile?.modelSizeBytes,
      contextLength: profile?.capabilities?.contextLength as number | undefined,
      capabilities: profile?.capabilities ?? (Object.keys(caps).length ? caps : {}),
      status: profile ? "ready" : "setup",
      profileId: profile?.id,
    });
  }
  for (const m of ollama.models) {
    const id = String(m.name ?? m.model);
    if (ollamaNames.has(id)) continue; // already covered from disk
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
      sizeBytes: g.sizeBytes || profile?.modelSizeBytes,
      contextLength:
        (g.contextLength as number | undefined) ??
        (profile?.capabilities?.ctxSize as number | undefined),
      capabilities: profile?.capabilities ?? { quant: g.quant },
      status: profile ? "ready" : "setup",
      profileId: profile?.id,
    });
  }

  const llamaRunning = await llamaCppRunning(profiles as Profile[]);
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
      runningModels: omlx.runningModels,
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
      runningModels: ollama.runningModels,
    },
    {
      id: "llama-cpp",
      label: BACKENDS["llama-cpp"].label,
      type: BACKENDS["llama-cpp"].type,
      port: BACKENDS["llama-cpp"].defaultPort,
      baseUrl: BACKENDS["llama-cpp"].defaultBaseUrl,
      up: llamaCpp.installed,
      version: llamaCpp.version,
      modelCount: models.filter((m) => m.backend === "llama-cpp").length,
      runningModels: llamaRunning,
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
    // The chat API apps hit when the model is running (OpenAI-compatible:
    // `${baseUrl}/chat/completions`). The hub proxies nothing — this is the
    // backend's own endpoint, served by the server the hub starts.
    api: profile ? chatApiFor(profile) : undefined,
  };
  if (ref.backend === "omlx") {
    const settings = await readOmlxModelSettings(ref.id).catch(() => null);
    if (settings && Object.keys(settings).length) detail.omlxModelSettings = settings;
  }
  return detail;
}

/** The chat API a running profile serves — what an app points at to use
 *  the model. One definition, used by the model detail DTO and the start
 *  job's metrics. Profiles store the base with a /v1 suffix (all three
 *  backends) — normalize so both conventions come out canonical. */
export function chatApiFor(profile: any): { baseUrl: string; model: string } {
  const base = String(profile.baseUrl ?? "").replace(/\/v1\/?$/, "");
  return { baseUrl: `${base}/v1`, model: effectiveModelId(profile) };
}

// ── Setup (read model) ──────────────────────────────────────────────────────

// Same presets and cache types as the CLI heatmap (questions.mjs) so the
// web form and the CLI picker agree cell-for-cell.
const HEATMAP_CTXS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
const HEATMAP_CACHES = ["bf16", "q8_0", "q4_0"];

// llama.cpp only: the heatmap is computed from the GGUF on disk by the real
// estimator. oMLX/Ollama models get null (server-side settings instead).
// Detected capabilities + the model's max context ride along so the setup
// form can render MTP/vision/thinking switches before any profile exists.
export async function setupInfo(ref: ModelRef): Promise<{
  ref: string;
  heatmap: MemoryHeatmap | null;
  profile?: Profile;
  capabilities?: Record<string, unknown>;
  maxCtx?: number;
} | null> {
  const detail = await modelDetail(ref);
  if (!detail) return null;
  let heatmap: MemoryHeatmap | null = null;
  let capabilities: Record<string, unknown> | undefined;
  let maxCtx: number | undefined;
  if (ref.backend === "llama-cpp") {
    const { detectGgufCapabilities } = await import("../../capabilities.mjs");
    const { models } = await scanGgufModels();
    const g = models.find((m) => m.path === ref.id);
    if (g?.path) {
      const caps = detectGgufCapabilities(g.path, g.mmprojPath ?? null) as Record<string, unknown>;
      capabilities = caps;
      maxCtx = (caps.contextLength as number | undefined) ?? undefined;
      const prepared = prepareMemoryEstimate(g.path, g.mmprojPath ?? null, null);
      const fixedBytes =
        prepared.modelBytes + prepared.mmprojBytes + prepared.draftBytes + prepared.overheadBytes;
      const ctxs = HEATMAP_CTXS.filter((ctx) => !maxCtx || ctx <= maxCtx);
      heatmap = {
        modelId: ref.id,
        ramInstalledGB: installedRamGB(),
        ramAvailable: availableRamBytes(),
        fixedBytes,
        modelBytes: prepared.modelBytes,
        mmprojBytes: prepared.mmprojBytes,
        overheadBytes: prepared.overheadBytes,
        kvLayers: prepared.kvParams.layers ?? 0,
        maxCtx: ctxs.length ? Math.max(...ctxs) : HEATMAP_CTXS[0],
        caches: HEATMAP_CACHES,
        grid: (ctxs.length ? ctxs : [HEATMAP_CTXS[0]]).map((ctx) => ({
          ctx,
          cells: HEATMAP_CACHES.map(
            (c) =>
              computeMemoryTotal(prepared, { ctxSize: ctx, cacheTypeK: c, cacheTypeV: c })
                .totalBytes
          ),
        })),
      };
    }
  }
  if (ref.backend === "omlx" || ref.backend === "ollama") {
    heatmap = await managedHeatmap(ref);
    maxCtx = heatmap?.maxCtx;
  }
  return { ref: detail.ref, heatmap, profile: detail.profile, capabilities, maxCtx };
}

// ── Managed-backend heatmap (oMLX / Ollama) ────────────────────────────────
//
// The same ctx × KV-quant grid as the GGUF one, derived from each backend's
// own architecture facts using the CLI's canonical per-element byte factors
// (bytesForCacheType), so a cell means the same thing on every backend:
//   oMLX    — config.json on disk (works with the server down); the KV-quant
//             axis is turboquant (bf16 / q4 / q8)
//   Ollama  — /api/show model_info (needs the server up; honest null + the
//             reason when it's down); the axis is OLLAMA_KV_CACHE_TYPE
// Cells are weights + KV cache (runtime overhead is backend-specific and
// excluded — the numbers stay derived, never invented).

const MANAGED_CACHES = {
  omlx: ["bf16", "q4", "q8"],
  ollama: ["bf16", "q8_0", "q4_0"],
} as const;

async function managedHeatmap(ref: ModelRef): Promise<MemoryHeatmap | null> {
  // Architecture facts → { layers, kvHeads, headDim, maxCtx } | null
  let facts: { layers: number; kvHeads: number; headDim: number; maxCtx: number } | null = null;
  let modelBytes = 0;
  if (ref.backend === "omlx") {
    const modelDir = await findOmlxModelDir(ref.id);
    const raw = modelDir ? await readOmlxModelConfig(modelDir).catch(() => null) : null;
    if (!raw) return null;
    // Vision/multimodal checkpoints keep the text-model facts under
    // text_config; plain models have them at the root.
    const config = (raw.text_config && typeof raw.text_config === "object" ? raw.text_config : raw);
    const layers = Number(config.num_hidden_layers) || 0;
    const attnHeads = Number(config.num_attention_heads) || 0;
    const kvHeads = Number(config.num_key_value_heads) || attnHeads;
    const headDim = Number(config.head_dim) || (attnHeads ? Math.floor(Number(config.hidden_size) / attnHeads) : 0);
    if (!layers || !kvHeads || !headDim) return null; // facts not derivable — no fake grid
    facts = { layers, kvHeads, headDim, maxCtx: Number(config.max_position_embeddings) || 32768 };
    modelBytes = (await scanOmlxModelSizes().catch(() => new Map<string, never>())).get(ref.id)?.sizeBytes ?? 0;
  } else {
    let info: any;
    try {
      info = await ollamaModelInfo(ref.id);
    } catch {
      return null; // server down — the setup read explains why there's no grid
    }
    const mi = info?.model_info ?? {};
    // model_info keys are prefixed by the model's architecture family
    // ("general.architecture": "qwen3" → "qwen3.block_count", …).
    const arch = String(mi["general.architecture"] ?? "");
    const num = (key: string) => Number(arch ? mi[`${arch}.${key}`] : undefined) || 0;
    const layers = num("block_count");
    const embedding = num("embedding_length");
    const headCount = num("attention.head_count");
    const kvHeads = num("attention.head_count_kv") || headCount;
    if (!layers || !embedding || !headCount) return null;
    facts = {
      layers,
      kvHeads,
      headDim: Math.floor(embedding / headCount),
      maxCtx: num("context_length") || 32768,
    };
    modelBytes =
      (await scanOllamaModels().catch(() => [])).find((m) => m.name === ref.id)?.sizeBytes ?? 0;
  }

  const caches = [...MANAGED_CACHES[ref.backend as "omlx" | "ollama"]];
  const kvBytesPerToken = (cache: string) => {
    // oMLX turboquant bits map onto the same per-element factors the GGUF
    // estimator uses (q4 → q4_0, q8 → q8_0).
    const type = cache === "q4" ? "q4_0" : cache === "q8" ? "q8_0" : cache;
    const perElement = bytesForCacheType(type) ?? 2;
    return 2 * facts!.layers * facts!.kvHeads * facts!.headDim * perElement;
  };
  const ctxs = HEATMAP_CTXS.filter((ctx) => ctx <= facts!.maxCtx);
  const grid = (ctxs.length ? ctxs : [HEATMAP_CTXS[0]]).map((ctx) => ({
    ctx,
    cells: caches.map((c) => modelBytes + ctx * kvBytesPerToken(c)),
  }));
  return {
    modelId: ref.id,
    ramInstalledGB: installedRamGB(),
    ramAvailable: availableRamBytes(),
    fixedBytes: modelBytes,
    modelBytes,
    mmprojBytes: 0,
    overheadBytes: 0,
    kvLayers: facts.layers,
    maxCtx: facts.maxCtx,
    caches,
    grid,
  };
}

// ── Autotune ────────────────────────────────────────────────────────────────

/** Latest sweep for a model, or null. `profiles` may be passed in by
 *  callers that already hold the catalog (allAutotune) — otherwise it is
 *  fetched only when a sweep actually exists. */
export async function autotuneFor(ref: ModelRef, profiles?: Profile[]): Promise<AutotuneRun | null> {
  const root = join(DATA_DIR, "autotune", slugModelId(ref.id));
  if (!existsSync(root)) return null;
  const runDirs = (await readdir(root)).filter((d) => !d.startsWith(".")).sort().reverse();
  for (const dir of runDirs) {
    const runDir = join(root, dir);
    const optimalPath = join(runDir, "optimal.json");
    if (!existsSync(optimalPath)) continue;
    const optimal = JSON.parse(await readFile(optimalPath, "utf8"));
    // The plan (full grid, settings per config) is the durable source for
    // what each config WAS; journal rows carry results (and, from the
    // journal-fix onward, settings too — plan wins on conflict).
    let plan: any[] = [];
    try {
      plan = JSON.parse(await readFile(join(runDir, "plan.json"), "utf8"));
    } catch {
      /* older run — no plan.json; journal rows carry what they carry */
    }
    const planById = new Map(plan.map((p) => [p.id, p]));
    // Journal rows carry every probed config; map to the scorecard shape.
    const configs: AutotuneRun["configs"] = [];
    const seen = new Set<string>();
    try {
      const journal = await readFile(join(runDir, "sweep.jsonl"), "utf8");
      for (const line of journal.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (!row.configId) continue;
        if (row.event === "config-failed") {
          // Attempted but no measurement — surface it (unless a later
          // config-done row for the same config supersedes the failure).
          if (seen.has(row.configId)) continue;
          configs.push({
            id: row.configId,
            label: row.label ?? row.configId,
            family: planById.get(row.configId)?.family ?? row.family ?? "",
            median: null,
            mad: 0,
            n: 0,
            accept: null,
            settings: planById.get(row.configId)?.settings ?? {},
            error: row.reason ?? "failed",
          });
          seen.add(row.configId);
          continue;
        }
        if (!row.summary || seen.has(row.configId)) continue;
        const p = planById.get(row.configId);
        configs.push({
          id: row.configId,
          label: row.label ?? row.configId,
          family: row.family ?? p?.family ?? "",
          median: row.summary.median,
          mad: row.summary.mad,
          n: row.summary.n,
          accept: row.summary.mtp?.accept ?? null,
          settings: row.settings ?? p?.settings ?? {},
        });
        seen.add(row.configId);
      }
    } catch {
      /* no journal — configs stay empty */
    }
    // Grid rows the sweep never reached (skipped or never attempted) still
    // belong in the config space — the matrix needs their settings.
    for (const p of plan) {
      if (seen.has(p.id) || p.tested === false) continue;
      configs.push({
        id: p.id,
        label: p.label ?? p.id,
        family: p.family ?? "",
        median: null,
        mad: 0,
        n: 0,
        accept: null,
        settings: p.settings ?? {},
      });
    }
    const owned = profiles ?? (await catalog()).profiles;
    const profile = owned.find((p) => profileMatchesModel(p, ref.backend, ref.id));
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
  // Scorecard "checks" arrive as a keyed object (scorer output); the Run
  // DTO's rows are an array. Tolerate either.
  function toCheckRows(checks: unknown): { label: string; earned: number; max: number; pass: boolean; detail?: string }[] {
    if (Array.isArray(checks)) return checks as never;
    const obj = (checks ?? {}) as Record<string, any>;
    return Object.values(obj).map((c) => ({
      label: c.label, earned: c.earned, max: c.max, pass: Boolean(c.pass), detail: c.detail,
    }));
  }
  const cap = (m.capture?.video as any)?.quality ?? {};
  const tok: Record<string, any> = m.runner?.tokenMetrics ?? {};
  const spd = (m.runner as any)?.speedMetrics ?? {};
  const res = (m as any).results ?? {};

  let ds: Run["ds"] = null;
  if (m.dsScorecard && m.dsSummary) {
    ds = {
      // Hydration passes `checks` through as the raw scorer object — the
      // Run DTO promises an array; normalize here (one mapper, both paths).
      scorecard: {
        ...m.dsScorecard,
        checks: toCheckRows((m.dsScorecard as any).checks),
      } as Run["ds"] extends null ? never : any,
      summary: m.dsSummary as any,
    };
  } else if (m.kind === "data-science") {
    try {
      const sc = JSON.parse(await readFile(join(m.runDirectory, "scorecard.json"), "utf8"));
      const su = JSON.parse(await readFile(join(m.runDirectory, "summary.json"), "utf8"));
      ds = {
        scorecard: {
          total: sc.total,
          earned: sc.earned,
          pct: sc.pct,
          checks: toCheckRows(sc.checks),
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

  // Asset availability was already resolved by listRunMetadata's hydrator
  // (one stat per candidate) — reuse it instead of re-statting per run.
  const preview = m.assets?.preview
    ? `/api/media/run/${m.benchmark.id}/${m.model.slug}/${m.runId}/${m.assets.preview}`
    : null;
  // html presence drives the card state ("needs capture" vs "slot") — same
  // rule the gallery's runCardState uses.
  const html = Boolean(m.assets?.html);
  // Constrained media: prefer the Safari-friendly mp4, fall back to webm.
  const video = (m.assets?.videoMp4 ?? m.assets?.video)
    ? `/api/media/run/${m.benchmark.id}/${m.model.slug}/${m.runId}/${m.assets?.videoMp4 ?? m.assets?.video}`
    : null;

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
    updatedAt: m.updatedAt ?? m.createdAt ?? null,
    html,
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
    video,
    ds,
    ownerRef: null, // attached by allRuns once the catalog is known
  };
}

export async function allRuns(): Promise<Run[]> {
  const runsRoot = await resolveRunsRoot();
  if (!runsRoot) return [];
  const [metadata, { models, profiles }] = await Promise.all([
    // skipPromptText: the Run DTO never uses prompt.md content — hydration
    // stat-checks assets either way, but must not read the file.
    listRunMetadata(runsRoot, { skipPromptText: true }),
    catalog(),
  ]);
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
  const { models, profiles } = await catalog();
  const out: AutotuneRun[] = [];
  for (const m of models) {
    const run = await autotuneFor({ backend: m.backend as ModelRef["backend"], id: m.id }, profiles);
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
  let defs;
  try {
    defs = await loadBenchmarks(benchmarksDir);
  } catch (err) {
    // A missing/unreadable dir is an honest empty catalog; a parse error
    // (bad frontmatter, duplicate id) must not silently hide every prompt.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  return defs.map((d) => ({
    id: d.id,
    title: d.title,
    kind: d.kind,
    description: d.description,
    prompt: d.prompt,
  }));
}

// ── Settings (read model — real config, paths, harness, oMLX server) ────────

export async function settingsInfo(): Promise<Settings> {
  const config = await loadConfig();
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  const scanDirs = await getModelScanDirs();
  const runsRoot = await resolveRunsRoot();

  // The oMLX app's own settings file — sections keyed, read-only display.
  let omlxServerSettings: Record<string, Record<string, unknown>> | null = null;
  try {
    omlxServerSettings = JSON.parse(
      await readFile(join(homedir(), ".omlx", "settings.json"), "utf8")
    );
  } catch {
    /* oMLX not installed or settings not created yet */
  }

  return {
    version: pkg.version,
    dataDir: DATA_DIR,
    logDir: LOG_DIR,
    hfCacheDir: HF_HUB_DIR,
    benchmarkRepoPath: config.benchmarkRepoPath ?? null,
    benchmarkRepoFound: runsRoot != null,
    scanDirs,
    harness: config.harness,
    harnesses: listHarnesses().map((h: any) => ({ id: h.id, label: h.label, active: h.id === config.harness })),
    config: {
      modelScanDirs: config.modelScanDirs ?? [],
      binaryOverrides: config.binaryOverrides ?? {},
      lastSeenVersion: config.lastSeenVersion ?? null,
      enable_benchmarking: Boolean(config.enable_benchmarking),
      enable_omlx: Boolean(config.enable_omlx),
      enable_ollama: Boolean(config.enable_ollama),
    },
    omlxServerSettings,
  };
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
