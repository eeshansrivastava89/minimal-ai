# Changelog

All notable changes to offgrid-ai are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/) starting from v0.18.44.

## [0.27.3] - 2026-07-11

### Fixed
- **Update loop when npm cache is stale** — after `npm install -g offgrid-ai@latest` completes, offgrid-ai now verifies the installed version actually changed. If npm reports success but the version is still the same (a known npm cache issue), the user is shown a specific message: "npm reported success but the version is still v0.27.x. This is usually an npm cache issue. Try: npm cache verify && npm install -g offgrid-ai@latest". Previously, offgrid-ai trusted npm's exit code and printed "Updated" even when the install didn't take effect, causing an infinite update loop on the next launch.

## [0.27.2] - 2026-07-11

### Fixed
- **Release notes bullet indent** — continuation lines from wrapping now use a flat 2-space indent matching the first line, instead of a 4-space hanging indent that created a visual gap.

## [0.27.1] - 2026-07-11

### Fixed
- **Release notes display redesigned** — changelog entries shown on update now render in a cyan-bordered card matching the status header style, with text wrapped to terminal width, `**bold**` markdown converted to terminal bold, hanging-indent bullets, and blank-line section separators. Previously, long entries overflowed past the terminal edge with no wrapping, and markdown asterisks showed as literal text.

## [0.27.0] - 2026-07-11

### Added
- **Dynamic page size for model picker** — the select prompt now shows all choices that fit the terminal height instead of a hardcoded cap of 20. Users with many models will no longer have the Download/Manage sections hidden below the fold.
- **OLLAMA_HOST env var support** — offgrid-ai now respects the `OLLAMA_HOST` environment variable (same as Ollama itself) for non-default bind addresses. Previously hardcoded to `127.0.0.1:11434`.

### Changed
- **Server startup timeout scales by model size** — the 180s fixed timeout for llama-server startup now scales: 180s base + 10s per GB of model size, capped at 600s (10min). Large models on slow disks will no longer get a false "Timed out" error. Preflight inference timeout scales similarly (120s base, capped at 300s).
- **Block models with missing `context_length` in GGUF metadata** — instead of guessing 32k/80k (which could OOM on low-RAM machines or silently truncate context), models without `context_length` in their GGUF metadata are now blocked with a clear error message explaining the issue.
- **maxTokens derived from context size** — Pi harness config now uses `profile.flags.ctxSize` (the model's configured context window) instead of a hardcoded 16384. Models that support longer output will get their full capability.
- **Memory estimate overhead scales with model size** — the fixed 1GB overhead in memory estimates is now `max(256MB, 5% of model size)`, more accurate for both small and large models. The quant picker's `2GB` rough estimate is now 10% of model size.
- **Context label handles sub-1000 correctly** — context windows below 1000 tokens now show the raw number (e.g. "512") instead of misleadingly rounding to "1k". Shared `formatCtxLabel()` helper in `ui.mjs` replaces three duplicate implementations.
- **Projector weights show actual file size** — the vision projector memory display now shows the real `formatBytes()` of the mmproj file instead of a hardcoded "~200 MB".
- **Timeout bumps for reliability** — server readiness check 1s→2s, fetchJson 1s→2s, oMLX/Ollama model scan 3s→5s, oMLX start command 30s→60s.

### Fixed
- **Lower presence penalty for non-thinking models** — default `presencePenalty` reduced from 1.5 to 1.0 for general (non-thinking) models. The previous value was aggressive and could cause incoherent output with some models.
- **DRY: Ollama URL duplication** — `download.mjs` now imports `OLLAMA_URLS` from `ollama-runtime.mjs` instead of redefining the hardcoded URL.

## [0.26.5] - 2026-07-11

### Changed
- **Read quant from GGUF metadata (`general.file_type`) instead of filename** — GGUF files store an integer `general.file_type` field in metadata that maps to llama.cpp's `enum llama_ftype`, covering ~40 quant types. This is the authoritative source — the file knows its own quant. Previously, offgrid-ai parsed the quant from the filename, which broke on edge cases (Q6_K, IQ4_XS, sharded files). Now `detectCapabilities` and `scanGgufModels` both read `general.file_type` first, falling back to filename parsing only for UD- (Unsloth Dynamic) and MLX-style names not in the llama_ftype enum. The `LLAMA_FTYPE_NAMES` mapping table and `resolveQuant()` helper live in `gguf.mjs` (the GGUF metadata reader) to avoid circular dependencies.

## [0.26.4] - 2026-07-11

### Changed
- **Replaced regex-based quant parsing with known-quant lookup table** — the old approach used regex patterns to *guess* the quant from a filename, which broke on edge cases (Q6_K without suffix, IQ4_XS truncating to IQ4_, sharded BF16 files). The new approach maintains an explicit list of ~60 known GGUF/MLX quant names (`KNOWN_QUANTS` in `model-name.mjs`) and matches against the filename tail. Adding a new quant is a one-line addition to the array — no regex to maintain. Shard suffixes (e.g. `-00001-of-00002`) are stripped before matching.

## [0.26.3] - 2026-07-11

### Fixed
- **Quant name parsing** — `Q6_K` (no suffix) was not matched by the quant regex, causing the full model name to appear in the quant picker instead of just "Q6_K". Also fixed `IQ4_XS` and `IQ4_NL` which were truncated to `IQ4_` (the `XS`/`NL` suffix was left in the model name). Added `Q\d_K\b` pattern for bare K-quants, and fixed the IQ pattern to capture full suffixes.

## [0.26.2] - 2026-07-11

### Changed
- **Unified memory calculations** — all RAM/fit math now uses shared helpers from `hardware.mjs`:
  - `GB` constant exported from `hardware.mjs`, replacing inline `1024 ** 3` in `download.mjs` and `estimate.mjs`
  - `fitCheck(totalBytes, availableBytes)` — single canonical fit check (70% green, 90% yellow, >90% red), replacing two incompatible systems: `profile-setup.mjs` used ratio vs total RAM, `download.mjs` used absolute bytes vs available RAM. Both now use the same helper.
  - `fitColor()` moved to `ui.mjs`, delegates to `fitCheck` — used by heatmap and quant picker
  - `renderMemoryEstimate()` moved to `ui.mjs` — replaces duplicate implementations in `profile-setup.mjs` and `run.mjs`
- **Heatmap now uses available RAM** — the context × KV cache heatmap in profile setup previously compared estimates against total installed RAM. Now uses `availableRamBytes()` (free + reclaimable pages), consistent with the quant picker.

## [0.26.1] - 2026-07-11

### Fixed
- **Select lists no longer cycle** — all `@inquirer/prompts` select lists (quant picker, model picker, action menus, settings) now stop at the top and bottom instead of wrapping around. Set `loop: false` on both `prompt.choice` and `modelSelect`.
- **RAM calculation in quant picker** — replaced hardcoded `totalRAM - 4GB` with actual available memory via `vm_stat` on macOS (free + inactive + speculative + purgeable pages). The old calculation showed 44 GB available on a 48 GB machine with 60% OS usage, leading to recommendations that would swap to disk. Now shows real reclaimable memory.

## [0.26.0] - 2026-07-11

### Added
- **GPU layers setting** — `--n-gpu-layers` is now passed to llama-server (defaults to 99 = all layers on GPU). Configurable in the profile setup wizard with guidance: "99: recommended for Apple Silicon (unified memory) · 0: CPU-only fallback". Previously offgrid-ai did not pass this flag at all, causing llama.cpp to default to 0 (CPU-only) — a real performance gap for large models.
- **MTP draft tokens setting** — `--spec-draft-n-max` is now configurable in the profile setup wizard (range 1–8, default 2). Prompt appears after enabling MTP. Previously hardcoded to 4 with no UI to change it. Default changed from 4 to 2 per Unsloth's recommendation for Qwen3.6 MTP models.

### Changed
- MTP info card in profile setup no longer shows a hardcoded "Flags" line — instead the draft tokens prompt follows the enable/disable question.
- Configuration summary now shows "GPU layers" and "MTP (enabled, N draft tokens)" when applicable.

## [0.25.1] - 2026-07-11

### Fixed
- **Block MLX repos in llama.cpp download path** — downloading an MLX repo through "GGUF from HuggingFace (for llama.cpp)" was silently allowed but llama.cpp cannot run MLX. Now shows an actionable error directing the user to the oMLX backend.
- **Clarified download labels** — "Model from Ollama library (for Ollama)" and "GGUF from HuggingFace (for Ollama)" replace the vaguer "from Ollama library" and "via Ollama" labels.

## [0.25.0] - 2026-07-11

### Added
- **Divider and Badge UI helpers** — `divider(label)` renders a dim horizontal rule with an optional section label. `badge(text, variant)` renders a colored status indicator. Both inspired by termcn's component vocabulary, implemented as pure functions in `ui.mjs` (no new dependencies).

### Changed
- **Flattened download options** — download paths are now top-level menu items in the main picker, no sub-menus. Each option is self-describing:
  - "↓ GGUF from HuggingFace (for llama.cpp)"
  - "↓ from Ollama library (e.g. qwen3:8b)"
  - "↓ GGUF from HuggingFace (via Ollama)"
  - "↓ oMLX model (managed by oMLX app)"
  Download functions (`downloadHfGguf`, `downloadOllamaLibrary`, `downloadOllamaHfGguf`, `downloadOmlxStub`) are exported individually from `download.mjs`. The legacy `downloadFlow` sub-menu remains for onboarding.
- **Split Status & Settings into two screens** — "Runtime status & running models" shows installed backends, server state, and running models with a stop action. "Discovery paths" shows scan directories with add/remove actions. Previously these were one overloaded screen.
- **Section separators in main menu** — action items are grouped under dim "Download" and "Manage" dividers for visual organization.
- **Top/bottom spacing** — blank line before the header card and after the picker for cleaner terminal appearance.
- Created GitHub issue #3 for termcn/Ink adoption (deferred — would require adding React as a dependency).

## [0.24.0] - 2026-07-11

### Added
- **Load-all-modules test** — every `.mjs` file in `src/` and `src/commands/` is now dynamically imported at test time. If any module has a broken import (imports symbol X from module A when X lives in module B), the test fails at load time. This catches the #1 recurring bug class that ESLint's `no-undef` cannot detect.
- **Named-import validation script** (`scripts/verify-imports.mjs`) — parses every `.mjs` file, extracts named imports, and verifies the source module actually exports those names. Runs as part of `npm test` before the test suite. Catches the "imported from wrong module" bug class that caused the v0.23.1 regression.

### Changed
- **Data-driven model ID resolution** — `effectiveModelId` and new `managedModelId` now read `modelIdFields` from the backend definition in `BACKENDS`, replacing 13+ hardcoded `omlxModel ?? ollamaModel ?? modelAlias` chains across 7 files. New backends just add `modelIdFields` to their `BACKENDS` entry — no changes to any other file.
- **`createManagedProfile` data-driven** — no longer hardcodes `omlx`/`ollama` backend IDs; uses `modelIdFields[0]` from the backend definition.
- **`runCommand` renamed to `execCommand`** in `exec.mjs` — was colliding with the CLI handler `runCommand` in `commands/run.mjs`. Same name, completely different semantics; grep couldn't distinguish them. All 6 importers updated.
- **`installHfCli` moved to `huggingface.mjs`** — was in `download.mjs` but all other HuggingFace CLI functions live in `huggingface.mjs`. This was the exact kind of misplaced export that caused the v0.23.1 wrong-source import bug.
- **`isProfileServerUp` removed** — was a 1-line wrapper around `serverReady(profile.baseUrl)` adding no value. Sole caller updated to use `serverReady` directly.
- **`serverReady` import path standardized** — all 7 importers now import directly from `server-check.mjs`. Removed from `process.mjs` barrel.
- **Removed orphaned `recommendations.mjs`** — no production code imported it; only a test did. `resources/recommendations.json` removed from npm package.
- Health: 6,881 LLOC, complexity 1,297, 0 circular deps, 0 lint warnings, 110/110 tests.

## [0.23.1] - 2026-07-11

### Fixed
- **Broken module load** — `models-delete.mjs` imported `removeFromPiConfig` from `profiles.mjs` instead of `harness-pi.mjs`, causing a load-time failure that prevented the CLI from starting (and thus the auto-updater from running).

## [0.23.0] - 2026-07-11

### Added
- **Benchmarking feature flag** — `enable_benchmarking` in `~/.offgrid-ai/config.json` (disabled by default). When disabled, the Benchmark action is hidden from the model picker entirely. Uses the same pattern as `enable_omlx` and `enable_ollama`. To enable: `"enable_benchmarking": true` in config.json.

### Changed
- **Phase 3 god-module split** — split the three largest files into focused modules:
  - `src/commands/models.mjs` (812 → ~340 lines): extracted `models-benchmark.mjs` (benchmark logic), `models-delete.mjs` (model deletion), `models-settings.mjs` (settings flow). Zero external churn — only `cli.mjs` imports `modelsCommand`.
  - `src/process.mjs` (613 → ~20 lines): converted to a re-export barrel. Implementation split into `server-command.mjs` (command derivation + script rendering), `server-lifecycle.mjs` (start/stop/unload), `server-status.mjs` (status checks, preflight, HTTP utils). All 6 external consumers unchanged.
  - `src/profile-setup.mjs` (590 → ~450 lines): extracted `profile-flags.mjs` (pure flag-application engine: `applyRuntimeFlagOverrides`, `removeMtpDefaults`, and all `apply*`/`remove*` helpers). Test file updated to import from new location.
- **`hfRepoFromPath` moved to `huggingface.mjs`** — was a private helper in `models.mjs`, now exported from `huggingface.mjs` and shared by `models-benchmark.mjs` and `models-delete.mjs`.
- Health: 6,790 LLOC, complexity 1,293, 0 circular deps, 0 lint warnings, 0.79% duplication, 65/65 tests.

## [0.22.0] - 2026-07-10

### Added
- **Stop server action** — when a model's server is running, the action menu now shows "Stop server" (active) and dims "Start server" as "Already running". Works for both local llama.cpp (stops process) and managed servers (unloads model from memory).
- **Running models card in Settings** — the Settings screen now shows a green-bordered card listing all running model servers (model name, backend, status, URL) when any are active. Includes a "Stop a running server" menu option to stop individual servers without leaving the settings flow.

## [0.21.1] - 2026-07-10

### Changed
- **Architecture audit cleanup** — comprehensive DRY/KISS/dead-code cleanup across all 51 files:
  - **Bug fix:** `getFreeDiskBytes` returned `MAX_SAFE_INTEGER` on statfs failure, silently bypassing disk-space checks. Now returns 0.
  - **Removed dead code:** `statusText` (unused export), `wrapVisible` (1-line wrapper), `OLLAMA_URLS` import (unused), unreachable rescan loop in `modelCommandCenter`, dead ternary in `parseModelName` (both branches returned `""`).
  - **Removed `createPrompt().close()` no-op** — was a no-op method called in 6 `finally` blocks. Removed all call sites.
  - **Consolidated DRY violations:** `safeReadGgufMetadata` (2 copies → 1 in `gguf.mjs`), `numberMeta` (2 copies → 1 in `gguf.mjs`), `sleep` (3 copies → 1 in `exec.mjs`), duplicate `serverReady` (2 functions → 1 in `server-check.mjs`), `which <binary>` pattern (6 sites → `commandExists`), merged `installOllama`/`updateOllama` (~80% shared → `installOrUpdateOllama`).
  - **Added helpers:** `effectiveModelId(profile)` in `profiles.mjs` (replaces 9 inconsistent `omlxModel ?? ollamaModel ?? modelAlias ?? ...` chains), `isManaged(profile)` in `backends.mjs`.
  - **Data-driven refactors:** `friendlyLine` 9-branch if/else → table, `readValue` 13-branch if/else → type-reader array, `cli.mjs` command dispatch 8-if ladder → map.
  - **Simplified `fetchJson`:** removed unused `{ok, reason, data}` return shape → `Promise<data | null>`.
  - **Surfaced 8 silent catches:** `harness-pi.mjs` (skills, packages, web-search, settings), `config.mjs` (config write), `uninstall.mjs` (npm uninstall), `status.mjs` (du), `onboard.mjs` (Pi install) — all now print the actual error message.
  - **Removed "Recommended" download stub** — was a dead path that only printed a README link.
  - **Extracted `server-check.mjs`** — `serverReady` moved to standalone module to break circular dependency introduced by ollama-runtime importing from process.mjs.
  - **Removed `slugFromLabel` alias** — inlined to `sanitizeProfileId`. Un-exported `notesPath` (internal only).
  - Net: -87 LLOC, -34 complexity, 0 circular deps, 0 lint warnings.

## [0.21.0] - 2026-07-10

### Added
- **Benchmark profiles** — selecting "Benchmark" now shows a sub-menu with three presets:
  - **Quick** (~30s) — pp=2048, tg=128, 3 runs, single concurrency. Smoke test.
  - **Standard** (~2 min) — pp=2048/4096/8192, tg=128, depth=0/4096, 3 runs. Tests scaling with prompt size and context.
  - **Thorough** (~5-10 min) — pp=2048/4096/8192/16384, tg=256, depth=0/4096/8192, 5 runs, concurrency=1/2. Full profile including parallel requests.

## [0.20.2] - 2026-07-10

### Fixed
- **Benchmark failed for local llama.cpp models** — llama-benchy auto-detected the model ID as the GGUF filename, which isn't a valid HuggingFace namespace/model. Now passes `--model` (HF repo ID from cache path) and `--served-model-name` (filename the server expects) explicitly.
- **Benchmark now gated on HF model availability** — models without a HuggingFace repo ID (oMLX models, Ollama library models, loose GGUF files) show the Benchmark action as dimmed with "Needs HF model for tokenizer" instead of failing at runtime. Ollama models pulled from HuggingFace (`hf.co/org/repo:quant`) are supported.

## [0.20.1] - 2026-07-10

### Fixed
- **Release notes were invisible** — `startInteractive()` called `console.clear()` after notes were printed, wiping them before the user could see them. Moved `showReleaseNotesIfUpdated()` to run after the screen clear, just before the status header and picker.

## [0.20.0] - 2026-07-10

### Added
- **Pre-flight inference test** — before launching Pi, sends a 1-token chat completion request to verify the model can actually generate, not just that the server is listening. Catches model-load failures (Metal kernel errors, unsupported architectures, corrupted weights) and surfaces an actionable error instead of letting Pi hit a broken model. On failure, stops the server (local) or unloads the model (managed).

## [0.19.0] - 2026-07-12

### Added
- **"Start server" action** in model picker — starts model server without launching Pi. Reuses `runProfile({ with: "server" })`.
- **"Benchmark" action** in model picker — starts server, runs `llama-benchy` (via `uvx`, zero-install), cleans up. Works with both llama-server and Ollama.
- **Release notes display** — on startup, if the installed version is newer than the last seen version (tracked in `config.json`), prints what's new from `CHANGELOG.md`. When an update is available, fetches the changelog from GitHub and previews the coming changes.
- **CHANGELOG.md** — historical release notes for all versions, bundled in the npm package.
- **Versioning convention** documented in `AGENTS.md` — `feat:` bumps minor, `fix:`/`refactor:`/`chore:` bumps patch.

### Changed
- **Deprecated "Recommended for your machine"** download option — now a stub linking to README.
- **Download flow restructured** into separate paths: HuggingFace (GGUF + MLX to HF cache), Ollama (library + HF GGUF), oMLX (stub).
- MLX downloads go to HF cache, no longer routed to `~/.omlx/models/` or gated on `enable_omlx`.
- Removed GGUF auto-routing to Ollama (v0.18.41 approach, superseded).
- Removed oMLX from download flow — managed server, users download via oMLX app.
- `saveConfig()` is now exported from `config.mjs`.

## [0.18.44] - 2026-07-12

### Added
- "Start server" and "Benchmark" actions in model picker (superseded by v0.19.0 entry above).

## [0.18.43] - 2026-07-12

### Changed
- **Deprecated "Recommended for your machine"** download option — now a stub that links to the README recommended models table.
- Added "Recommended models" table to README with all 8 models from `recommendations.json` (HuggingFace links, min RAM, GGUF + MLX).
- Removed `allFittingModels` from download flow. Recommendations maintenance is now via README, not code.

## [0.18.42] - 2026-07-12

### Changed
- **Restructured download flow** into separate, independent paths:
  - "Download a model from Hugging Face" — HF CLI to HF cache (GGUF + MLX)
  - "Download an Ollama model" (when `enable_ollama`) — two sub-options: Ollama library (text input) and HF GGUF (quant picker → `ollama pull`)
  - "Download an oMLX model" (when `enable_omlx`) — stub: directs to oMLX app
- Removed GGUF auto-routing to Ollama (v0.18.41 approach, user rejected).
- MLX downloads now go to HF cache instead of `~/.omlx/models/`.
- MLX no longer gated on `omlxEnabled()` — available as a format regardless.
- Removed oMLX from download flow entirely (no gating, no hints, no restart).

## [0.18.41] - 2026-07-11

### Added
- Initial Ollama download flow — auto-routed GGUF through `ollama pull` when Ollama enabled.

### Note
- This approach was superseded by v0.18.42. Auto-routing took away user choice and coupled HF downloads to Ollama.

## [0.18.40] - 2026-07-11

### Fixed
- Separated `updateOllama()` from `installOllama()` — update always runs `brew upgrade`, install skips when already installed.

## [0.18.39] - 2026-07-11

### Fixed
- `installOllama()` now checks if already installed before attempting reinstall.
- Brew link failures handled gracefully — if binary is available despite link conflicts, treat as success.
- `startAndWaitForServer()` polls `GET /v1/models` for up to 30 seconds with progress dots.

## [0.18.38] - 2026-07-10

### Added
- `loadConfig()` auto-creates `config.json` with `DEFAULT_CONFIG` on first run (ENOENT) so users can find and edit feature flags.
- Status header card shows version number (`offgrid-ai v0.18.x`).

## [0.18.37] - 2026-07-10

### Added
- **Ollama backend behind feature flag** (`enable_ollama: false` by default).
- New file: `src/ollama-runtime.mjs` — discovery, install, version checking, server lifecycle, model scanning, model info, pull, delete, unload.
- `BACKENDS.ollama` entry: managed-server type, port 11434.
- Gated scanning, profiling, model management, CLI update check, status header.
- To enable: `"enable_ollama": true` in `~/.offgrid-ai/config.json`.

## [0.18.36] - 2026-07-10

### Added
- **oMLX feature flag** (`enable_omlx: false` by default).
- `omlxEnabled(config)` function — checks config.json only, no env var.
- Gated 8 entry points. Existing oMLX profiles preserved on disk but hidden when disabled.
- To enable: `"enable_omlx": true` in `~/.offgrid-ai/config.json`.

## [0.18.35] - 2026-07-10

### Fixed
- DRY cleanup: replaced `promisify(execFile)` with `execFileAsync` from `exec.mjs` in `harness-pi.mjs`.
- `status.mjs`: replaced sync `execFileSync` with async `execFileAsync`.
- `models.mjs`: replaced duplicate inline `fetch` with `serverReady()` from `process.mjs`.
- `modelReasoning()` now uses `profile.capabilities?.thinking` as single source of truth.
- Removed unused `providerId` args from `piApiKey()` and `providerCompat()` call sites.

### Added
- Hard block on Windows with clear message.

## [0.18.34] - 2026-07-09

### Changed
- Dead code removal + DRY cleanup (-94 lines). Removed circular dependency.

## [0.18.33] - 2026-07-09

### Fixed
- Update prompts now default to Yes ((Y/n) not (y/N)).

## [0.18.32] - 2026-07-08

### Added
- Auto-update for llama.cpp runtime and oMLX. MTP verification on install.

## [0.18.31] - 2026-07-08

### Added
- Context × KV cache heatmap with system RAM color coding. Single combined flow, K=V by default.

## [0.18.30] - 2026-07-07

### Fixed
- Aligned model picker table for setup items.

## [0.18.29] - 2026-07-07

### Fixed
- Ctrl+C during download no longer drops PATH (`trap ":" INT` on login shell).
- Ctrl+C cancels model downloads — SIGINT → SIGKILL escalation for `hf` CLI.

## [0.18.28] - 2026-07-06

### Fixed
- Reverted oMLX install to DMG app approach with user info message.

## [0.18.27] - 2026-07-06

### Changed
- Replaced `@clack/prompts` with `@inquirer/prompts`. Escape key cancels prompts.

## [0.18.26] - 2026-07-05

### Added
- Grouped model picker by inference backend. Improved model picker grouping.

## [0.18.25] - 2026-07-05

### Fixed
- Deduplicated oMLX models by normalized full name in scan.

## [0.18.24] - 2026-07-04

### Changed
- Structural simplification — removed `commandArgv` from profile schema. DRY consolidation.

## [0.18.23] - 2026-07-04

### Added
- Replaced Pi subprocess with Pi SDK in benchmark runner.

## [0.18.22] - 2026-07-03

### Fixed
- Set `maxTokens=16384` in Pi model config. Send `max_tokens` (not `max_completion_tokens`) to local servers.

## [0.18.21] - 2026-07-03

### Added
- Consistent model names with publisher/model + quant column.

## [0.18.20] - 2026-07-02

### Fixed
- Strip ANSI codes in model-presenter tests for CI.

## [0.18.19] - 2026-07-02

### Added
- oMLX model sizes from disk. Consistent context window and size in model selector.

## [0.18.18] - 2026-07-01

### Added
- Auto-detect MTP drafter models and wire into profiles.

## [0.18.17] - 2026-07-01

### Added
- Show missing model files in red across catalog and detail views.

## [0.18.16] - 2026-06-30

### Fixed
- Dim MTP memory-fitting errors. Include drafter in memory estimate.
- Re-setup now re-detects MTP and drafter from disk.
- Compact model cards, allow re-setup.

## [0.18.15] - 2026-06-30

### Added
- Manage llama.cpp runtime — auto-detect, install, update.

## [0.18.14] - 2026-06-29

### Changed
- Simplified terminal UI. Added explicit `models` and `run` commands.

## [0.18.13] - 2026-06-29

### Added
- Model management — delete models from disk, remove configurations, reconfigure settings.

## [0.18.12] - 2026-06-28

### Added
- Model download with quant picker + RAM fit indicators. Removed LM Studio onboarding.

## [0.18.11] - 2026-06-28

### Fixed
- Disk space check at correct download target. Auto-download vision projector (mmproj) alongside GGUF model.

## [0.18.10] - 2026-06-27

### Fixed
- KV cache estimation for models with missing `key_length`. Filter MTP drafters from quant picker.

## [0.18.9] - 2026-06-27

### Added
- Backend-aware download completion. Show tqdm progress bars during download.

## [0.18.8] - 2026-06-26

### Fixed
- Consistent missing-model behavior for oMLX and llama.cpp profiles.

## [0.18.7] - 2026-06-26

### Added
- Ask user for GGUF vs MLX format when both available in recommendations.

## [0.18.6] - 2026-06-25

### Fixed
- Show quant in all model labels for consistency. Disambiguate Qwen 3.6 35B recommendations.

## [0.18.5] - 2026-06-25

### Fixed
- Download MLX directly to `~/.omlx/models/`. Backend-aware completion.

## [0.18.4] - 2026-06-24

### Fixed
- Symlink MLX downloads into `~/.omlx/models` so oMLX discovers them.

## [0.18.3] - 2026-06-24

### Fixed
- Download MLX to HF cache + restart oMLX.

## [0.18.2] - 2026-06-24

### Fixed
- Remove symlink approach, point MLX downloads to oMLX app.

## [0.18.1] - 2026-06-24

### Fixed
- Show progress during long installs (brew, oMLX, Homebrew, Pi).

## [0.18.0] - 2026-06-23

### Added
- **Model management** — download, configure, delete, reconfigure models.
- Download constraints (disk space, RAM fit).
- Codebase cleanup.

## [0.17.0] - 2026-06-20

### Changed
- Stripped benchmark feature. Replaced with glass-box setup flow.
- Added status & settings UI.
- Context × KV cache estimation.

## [0.16.0] - 2026-06-18

### Changed
- Removed `mlx-vlm` backend. Enhanced oMLX managed runtime.
- MTP as feature, not backend. oMLX MTP support via admin API.

## [0.15.0] - 2026-06-15

### Added
- Replaced `@clack/prompts` with `@inquirer/prompts`.
- Grouped model picker by inference backend.
- Separator below prompt, box width + text wrapping for detail views.

## [0.14.0] - 2026-06-12

### Added
- Replaced Pi subprocess with Pi SDK in benchmark runner.
- Streaming display in SDK benchmark runner.

## [0.13.0] - 2026-06-10

### Changed
- Refactored server command computation from profile config.

## [0.12.0] - 2026-06-08

### Fixed
- Set `maxTokens=16384` in Pi model config.

## [0.11.0] - 2026-06-05

### Added
- Consistent model names with publisher/model + quant column.

## [0.10.0] - 2026-06-03

### Fixed
- Strip ANSI codes in model-presenter tests for CI.

## [0.9.0] - 2026-06-01

### Added
- Auto-update notifier — checks npm registry once per 24h.

## [0.8.0] - 2026-05-28

### Added
- Benchmark server lifecycle integration, summary table, cancellation.

## [0.7.0] - 2026-05-25

### Added
- Workspace UX — model cards, dynamic column alignment.

## [0.6.0] - 2026-05-20

### Added
- Model-first interactive UX — select model then action.
- Auto-detect MTP drafter models.
- Model detail cards before actions.

## [0.3.0] - 2026-05-10

### Added
- Interactive backend install in onboarding. Uninstall command.
- RAM-based model recommendations + auto-download.

## [0.2.0] - 2026-05-05

### Added
- LM Studio as recommended backend. `lms` CLI on PATH. Model download commands.

## [0.1.0] - 2026-05-01

### Added
- Initial release. npm publish infrastructure, privacy gate, CI.
- Core modules: discovery, profiling, server lifecycle.
- curl-based installer script.