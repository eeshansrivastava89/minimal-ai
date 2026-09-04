// Write DTOs (Zod) — the plan's typed seam for writes. Phase 2 reads share
// TS types; every Phase 3+ mutating endpoint validates its body here before
// anything touches the service layer.

import { z } from "zod";

const THINKING_LEVEL = z
  .string()
  .regex(/^(off|minimal|low|medium|high|xhigh|max)$/, "invalid thinking level");

export const DownloadDto = z.object({
  repo: z
    .string()
    .trim()
    .min(3, "repo required")
    .regex(/^[\w.-]+\/[\w.-]+(\/[\w.-]+)?$/, "want a HuggingFace repo id like org/model-GGUF"),
  filename: z.string().trim().min(1).max(255).nullish(),
});

export const SetupFormDto = z
  .object({
    // llama.cpp
    mtp: z.boolean().optional(),
    draftTokens: z.number().int().min(1).max(8).optional(),
    vision: z.boolean().optional(),
    thinkingDefaults: z.boolean().optional(),
    nGpuLayers: z.number().int().min(0).max(999).optional(),
    ctxSize: z.number().int().min(1024).optional(),
    cacheTypeK: z.enum(["bf16", "f16", "q8_0", "q4_0"]).optional(),
    cacheTypeV: z.enum(["bf16", "f16", "q8_0", "q4_0"]).optional(),
    samplers: z
      .object({
        temperature: z.number().min(0).max(2).optional(),
        topP: z.number().min(0).max(1).optional(),
        topK: z.number().int().min(0).max(1000).optional(),
        minP: z.number().min(0).max(1).optional(),
        presencePenalty: z.number().min(0).max(2).optional(),
        repeatPenalty: z.number().min(0).max(2).optional(),
      })
      .optional(),
    batchSize: z.number().int().min(1).max(4096).optional(),
    parallel: z.number().int().min(1).max(10).optional(),
    flashAttention: z.boolean().optional(),
    jinja: z.boolean().optional(),
    // managed (oMLX)
    mtpEnabled: z.boolean().optional(),
    thinkingOff: z.boolean().optional(),
    thinkingBudget: z.number().int().min(256).max(65536).nullable().optional(),
    // all backends
    thinkingLevel: THINKING_LEVEL.nullable().optional(),
  })
  .strict();

// Filesystem-safe run identity segments (the runs tree's own shape).
const SEG = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "invalid run path segment");

export const RunRefDto = z
  .object({
    bench: SEG,
    slug: SEG,
    runId: SEG,
  })
  .strict();

export const CaptureDto = RunRefDto.extend({
  force: z.boolean().optional(),
});

export const BenchmarkLaunchDto = z
  .object({
    benchmarkId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "invalid benchmark id"),
    keepServer: z.boolean().optional(),
    thinking: THINKING_LEVEL.optional(),
  })
  .strict();

export const ComparisonVideoDto = z
  .object({
    runs: z.array(RunRefDto).min(2, "pick 2 to 6 runs").max(6, "pick 2 to 6 runs"),
  })
  .strict();

export const ExportDto = z
  .object({
    publish: z.boolean().default(false),
  })
  .strict();

export const AutotuneStartDto = z
  .object({
    apply: z.boolean().default(true),
  })
  .strict();

export const JobEnqueueDto = z
  .object({
    type: z.enum([
      "download",
      "setup",
      "benchmark",
      "capture",
      "score",
      "comparison-video",
      "export",
      "autotune",
    ]),
    ref: z.string().optional(),
    title: z.string().max(200).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type DownloadInput = z.infer<typeof DownloadDto>;
export type SetupForm = z.infer<typeof SetupFormDto>;
export type RunRefInput = z.infer<typeof RunRefDto>;