# offgrid-ai Ecosystem Vision

Last updated: 2026-06-13

## Mission

offgrid-ai is a privacy-first CLI for running local LLMs — discover, configure, run, benchmark.
The biggest barrier for non-technical users is setup and configuration. offgrid-ai eliminates that barrier.

The ecosystem extends this mission across related tools that all share one thing:
**they need to talk to a local LLM, and that should be effortless.**

## Products

| Package | Purpose | Current name | Status |
|---|---|---|---|
| `offgrid-ai` | Control center: discover, configure, run, benchmark local models | offgrid-ai | Published npm, v0.8.10 |
| `offgrid-ai-benchmark` | Visual + data-science benchmarks for local LLMs | local-llm-visual-benchmark | Git clone, Astro app; benchmark runner embedded in offgrid-ai v0.8.10 |
| `offgrid-ai-sidequests` | Dev dashboard for local LLM workflows | (dev folder) | Prototype |
| `offgrid-ai-howiprompt` | Prompt analyzer / evaluator | (dev folder) | Prototype |

## Architecture Principles

### 1. Each tool works standalone

Every tool can run without any other tool installed:

```
npx offgrid-ai-benchmark --model http://localhost:8080/v1 --model-id qwen3.6-35b
```

You provide a model endpoint manually, and the tool does its job. No offgrid-ai required.

### 2. Paired mode is automatic — just read `~/.offgrid-ai/profiles/`

If offgrid-ai is installed and has model profiles, sub-tools auto-discover them:

```
npx offgrid-ai-benchmark
  → reads ~/.offgrid-ai/profiles/*.json
  → offers model selection from existing profiles
  → auto-fills base URL, model ID, backend label
```

No package dependency on offgrid-ai. No import. Just read JSON files from a known directory.
The data contract is the integration point, not the code.

### 3. Data contract: `~/.offgrid-ai/profiles/<id>/profile.json`

```json
{
  "id": "qwen3-6-35b",
  "label": "Qwen3.6 35B A3B MTP",
  "backend": "llama-cpp-mtp",
  "baseUrl": "http://localhost:8123",
  "modelAlias": "qwen3.6-35b-a3b-mtp",
  "capabilities": { "mtp": true, "thinking": true, "vision": false },
  "flags": { "ctxSize": 20480 }
}
```

Stable schema, self-describing, human-readable. Any tool can read this without importing offgrid-ai.

### 4. Home directories

```
~/.offgrid-ai/               ← control center
  profiles/                   ← model configs (the shared data contract)
  config.json                 ← global settings, benchmark repo path, etc.
  runtime/                    ← managed llama.cpp binary
  logs/

~/.offgrid-ai-benchmark/      ← benchmark tool
  config.json                 ← gallery settings, link to offgrid-ai

~/.offgrid-ai-sidequests/     ← dashboard
  config.json

~/.offgrid-ai-howiprompt/     ← prompt analyzer
  config.json
```

Each tool owns its own config. The only cross-tool data is the profiles directory.

## Current Duplication Problem

offgrid-ai and local-llm-visual-benchmark duplicate these functions:

| Function | offgrid-ai (`benchmark.mjs`) | benchmark repo | Risk |
|---|---|---|---|
| `buildToolPrompt` | Own copy | `prompt-prep.ts` | Prompt wording drifts (already happened) |
| `slugModelId` | Own copy | `paths.ts` | Slug format drifts → broken run paths |
| `createRunId` | Own copy | `paths.ts` | Date format drifts → mismatched run IDs |
| `loadBenchmarks` | Own copy | `benchmarks.ts` | Frontmatter parsing drifts |
| `prepareBenchmarkRun` | Hand-rolled metadata.json | `prompt-prep.ts prepareRun` | Metadata schema drifts |

This already caused a bug: the visual QA instruction was removed from the benchmark repo's `buildToolPrompt` but remained in offgrid-ai's copy. The offgrid-ai v0.8.10 benchmark automation works end-to-end, but it still duplicates these helpers; the migration below remains the path to a single source of truth.

## Migration Plan

### Phase 1: Add library exports to benchmark repo

Status: **not started**. The benchmark runner in offgrid-ai is functional, but `local-llm-visual-benchmark` is still a git-cloned Astro app, not an npm package.

Convert local-llm-visual-benchmark into a publishable npm package:

1. Add build step: `src/lib/*.ts` → `dist/lib/*.mjs`
2. Add `exports` to package.json:
   ```json
   {
     "exports": {
       ".": "./dist/lib/index.mjs"
     }
   }
   ```
3. Add `bin` entry for CLI: `offgrid-ai-benchmark prepare-run`
4. Bundle `benchmarks/` in the npm package
5. Publish as `offgrid-ai-benchmark` to npm (or keep current name during transition)

### Phase 2: offgrid-ai imports from the package

Status: **blocked on Phase 1**.

1. `npm install offgrid-ai-benchmark` as a dependency
2. Remove `buildToolPrompt`, `slugModelId`, `createRunId`, `loadBenchmarks`, `prepareBenchmarkRun` from offgrid-ai's `benchmark.mjs`
3. Import from the package:
   ```js
   import { prepareRun, loadBenchmarks, buildToolPrompt } from "offgrid-ai-benchmark";
   ```
4. Simplify `linkBenchmarkRepo` — no more git clone, just use the installed package's benchmark files

### Phase 3: Sidequests and howiprompt follow the same pattern

Each new tool:
- Publishes as its own npm package
- Has a CLI for standalone use
- Reads `~/.offgrid-ai/profiles/` for paired mode
- Has its own `~/.offgrid-ai-<tool>/config.json`

### Phase 4 (optional): Bundle as single package

```
npm install -g offgrid-ai    ← gets everything
  offgrid-ai benchmark      ← delegates to offgrid-ai-benchmark
  offgrid-ai sidequests      ← delegates to offgrid-ai-sidequests
  offgrid-ai howiprompt      ← delegates to offgrid-ai-howiprompt
```

Each subcommand just spawns the sub-tool's CLI. Users who want one tool can install just that package.

## Naming Convention

| Package | CLI command | Home dir |
|---|---|---|
| `offgrid-ai` | `offgrid-ai` | `~/.offgrid-ai` |
| `offgrid-ai-benchmark` | `offgrid-ai-benchmark` | `~/.offgrid-ai-benchmark` |
| `offgrid-ai-sidequests` | `offgrid-ai-sidequests` | `~/.offgrid-ai-sidequests` |
| `offgrid-ai-howiprompt` | `offgrid-ai-howiprompt` | `~/.offgrid-ai-howiprompt` |

Short aliases can be added later (`og`, `og-bench`, etc.) if desired.

## Key Decisions

- **Data contract over code dependency**: Tools read JSON profiles from disk, not import from each other
- **Each tool owns its home dir**: No tool writes to another tool's directory
- **Standalone first, paired second**: Every tool works without offgrid-ai
- **Shared repo vs. monorepo**: Start as separate repos, can merge into a monorepo later without changing the public API
- **TypeScript in the benchmark repo**: Keep it — compile to JS for npm publishing. offgrid-ai stays ESM JavaScript.