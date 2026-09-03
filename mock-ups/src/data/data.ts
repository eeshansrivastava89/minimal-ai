import type { HubData } from "./types";

// Real data snapshot (2026-08-27). See ../data.js for provenance notes.
// ============================================================================
// Minimal Intelligence Hub — mock-up dataset.
// Every value here is REAL, read from the live machine on 2026-08-27:
//   ~/.minimal-ai/profiles/*/profile.json
//   ~/.minimal-ai/config.json
//   ~/.omlx/model_settings.json + settings.json
//   http://127.0.0.1:8000/api/status  (oMLX 0.6.3rc3, live)
//   http://127.0.0.1:11434/api/tags   (Ollama, live)
//   ~/.minimal-ai/autotune/*/sweep.jsonl + optimal.json + results.md
//   local-llm-visual-benchmark/runs/**/metadata.json  (see runs.js)
// Nothing is invented. Simulated *behavior* (buttons, live progress) is
// clearly marked in the UI as a mock-up.
// ============================================================================

export const HUB_DATA: HubData = {
  meta: {
    app: "Minimal Intelligence",
    version: "3.3.1",
    capturedAt: "2026-08-27",
    note: "Real data snapshot; interactions are simulated.",
  },

  // ── Hardware (sysctl + system_profiler) ──────────────────────────────────
  hardware: {
    chip: "Apple M4 Pro",
    ramBytes: 51539607552, // 48 GB
    ramLabel: "48 GB",
    metal: "Metal 4",
    platform: "darwin-arm64",
  },

  // ── minimal-ai config.json ───────────────────────────────────────────────
  config: {
    harness: "pi",
    lastSeenVersion: "3.3.0",
    modelScanDirs: [],
    binaryOverrides: {},
    enable_benchmarking: true,
    enable_omlx: true,
    enable_ollama: true,
    benchmarkRepoPath: "/Users/eeshans/dev/local-llm-visual-benchmark",
    dataDir: "~/.minimal-ai",
  },

  // ── Backends ─────────────────────────────────────────────────────────────
  // Versions captured 2026-09-02: oMLX GET /api/status, Ollama GET /api/version,
  // `llama-server --version` → build 9430 (d48a56eff).
  backends: [
    { id: "llama-cpp", label: "llama.cpp", type: "local-server", port: 8080, baseUrl: "http://127.0.0.1:8080/v1", version: "b9430" },
    { id: "omlx", label: "oMLX", type: "managed-server", port: 8000, baseUrl: "http://127.0.0.1:8000/v1", version: "0.6.3rc3" },
    { id: "ollama", label: "Ollama", type: "managed-server", port: 11434, baseUrl: "http://127.0.0.1:11434/v1", version: "0.33.2" },
  ],

  // ── oMLX live server status (http://127.0.0.1:8000/api/status) ───────────
  omlxStatus: {
    status: "ok",
    version: "0.6.3rc3",
    uptimeSeconds: 1314.9,
    modelsDiscovered: 7,
    modelsLoaded: 0,
    modelsLoading: 0,
    defaultModel: "Qwen3.5-9B-MTPLX-Optimized-Speed",
    loadedModels: [],
    totalRequests: 0,
    activeRequests: 0,
    waitingRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCachedTokens: 0,
    cacheEfficiency: 0.0,
    avgPrefillTps: 0.0,
    avgGenerationTps: 0.0,
    modelMemoryUsed: 0,
    modelMemoryMax: 34947433240, // 32.55 GB
    customKernels: {
      bonsai: true,
      glm_moe_dsa: true,
      minimax_m3: true,
      qwen35_prefill: true,
    },
    anePrefill: { patchAvailable: true, configuredModels: 0, models: [] },
  },

  // ── Saved profiles (~/.minimal-ai/profiles) ──────────────────────────────
  profiles: [
    {
      id: "omlx-qwen3.8-27b-4bit",
      label: "mlx-community/Qwen 3.8 27B",
      backend: "omlx",
      modelAlias: "Qwen3.8-27B-4bit",
      modelSizeBytes: 16054541349,
      baseUrl: "http://127.0.0.1:8000/v1",
      thinkingLevel: "low",
      thinkingOff: true,
      capabilities: {
        architecture: "qwen3_5",
        quant: null,
        thinking: true,
        vision: true,
        mtp: false,
        contextLength: 262144,
      },
      createdAt: "2026-08-23T19:06:07.994Z",
      updatedAt: "2026-08-24T05:21:29.766Z",
      lastUsedAt: "2026-08-26T04:09:16.452Z", // autotune recommendedAt
    },
    {
      id: "omlx-qwen3.5-9b-mtplx",
      label: "Qwen3.5-9B-MTPLX-Optimized-Speed",
      backend: "omlx",
      modelAlias: "Qwen3.5-9B-MTPLX-Optimized-Speed",
      baseUrl: "http://127.0.0.1:8000/v1",
      capabilities: {
        architecture: "qwen3_5",
        thinking: true,
        vision: true,
        mtp: true,
        contextLength: 262144,
      },
      createdAt: "2026-08-26T04:25:34.115Z",
      updatedAt: "2026-08-26T04:25:34.115Z",
      lastUsedAt: "2026-08-27T01:07:19.517Z", // autotune recommendedAt
    },
    {
      id: "omlx-qwen3.5-4b-optiq-4bit",
      label: "mlx-community/Qwen 3.5 4B OptiQ",
      backend: "omlx",
      modelAlias: "Qwen3.5-4B-OptiQ-4bit",
      modelSizeBytes: 4023432097,
      baseUrl: "http://127.0.0.1:8000/v1",
      thinkingLevel: "high",
      capabilities: {
        architecture: "qwen3_5",
        quant: null,
        thinking: true,
        vision: true,
        mtp: false,
        contextLength: 262144,
      },
      createdAt: "2026-07-09T07:21:23.835Z",
      updatedAt: "2026-08-27T00:30:36.156Z",
      lastUsedAt: "2026-08-26T16:30:38.341Z", // autotune recommendedAt
    },
    {
      id: "ollama-qwen3.8-27b-mlx",
      label: "Qwen 3.8",
      backend: "ollama",
      modelAlias: "qwen3.8:27b-mlx",
      modelSizeBytes: 18174721847,
      baseUrl: "http://127.0.0.1:11434/v1",
      thinkingLevel: "off",
      capabilities: {
        vision: true,
        servedContext: 262144,
        architecture: "qwen3_5",
        quant: "nvfp4",
        thinking: true,
        tools: true,
        mtp: false,
        contextLength: 262144,
      },
      createdAt: "2026-08-16T19:51:05.779Z",
      updatedAt: "2026-08-25T04:07:36.260Z",
      lastUsedAt: "2026-08-24T06:26:26.155Z", // latest benchmark run createdAt
    },
    {
      id: "unsloth-gemma-4-e2b-it",
      label: "unsloth/Gemma 4 E2B (it)",
      backend: "llama-cpp",
      modelAlias: "unsloth/gemma-4-E2B-it-Q4_K_M",
      source: "huggingface",
      modelPath: "~/.cache/huggingface/hub/models--unsloth--gemma-4-E2B-it-GGUF/…/gemma-4-E2B-it-Q4_K_M.gguf",
      mmprojPath: "~/.cache/huggingface/hub/models--unsloth--gemma-4-E2B-it-GGUF/…/mmproj-BF16.gguf",
      baseUrl: "http://127.0.0.1:8080/v1",
      capabilities: {
        architecture: "gemma4",
        thinking: true,
        vision: true,
        mtp: false,
        qat: false,
        imatrix: true,
        quant: "Q4_K_M",
        metaCtx: 131072,
        mmprojProjectorType: "gemma4v",
        ctxSize: 131072,
      },
      flags: {
        host: "127.0.0.1",
        port: 8080,
        ctxSize: 131072,
        nGpuLayers: 99,
        flashAttention: "on",
        cacheTypeK: "f16",
        cacheTypeV: "f16",
        jinja: true,
        temperature: 1,
        topP: 0.95,
        topK: 64,
        minP: 0,
        presencePenalty: 0,
        repeatPenalty: 1.1,
        parallel: 1,
        batchSize: 512,
        specDraftNMax: 2,
        chatTemplateKwargs: { enable_thinking: true },
      },
      createdAt: "2026-07-12T04:20:59.833Z",
      updatedAt: "2026-07-12T04:20:59.833Z",
      lastUsedAt: "2026-07-26T17:06:52.970Z", // last launch, ~/.minimal-ai/run state + logs
    },
  ],

  // ── oMLX discovered models (live GET /v1/models) ─────────────────────────
  omlxModels: [
    { id: "Qwen3.5-4B-OptiQ-4bit", maxModelLen: 262144, kind: "chat" },
    { id: "Qwen3.5-9B-DFlash", maxModelLen: 262144, kind: "chat" },
    { id: "Qwen3.5-9B-MTPLX-Optimized-Speed", maxModelLen: 262144, kind: "chat" },
    { id: "Qwen3.8-27B-4bit", maxModelLen: 262144, kind: "chat" },
    { id: "Qwen3.8-27B-DFlash2", maxModelLen: 262144, kind: "chat" },
    { id: "z-lab--Qwen3.5-9B-DFlash", maxModelLen: 262144, kind: "draft" },
    { id: "z-lab--Qwen3.8-27B-DFlash2", maxModelLen: 262144, kind: "draft" },
    { id: "MarkItDown", maxModelLen: null, kind: "helper" },
  ],

  // ── Ollama models (live GET /api/tags) ───────────────────────────────────
  ollamaModels: [
    {
      id: "qwen3.8:27b-mlx",
      sizeBytes: 18174721847,
      quant: "nvfp4",
      capabilities: ["completion", "vision", "tools", "thinking"],
    },
  ],

  // ── GGUF models on disk (scan) ───────────────────────────────────────────
  ggufModels: [
    {
      id: "unsloth/gemma-4-E2B-it-Q4_K_M",
      label: "unsloth/Gemma 4 E2B (it)",
      quant: "Q4_K_M",
      architecture: "gemma4",
      vision: true,
      thinking: true,
      imatrix: true,
      ctxSize: 131072,
      source: "huggingface",
    },
  ],

  // ── llama.cpp memory heatmap (real: estimate.mjs on the live machine, ───
  // 2026-09-02; 48 GB M4 Pro, 21.5 GB available at capture time)
  memoryHeatmaps: [
    {
      modelId: "unsloth/gemma-4-E2B-it-Q4_K_M",
      ramInstalledGB: 48,
      ramAvailable: 21506818048,
      fixedBytes: 4362005440,
      modelBytes: 3106736256,
      mmprojBytes: 986833728,
      overheadBytes: 268435456,
      kvLayers: 35,
      maxCtx: 131072,
      caches: ["bf16", "q8_0", "q4_0"],
      grid: [
        { ctx: 4096, cells: [4451134400, 4409355200, 4387072960] },
        { ctx: 8192, cells: [4526631872, 4449463232, 4408306624] },
        { ctx: 16384, cells: [4677626816, 4529679296, 4450773952] },
        { ctx: 32768, cells: [4979616704, 4690111424, 4535708608] },
        { ctx: 65536, cells: [5583596480, 5010975680, 4705577920] },
        { ctx: 131072, cells: [6791556032, 5652704192, 5045316544] },
      ],
    },
  ],

  // ── Autotune results (real sweeps, ~/.minimal-ai/autotune) ───────────────
  // settings deltas follow grid.mjs; summaries are the real measured medians.
  autotune: [
    {
      modelId: "Qwen3.5-9B-MTPLX-Optimized-Speed",
      profileId: "omlx-qwen3.5-9b-mtplx",
      runId: "2026-08-27T01-03-04.374Z",
      recommendedAt: "2026-08-27T01:07:19.517Z",
      recommended: "mtp",
      noChange: false,
      reasoning:
        "MTP on — 38.5 tps, accept 56.2% (+21% vs vanilla 32.0 tps). Beauty path: MTP + thinking + budget at 48.0 tps, accept 75.4% — its tps counts thinking tokens as if they were output (wall-clock, the thinking-off path was faster), so it's a quality alternative, not a speed win.",
      dflashDraft: "z-lab/Qwen3.5-9B-DFlash",
      configs: [
        { id: "vanilla", label: "vanilla", family: "baseline", median: 31.95, mad: 0.2, n: 4, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: false } },
        { id: "mtp", label: "MTP on", family: "speculative", median: 38.5, mad: 0.35, n: 4, accept: 56.2, settings: { mtp_enabled: true, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: false } },
        { id: "dflash", label: "DFlash on", family: "speculative", median: 28.35, mad: 0.05, n: 4, accept: null, settings: { mtp_enabled: false, dflash_enabled: true, dflash_draft_model: "z-lab/Qwen3.5-9B-DFlash", enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: false } },
        { id: "thinking", label: "thinking + budget", family: "thinking", median: 30.15, mad: 0.35, n: 4, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: true, thinking_budget_enabled: true, thinking_budget_tokens: 4096, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: false } },
        { id: "mtp-thinking", label: "MTP + thinking + budget", family: "thinking", median: 47.95, mad: 0.35, n: 4, accept: 75.4, settings: { mtp_enabled: true, dflash_enabled: false, enable_thinking: true, thinking_budget_enabled: true, thinking_budget_tokens: 4096, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: false } },
        { id: "ane", label: "ANE prefill", family: "ane", median: 31.0, mad: 0.2, n: 4, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: true, turboquant_kv_enabled: false } },
        { id: "turboquant-q4", label: "turboquant q4", family: "kvquant", median: 31.0, mad: 0.2, n: 4, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: true, turboquant_kv_bits: 4 } },
        { id: "turboquant-q8", label: "turboquant q8", family: "kvquant", median: 30.5, mad: 0.2, n: 4, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: true, turboquant_kv_bits: 8 } },
      ],
    },
    {
      modelId: "Qwen3.5-4B-OptiQ-4bit",
      profileId: "omlx-qwen3.5-4b-optiq-4bit",
      runId: "2026-08-26T16-28-41.152Z",
      recommendedAt: "2026-08-26T16:30:38.341Z",
      recommended: "vanilla",
      noChange: false,
      reasoning:
        "vanilla — 57.5 tps. Beauty path: thinking + budget at 54.9 tps.",
      dflashDraft: null,
      configs: [
        { id: "vanilla", label: "vanilla", family: "baseline", median: 57.5, mad: 0.55, n: 4, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: false } },
        { id: "thinking", label: "thinking + budget", family: "thinking", median: 54.9, mad: 0.45, n: 4, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: true, thinking_budget_enabled: true, thinking_budget_tokens: 4096, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: false } },
        { id: "ane", label: "ANE prefill", family: "ane", median: 56.1, mad: 0.0, n: 4, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: true, turboquant_kv_enabled: false } },
        { id: "turboquant-q4", label: "turboquant q4", family: "kvquant", median: 56.25, mad: 0.0, n: 4, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: true, turboquant_kv_bits: 4 } },
        { id: "turboquant-q8", label: "turboquant q8", family: "kvquant", median: 54.45, mad: 0.0, n: 4, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: true, turboquant_kv_bits: 8 } },
      ],
    },
    {
      modelId: "Qwen3.8-27B-4bit",
      profileId: "omlx-qwen3.8-27b-4bit",
      runId: "2026-08-26T04-01-01.480Z",
      recommendedAt: "2026-08-26T04:09:16.452Z",
      recommended: "dflash",
      noChange: false,
      reasoning:
        "DFlash on — 17.2 tps (+29% vs vanilla 13.3 tps). Beauty path: thinking + budget at 14.0 tps.",
      dflashDraft: "z-lab/Qwen3.8-27B-DFlash2",
      configs: [
        { id: "vanilla", label: "vanilla", family: "baseline", median: 13.3, mad: 0.1, n: 3, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: false } },
        { id: "dflash", label: "DFlash on", family: "speculative", median: 17.2, mad: 0.0, n: 3, accept: null, settings: { mtp_enabled: false, dflash_enabled: true, dflash_draft_model: "z-lab/Qwen3.8-27B-DFlash2", enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: false } },
        { id: "thinking", label: "thinking + budget", family: "thinking", median: 14.0, mad: 0.2, n: 3, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: true, thinking_budget_enabled: true, thinking_budget_tokens: 4096, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: false } },
        { id: "ane", label: "ANE prefill", family: "ane", median: 14.2, mad: 0.0, n: 3, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: true, turboquant_kv_enabled: false } },
        { id: "turboquant-q4", label: "turboquant q4", family: "kvquant", median: 13.7, mad: 0.3, n: 3, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: true, turboquant_kv_bits: 4 } },
        { id: "turboquant-q8", label: "turboquant q8", family: "kvquant", median: 13.7, mad: 0.1, n: 3, accept: null, settings: { mtp_enabled: false, dflash_enabled: false, enable_thinking: false, thinking_budget_enabled: false, qwen35_ane_prefill_enabled: false, turboquant_kv_enabled: true, turboquant_kv_bits: 8 } },
      ],
    },
  ],

  // ── Benchmarks (real prompts, local-llm-visual-benchmark/benchmarks) ──────
  benchmarks: [
    {
      id: "macro-wildflower-meadow",
      title: "Macro Wildflower Meadow",
      kind: "visual",
      description: "Close-up colorful meadow scene with detailed butterflies, bees, flowers, and wind motion.",
      prompt: "Create a full-screen animated close-up meadow scene on a bright breezy day, as if viewed from inside a small patch of wildflowers. Show foreground flowers with detailed petals, stems, and leaves, with butterflies and bees moving through the scene on curved flight paths. Use a vivid, saturated color palette with fresh greens and warm sunlight. Add wind motion: stems sway gently, petals flutter, and insects ride small gusts.",
    },
    {
      id: "sakura",
      title: "Sakura Tree",
      kind: "visual",
      description: "Dreamy Japanese cherry blossom tree animation with falling petals.",
      prompt: "Animate a dreamy Japanese cherry blossom tree in full bloom during a gentle petal storm. Use dark, elegant lines for the trunk and branches with pink-white blossoms throughout, and have thousands of delicate petals fall continuously with realistic physics — subtle rotation, wind-curved paths, varied speeds, and occasional small gusts. Add a soft pastel sky gradient from light pink to lavender, distant misty mountains, and subtle sunlight from the top right.",
    },
    {
      id: "snow-globe-village",
      title: "Snow Globe Village",
      kind: "visual",
      description: "Magical snow globe with a cozy winter village, swirling snow, glass shine, and Santa sleigh loop.",
      prompt: "Create a full-screen animated snow globe with a cozy alpine winter village inside. Build small houses with glowing windows, pine trees, and snowy hills within the globe, and animate thousands of snowflakes swirling with layered depth and believable globe-like physics — circular wind currents, varied speeds, and gentle rotation. Make the glass dome convincing with curved highlights, soft reflections, and a bright specular shine. Add warm bokeh holiday lights in the dark background.",
    },
    {
      id: "solar-system",
      title: "Solar System",
      kind: "visual",
      description: "Realistic animated solar system with visible planets and orbital motion.",
      prompt: "Build an HTML animation of the solar system with the Sun at the center and all planets orbiting around it. Keep all planets visible while preserving the relative scale of orbital distances, with realistic planet colors and visible rings where appropriate. Include as many realistic visual details as practical — a glowing sun, orbital paths, and distinct planet appearances.",
    },
    {
      id: "sunset-ocean-study",
      title: "Sunset Ocean Study",
      kind: "visual",
      description: "Golden-hour ocean scene with rolling waves, reflected sunlight, and atmospheric rays.",
      prompt: "Create a full-screen animated ocean sunset viewed from low above the water, looking toward the horizon. The sun sits partially below the horizon in late golden hour, with broad rolling waves moving toward the viewer and bright reflected highlights forming a shimmering path from the sun to the foreground. Use a warm palette of amber, peach, coral, and lavender, with stretched clouds glowing near the horizon.",
    },
    {
      id: "ab-test-analysis",
      title: "A/B Test Production Analysis",
      kind: "data-science",
      description: "Run a full production A/B test analysis against live Supabase data, including statistical tests, guardrail checks, visualizations, and a grounded ship/don't-ship recommendation.",
      prompt: "The A/B Simulator is a Pineapple Finder memory game. Variant A has 4 pineapples, Variant B has 5. Data lives in a Supabase posthog_events table that records player interactions from live randomized traffic. Run a full production A/B test analysis: statistical tests, guardrail checks, visualizations, and a grounded ship/don't-ship recommendation.",
    },
  ],

  // ── oMLX per-model settings (real, ~/.omlx/model_settings.json) ──────────
  // The full key set oMLX persists per model — shown in the settings surface.
  omlxSettingKeys: [
    { key: "max_context_window", label: "Max context window", group: "sampling" },
    { key: "max_tokens", label: "Max tokens", group: "sampling" },
    { key: "temperature", label: "Temperature", group: "sampling" },
    { key: "top_p", label: "Top-p", group: "sampling" },
    { key: "top_k", label: "Top-k", group: "sampling" },
    { key: "force_sampling", label: "Force sampling", group: "sampling" },
    { key: "enable_thinking", label: "Enable thinking", group: "thinking" },
    { key: "thinking_budget_enabled", label: "Thinking budget", group: "thinking" },
    { key: "thinking_budget_tokens", label: "Budget tokens", group: "thinking" },
    { key: "mtp_enabled", label: "MTP (own heads)", group: "speculative" },
    { key: "vlm_mtp_enabled", label: "VLM MTP", group: "speculative" },
    { key: "dflash_enabled", label: "DFlash", group: "speculative" },
    { key: "dflash_draft_model", label: "DFlash draft", group: "speculative" },
    { key: "dflash_draft_quant_enabled", label: "Draft quant", group: "speculative" },
    { key: "dflash_in_memory_cache", label: "Draft in-memory cache", group: "speculative" },
    { key: "dflash_ssd_cache", label: "Draft SSD cache", group: "speculative" },
    { key: "turboquant_kv_enabled", label: "TurboQuant KV", group: "kv-quant" },
    { key: "turboquant_kv_bits", label: "KV bits", group: "kv-quant" },
    { key: "turboquant_skip_last", label: "KV skip last", group: "kv-quant" },
    { key: "qwen35_ane_prefill_enabled", label: "ANE prefill", group: "ane" },
    { key: "qwen35_ane_prefill_sequence_length", label: "ANE sequence length", group: "ane" },
    { key: "qwen35_ane_prefill_fraction", label: "ANE fraction", group: "ane" },
    { key: "qwen35_ane_prefill_dual_ane", label: "ANE dual", group: "ane" },
    { key: "qwen35_ane_prefill_gdn", label: "ANE GDN", group: "ane" },
    { key: "specprefill_enabled", label: "Spec prefill", group: "ane" },
    { key: "guided_grammar_enabled", label: "Guided grammar", group: "other" },
    { key: "is_pinned", label: "Pinned", group: "other" },
    { key: "is_default", label: "Default", group: "other" },
    { key: "is_favorite", label: "Favorite", group: "other" },
    { key: "trust_remote_code", label: "Trust remote code", group: "other" },
  ],

  // Real per-model settings for the models that have entries (subset shown).
  omlxModelSettings: {
    "Qwen3.8-27B-4bit": {
      max_tokens: 64000,
      enable_thinking: false,
      thinking_budget_tokens: 4096,
      dflash_enabled: true,
      dflash_draft_model: "~/.omlx/models/z-lab/Qwen3.8-27B-DFlash2",
      dflash_draft_quant_enabled: true,
      dflash_draft_quant_weight_bits: 4,
      dflash_block_size: 5,
      dflash_verify_mode: "dflash",
      mtp_enabled: false,
      turboquant_kv_enabled: false,
      turboquant_kv_bits: 4,
      qwen35_ane_prefill_enabled: false,
    },
    "Qwen3.5-9B-MTPLX-Optimized-Speed": {
      enable_thinking: false,
      thinking_budget_tokens: 4096,
      mtp_enabled: true,
      dflash_enabled: false,
      dflash_draft_model: "~/.omlx/models/z-lab/Qwen3.5-9B-DFlash",
      turboquant_kv_enabled: false,
      turboquant_kv_bits: 8,
      qwen35_ane_prefill_enabled: false,
    },
    "Qwen3.5-4B-OptiQ-4bit": {
      enable_thinking: true,
      thinking_budget_tokens: 4096,
      mtp_enabled: false,
      dflash_enabled: false,
      turboquant_kv_enabled: false,
      turboquant_kv_bits: 8,
      qwen35_ane_prefill_enabled: false,
    },
  },

  // ── oMLX server settings (real, ~/.omlx/settings.json) ───────────────────
  omlxServerSettings: {
    server: { host: "127.0.0.1", port: 8000, log_level: "info", auto_start_on_launch: true, burst_decode_mode: "balanced", preserve_mid_system_cache: true, distributed_inference_enabled: false },
    memory: { prefill_memory_guard: true, memory_guard_tier: "balanced", soft_threshold: 0.85, hard_threshold: 0.95, prefill_safe_zone_ratio: 0.8, prefill_min_chunk_tokens: 32 },
    scheduler: { max_concurrent_requests: 4, embedding_batch_size: 32, chunked_prefill: true, prefill_priority: "context", decode_fairness: true },
    cache: { enabled: true, hot_cache_only: false, gdn_ssd_split_enabled: true, ssd_cache_dir: "~/.omlx/cache", ssd_cache_max_size: "9GB", hot_cache_max_size: "0", initial_cache_blocks: 256 },
    sampling: { max_context_window: 80000, max_tokens: 32768, temperature: 1.0, top_p: 0.95, top_k: 0, repetition_penalty: 1.0 },
    integrations: { pi_model: "Qwen3.6-35B-A3B-OptiQ-4bit", copilot_model: "Qwen3.5-4B-OptiQ-4bit", markitdown_enabled: true, web_search_provider: "ddgs", web_search_max_results: 3 },
    idle_timeout: { idle_timeout_seconds: null },
  },

  // ── Learn (glass-box concepts) ────────────────────────────────────────────
  learn: [
    {
      id: "mtp",
      title: "MTP — multi-token prediction",
      tag: "Speculative decoding",
      body: "The model predicts several tokens at once using its own draft heads, then verifies them in one pass. When the guesses are right, you get more tokens per cycle for the same compute. Acceptance rate is the share of guessed tokens that were correct — higher is better, but a low rate wastes work.",
    },
    {
      id: "dflash",
      title: "DFlash — a separate draft model",
      tag: "Speculative decoding",
      body: "A small, fast 'draft' model proposes tokens and the big model checks them. DFlash is oMLX's engine for this. It only helps when the draft is trained on the same distribution as the target — a base draft paired with a personality fine-tune can actually slow things down.",
    },
    {
      id: "thinking-budget",
      title: "Thinking budget",
      tag: "Reasoning",
      body: "Reasoning models emit hidden 'thinking' tokens before answering. A budget caps how many, so a model can't burn minutes reasoning when a quick answer would do. The budget is only enforced with DFlash off — the DFlash path ignores it.",
    },
    {
      id: "kv-quant",
      title: "KV-cache quantization (TurboQuant)",
      tag: "Memory",
      body: "The KV cache stores every token's keys and values so the model doesn't recompute them. Quantizing it (q4/q8) shrinks memory so longer contexts fit — at a small quality cost. Speed/memory win now; long-context quality is the open question.",
    },
    {
      id: "ane-prefill",
      title: "ANE prefill",
      tag: "Apple Silicon",
      body: "Offloads part of prompt prefill to the Neural Engine (ANE) on Apple Silicon. It's a Qwen3.5/3.6/3.8-only feature (the server keys are literally qwen35_*). On other families the row would measure a no-op.",
    },
    {
      id: "context-window",
      title: "Context window",
      tag: "Memory",
      body: "How many tokens the model can 'see' at once. Bigger means longer documents and conversations, but the KV cache grows with it — a 262K window on a 27B model is a real memory commitment. The heatmap shows the trade-off.",
    },
    {
      id: "quantization",
      title: "Quantization",
      tag: "Memory",
      body: "Weights stored at lower precision (4-bit, 8-bit) so a model fits in less RAM. Q4_K_M, nvfp4, OptiQ are all quantization schemes. Lower bits = smaller + faster, with a small quality trade-off.",
    },
  ],
};
