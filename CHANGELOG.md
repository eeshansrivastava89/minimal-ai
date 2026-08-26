# Changelog

All notable changes to minimal-ai (formerly offgrid-ai) are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/) starting from v0.18.44.

## [3.1.2] - 2026-08-26

### Fixed
- **Release-notes card no longer leaves the right half empty.** The
  changelog renderer wrapped text at a hardcoded 76 columns, then placed it
  in a card whose inner width is the full terminal — so the right side was
  just padding. It now wraps at the card's actual inner width. It also joins
  each bullet's hand-wrapped markdown lines into one paragraph before
  wrapping, which fixes the broken `on)` / `a` / `+` fragments that appeared
  on their own lines when the markdown's own line breaks got re-wrapped per
  line. `**bold**` and `` `code` `` spans are now styled.

## [3.1.1] - 2026-08-26

### Fixed
- **autotune results card no longer makes the recommendation look wrong.**
  Previously it sorted all configs by raw tps, so the beauty path (thinking on)
  ranked first while the fast path (thinking off) was recommended — it read
  like a bug. Now groups by path ("fast path — thinking off (raw output
  speed)" / "beauty path — thinking on (includes reasoning tokens)"), marks
  the recommended config with ★, and uses "≈ tie" (vs the opaque †) for
  within-2×-MAD differences. The recommendation is self-evident.
- **Recommender no longer dresses up a tie as a win.** If the fastest
  thinking-off config is within 2× MAD of vanilla, it recommends vanilla and
  flags `noChange`; the apply step restores your prior settings instead of
  applying a no-op. The reasoning now explains when the beauty path's higher
  raw tps is within noise of the fast path and counts thinking tokens (so not
  a reliable speed gain). `isThinkingOn` is exported for reuse.
- **autotune plan card no longer cuts off notes mid-phrase.** The notes column
  was hardcoded to 38 chars, leaving the right of a wide card unused. It now
  uses the full card inner width and truncates with an ellipsis only at
  genuinely narrow terminals.
- **autotune sweep progress no longer duplicates lines.** `withSpinner`
  printed the full "config i/n · label (est)" label twice (start + end) plus a
  third line repeating the label. Now one dim start line (index + estimate) +
  one result line (tps).
- autotune flow: collapsed the redundant "Tune mode" pick (only speed is
  enabled in v1; quality is stubbed for #20) + "Start the sweep?" into a single
  confirm after the plan, with blank-line spacing between sections.

### Changed
- `results.md` mirrors the new fast/beauty path grouping and "≈ tie" wording.

## [3.1.0] - 2026-08-25

### Added
- **Autotune is now reachable from the models menu for existing oMLX profiles.**
  Selecting an installed oMLX model now lists an "Autotune — Find the fastest
  oMLX settings (~30-60m)" action alongside Benchmark and Reconfigure, which
  runs the same `autotune` workflow as the `minimal-ai autotune <profile>`
  command and the post-download offer. Previously autotune was only reachable
  via the explicit CLI command or the prompt right after downloading a new
  managed model — there was no path to tune an already-installed model from
  the UI (#19 follow-up). Non-oMLX profiles omit the entry (autotune v1 is
  oMLX-only).

## [3.0.1] - 2026-08-25

### Fixed
- **3.0.0 was broken on install** — `minimal-ai` crashed immediately with
  `ERR_MODULE_NOT_FOUND: Cannot find module .../src/autotune/probe.mjs`. The
  new `src/autotune/` directory (probe/grid/sweep/recommend/safety) was never
  added to the `package.json` `files` allowlist, so `commands/autotune.mjs`
  shipped but its `../autotune/*` imports 404'd. Added `src/autotune/*.mjs` to
  `files`.
- Root-cause note: lint and tests run against the repo (where the imports
  resolve), and CI's only tarball gate was a file-count cap — the broken 3.0.0
  tarball was *under* the cap, so it shipped green. Raised the privacy-gate
  tarball file-count cap from 80 to 90 to fit the new source directory. A
  tarball import-resolution check is filed as a follow-up to catch this class
  of bug directly.

## [3.0.0] - 2026-08-25

### Added
- **autotune** (#19): a first-class `minimal-ai autotune [profile]` workflow that
  autonomously searches per-model oMLX settings for the fastest configuration.
  oMLX-only in v1; speed-tune (a quality/judge engine is filed as #20 for v2).
  - Capability probe (`probe.mjs`) inspects a model's MTP / DFlash / ANE /
    turboquant support, and programmatically imports MTPLX side-car MTP heads
    (some Qwen3.5/3.6 checkpoints ship `mtp.safetensors` unreferenced by the main
    index; oMLX reports `mtp_compatible:false` until imported — autotune calls
    `POST /admin/api/models/{id}/import-mtplx` for you, non-destructive and
    idempotent).
  - Speed engine: a trap-aware config grid (`grid.mjs` — MTP iff compatible,
    DFlash iff a matching draft exists and the target isn't a personality
    fine-tune, never stacks DFlash+MTP, thinking+budget forces DFlash off), a
    per-config state machine (`sweep.mjs`: precheck → PUT → cold → warm →
    teardown → journal) with a pure server.log parser and MAD confidence, and a
    fast-path / beauty-path recommender (`recommend.mjs`) that writes
    `optimal.json`. Sweeps resume from the journal on Ctrl-C/crash.
  - Safety layer (`safety.mjs`): lockfile, RAM gate, one-model invariant,
    settings snapshot/restore, and a journal — cancel/abort/apply-failure all
    restore; the lock always releases.
  - Wizard (`autotune.mjs`): pre-flight → mode pick → dry-run plan card →
    per-config sweep → report (`results.md` + `optimal.json` + terminal card
    with 2x-MAD noise flags) → apply (echo-verified PUT) / discard. After a new
    oMLX profile is saved, `models.mjs` offers to autotune now (defaults no).
  - `--yes` runs non-interactively and applies the recommendation (scripting/CI
    and the post-download hook path); `--dry-run` probes + shows the plan with
    no sweep, lock, or mutation; non-TTY without either errors clearly instead
    of hanging on a prompt.

### Fixed
- autotune discard now resets to the clean all-off vanilla baseline when the
  model had no settings entry before the sweep (oMLX has no delete-entry API),
  so a sweep can't leave its last config applied on discard/abort/apply-failure.
- autotune no longer aborts on builtin oMLX helpers like MarkItDown
  (`engine_type "markitdown"`, always `loaded:true` but not in the engine pool —
  unload 404s); helper engine types are excluded from the one-model invariant.

### Changed
- autotune restarts the oMLX server after a sweep to reclaim process memory:
  macOS pushes the server's cold pages to swap over a sweep and they aren't
  returned (a 9B+27B session left omlx-server at ~17 GB footprint with no model
  loaded); `restartOmlxServer()` in the sweep's `finally` drops it back to
  baseline. Applied settings persist to `~/.omlx/model_settings.json`, so the
  recommendation survives the restart.
- AGENTS.md documents the cross-repo visual benchmark harness
  (minimal-ai launches, `~/dev/local-llm-visual-benchmark` is the gallery on
  :4321) for future-agent context.

## [2.9.2] - 2026-08-25

### Fixed
- **Security:** hardened the HuggingFace download path against untrusted input. Repo IDs are validated (rejects flag-injection/traversal like `--foo/bar`) before reaching `hf download` args or API URLs; HF tree API JSON is guarded against path traversal, flag-injection filenames, and fabricated sizes; a final-boundary guard blocks filename flag-injection from a malicious repo before `spawn("hf", …)`.
- **Hidden fallbacks:** a transient `/models` network blip no longer makes a running model appear unloaded or falsely blocks launch. `fetchJson`/`ollamaLoadedModels` now return a discriminated result so callers distinguish "server unreachable" from "not loaded/available" and surface the real cause. `installOllamaFlow` logs the curl error instead of silently falling through to Homebrew.
- `execCommand` gains an optional timeout; the `curl | sh` installs and the oMLX DMG download now have hard caps so a stalled network can't hang the CLI indefinitely.
- `commandExists` is now a portable PATH walk (no `which` dependency, works in minimal Linux containers).

### Changed
- **Architecture:** extracted `runProfile` into a shared service (`src/launch.mjs`). `benchmark.mjs` and other commands depend on the service instead of reaching into `commands/run.mjs`; `run.mjs` is now a thin CLI handler. `runningProfiles` moved from `commands/stop.mjs` to the service layer, removing lateral command couplings.
- **DRY:** sampler defaults are now a single source of truth (`profile-flags.mjs` derives from `autodetect.mjs`); a shared `stripTrailingSlash` fixes inconsistent baseUrl normalization; `waitForReady`/`preflightInference` share `scaledTimeoutSec`; `drafterTargetHint` moved to `discovery-shared.mjs` (no more `download.mjs → scan.mjs` coupling); `resolvedLimits` collapsed to one return path.
- `backends.mjs` loads the GGUF scanner lazily so its ~25 importers don't transitively pull in filesystem scanning.
- `config.mjs` no longer imports `ui.mjs` (core data module decoupled from presentation); its mid-file import moved to the top.

## [2.9.1] - 2026-08-25

### Fixed
- Bundled Pi skills are now refreshed when minimal-ai updates, not frozen at first install (#10 follow-up 2). A version marker (`~/.pi/agent/skills/.minimal-ai-bundled.json`) records which skills minimal-ai installed and at which version; `setup()` re-copies only when minimal-ai's version moved on, and only overwrites skills it owns — a skill the user replaced via `pi install` is left alone. Same-version re-runs are a no-op. Previously the copy-once rule (`if (!existsSync(dest))`) left users with stale first-install snapshots while they believed they had current skills.

### Changed
- Platform claims narrowed to tested surfaces (#10 follow-up 3): the README badge is now "macOS (Apple Silicon)" and the Linux row is labeled untested (with an invitation for Linux CI contributions), matching the intro's existing "only verified on Apple Silicon" caveat. Previously the badge/table claimed Linux alongside macOS.

## [2.9.0] - 2026-08-25

### Added
- MTP drafter download prompt (#2): after picking a main GGUF quant, minimal-ai now checks the HuggingFace repo for MTP drafter files and offers to download one alongside the main model. A single drafter is a Y/n prompt; multiple drafter quants show a picker (smallest-that-fits is the default) with a skip option. The drafter lands in the HF cache and the scanner auto-wires it to the main model at setup time, so MTP speculative decoding works without manually locating a drafter. Pairs both `mtp-`-prefix (e.g. huihui-ai) and `...-MTP`-suffix (e.g. unsloth `MTP/` subdirectory) drafter styles, and won't offer a drafter for a different model size in a mixed repo.

### Fixed
- `drafterTargetHint` (the scanner's drafter-to-model matcher) now strips quant tokens globally instead of only as a suffix, so a `-MTP`-suffix drafter like `gemma-4-E2B-it-Q8_0-MTP` reduces to the same base as its main model `gemma-4-E2B-it-Q8_0`. Also strips F16/BF16 quants and a trailing `.gguf` defensively. This fixes `matchDrafter` for the unsloth `-MTP`-suffix style (previously these drafters downloaded but never auto-wired).

## [2.8.0] - 2026-08-24

### Added
- llama.cpp setup now seeds sampler defaults from the model's HuggingFace `generation_config.json` (#17): the lab's recommended `temperature`/`top_p`/`top_k`/`repetition_penalty`/`presence_penalty`/`min_p` are fetched from the profile's HF repo and used as the prompt defaults for fields the user hasn't customized. A "Model card recommends X" hint appears next to each sampler. A user's saved value is never silently overwritten — recommendations only seed fields still at the fresh-profile default. Addresses the "my Qwen loops inside its THINK output" class of bug that comes from fighting the model with wrong sampler settings.
- Quant-picker and KV-cache fidelity guardrails (#18): the GGUF quant picker now notes that 8-bit (Q8_0) preserves tool-calling fidelity better than 4-bit at long context, and the KV-cache step warns (one-line hint, not a block) when context is set above 32K with a low-bit (q4_0) cache that agentic runs can degrade on.

### Removed
- Ollama download paths (#14): `downloadOllamaLibrary`, `downloadOllamaHfGguf`, `downloadViaOllama`, and `pullOllamaModel` are gone. Ollama is a managed backend — users download via `ollama pull` natively; the minimal-ai downloader is now llama.cpp-only (the glass-box backend where guided quant/fit selection is the differentiator). Ollama scan / launch / delete and app-install onboarding stay.

## [2.7.5] - 2026-08-23

### Fixed
- oMLX setup/Reconfigure asks thinking on/off (or budget, on non-DFlash models) BEFORE the level picker — answering "off" now skips the level question entirely instead of asking a moot follow-up.

## [2.7.4] - 2026-08-23

### Fixed
- DFlash oMLX models get the thinking-level picker back. v2.7.2 skipped it on the false belief that levels don't land on the DFlash path — they do: reasoning_effort via chat_template_kwargs is honored by DFlashEngine (~2–2.5x thinking-token reduction from xhigh→low on hard prompts, verified on 0.6.3rc2). The runaway-turn cause was never broken levels; it's the template's xhigh default when no level is sent. Caveats shown in the flow: levels are soft steering, the hard budget is not enforced on the DFlash path, and thinking-off (v2.7.2/v2.7.3) remains the only hard control.

## [2.7.3] - 2026-08-23

### Fixed
- oMLX thinking-off (v2.7.2) now actually works end to end. Root cause of "off but still thinking": minimal-ai advertised thinking controls to Pi/omp for thinkingOff profiles, so Pi attached `chat_template_kwargs: {enable_thinking: true}` to every request — and client kwargs override oMLX's server-side `enable_thinking: false` (verified live on the DFlash path). Pi/omp configs now hide thinking controls entirely for thinkingOff profiles (no reasoning flag, no compat), so nothing on the wire can stomp the server off-switch.

## [2.7.2] - 2026-08-23

### Fixed
- oMLX Reconfigure no longer offers thinking controls that don't work on the DFlash engine path. Follow-up verification after v2.7.0 showed DFlashEngine not only drops thinking levels but also does NOT enforce `thinking_budget` (a benchmark turn ran ~10K thinking tokens past an active 4096 cap). When DFlash is detected, setup/Reconfigure now skips the level selection and offers the one control that works on that path — turning thinking off entirely (`enable_thinking: false`, verified: zero reasoning tokens) — stored on the profile and applied immediately + on every launch. The thinking budget is still offered for non-DFlash (batched-engine) oMLX models, where it is enforced.

## [2.7.1] - 2026-08-23

### Fixed
- oMLX setting applies (MTP, thinking budget) no longer report a false failure: oMLX has no GET settings endpoint (405), so the post-apply verify step always failed and warned even when the apply succeeded. Verification now reads the PUT response's own settings echo, falling back to `~/.omlx/model_settings.json`; the rare apply that can't be independently verified is labeled "not independently verified" instead of warned as a failure.

## [2.7.0] - 2026-08-23

### Added
- oMLX hard thinking budget in setup/Reconfigure (#15): thinking-capable oMLX profiles can set a server-enforced cap on thinking tokens. Thinking levels are only soft steering — and on the DFlash engine path they don't land at all — so when Reconfigure detects DFlash (`dflash_enabled` in the model's oMLX settings) it says so and offers the budget as the control that actually works. The budget is applied immediately via the oMLX admin API, stored on the profile, and re-applied on every launch.
- Thinking control for Ollama profiles (#16): Pi and omp now advertise reasoning for thinking-capable Ollama models. Ollama 0.32.x's `/v1` endpoint honors `reasoning_effort` and accepts every Pi level verbatim (verified on 0.32.15), so per-launch thinking levels now take effect on Ollama too.

### Changed
- Reconfigure's Ollama thinking note is now honest about the tradeoffs instead of calling levels inert: levels are soft steering, `/v1` never shows the thinking trace (invisible token burn), and "off" still thinks at the server default because the harness omits the field rather than sending Ollama's true-off value (`"none"`).

## [2.6.3] - 2026-08-23

### Fixed
- DFlash/DFlash2 draft checkpoints (e.g. `z-lab/Qwen3.8-27B-DFlash2`) no longer appear as set-uppable chat models in the picker. They declare a normal-looking `model_type` (unlike `_mtp` drafters, which were already excluded) — the oMLX disk scan now flags them via the `dflash_config` block / `DFlash*` architecture in config.json and the picker hides them.

## [2.6.2] - 2026-08-23

### Changed
- Unified capability detection (#12): one detector, one facts schema for every backend. llama.cpp reads GGUF metadata, oMLX reads the model's config.json/safetensors index (plus its chat template for thinking support), Ollama reads `/api/show` — all filling the same shape, stored on the profile at setup. The context-length facts (`ctxSize`/`metaCtx`/`contextLength`) are now a single `contextLength`; old profiles are migrated automatically on load.
- Managed setups (oMLX/Ollama) now end with the same "what we detected" overview card llama.cpp setups had, and Ollama profiles store detected facts (thinking, vision, MTP, context) instead of only displaying them during setup.

### Fixed
- Disabling thinking in Reconfigure for a llama.cpp model is now honored at launch — the launcher was re-adding `chat_template_kwargs` from the detected capability, silently undoing the choice.
- MTP enable/disable is now a stored per-profile choice (`mtpEnabled`) instead of overwriting the detected capability fact.

### Migration
- oMLX/Ollama profiles created before this release no longer get name-guessed thinking controls in Pi — Reconfigure the profile once (picker → model → Reconfigure) to store the detected facts.

## [2.6.1] - 2026-08-22

### Fixed
- Reconfigure now refreshes the oMLX server-reported context window (`max_model_len`) onto the profile. Profiles created before v2.5.0 had no persisted context length, so harness configs kept falling back to the 16,384-token ceiling. Re-running Reconfigure once now picks up the model's real window (no profile re-creation needed).

## [2.6.0] - 2026-08-22

### Added
- Thinking level is now set per model in the picker: `models` → a model → Reconfigure → "Thinking level for launches" (harness default / off / minimal / low / medium / high / xhigh / max). Stored on the profile and inherited by every chat launch and benchmark — no need to pass `--thinking` every time. Ollama models show the question with a note that its `/v1` ignores thinking levels.

## [2.5.0] - 2026-08-22

### Added
- Per-model thinking level: `minimal-ai run <profile> --thinking low|medium|high|...` sets a thinking level on that profile and launches with it — saved for later runs, so picker chats and benchmarks inherit it. Other models are untouched (each profile carries its own level; no flag means Pi keeps its own session default).

### Fixed
- oMLX/Ollama models no longer default to a 16,384-token response ceiling. Harness configs now use the real context: oMLX's server-reported `max_model_len` (persisted at setup) and Ollama's served context (from `/api/ps` after preflight, stored as a capability fact instead of overwriting the llama.cpp `ctxSize` flag). Long responses are no longer cut off mid-turn by the hardcoded 16K cap.
- Thinking level "high" no longer silently becomes maximum-effort thinking on Qwen3.5/3.6/3.8 models. Those templates only accept `low/medium/xhigh`, so Pi levels now map explicitly per family: `high` -> `xhigh`, `minimal`/`max` -> `low`/`xhigh` (previously omitted, silently falling to the template's xhigh default).

## [2.4.3] - 2026-08-22

### Fixed
- Pi bundled skills now install correctly on fresh machines — the setup step was copying from the destination directory instead of the bundled resources, so the copy silently failed whenever the skill wasn't already present.
- `--verbose` no longer bypasses the platform check and update offers on startup.

### Changed
- Thinking-control honesty at the provider level: `reasoning_effort` is now advertised only for oMLX (the one server that reads the top-level field) in Pi/omp configs. llama.cpp models keep working thinking controls through per-model chat-template settings; Ollama models remain without thinking controls, as before.
- Pi chat-template thinking settings are only attached to models minimal-ai knows can think, instead of every Qwen/Gemma-family model.
- Benchmark run metadata no longer records Pi as the runner when another harness is configured.
- GGUF scanning reads metadata incrementally (small prefix first, large retry only when needed) instead of reading up to 64MB per model on every launch — noticeably faster picker startup with many local models.
- Reduced code duplication across harness adapters, stop/unload flows, model catalog enrichment, and HuggingFace downloads (one tree fetch per download instead of three); removed the dead `profile.harnesses` schema field and other unused code.

## [2.4.2] - 2026-08-18

### Fixed
- Ollama profiles now learn the context window Ollama actually serves. Ollama 0.15.5+ applies a VRAM-based fit at load time that can shrink even an explicit `OLLAMA_CONTEXT_LENGTH` (e.g. configured 262144, served 32768), and harnesses were assuming the model's metadata maximum — causing silent prompt overflows in omp/Pi ("model returned no content"). After the preflight load, minimal-ai probes `/api/ps`, saves the served context to the profile, and writes it into harness configs so the UI shows the real window. Also: harness config now re-syncs on every run instead of only when the model is missing, so profile corrections propagate immediately.

## [2.4.1] - 2026-08-18

### Fixed
- Benchmark flow now uses the configured harness name in the launch prompt (was hardcoded to "Pi"), and run-slot metadata records the actual harness (`intendedRunner`/`tool`) instead of always saying Pi — important when comparing benchmark results across harnesses.

## [2.4.0] - 2026-08-18

### Added
- Pluggable chat harnesses. minimal-ai can now launch chats in **oh-my-pi (omp)** in addition to Pi — choose once under models → 💬 Chat harness and it stays until you change it, or override per run with `--with omp`. Switching harnesses syncs your existing model setups into the new harness's config automatically (`~/.omp/agent/models.yml`). Harness support is built as a small adapter interface (`src/harnesses.mjs` + `src/harness-shared.mjs`) so more harnesses (opencode, etc.) can be added later.
- Thinking-control honesty per harness: omp gets thinking controls only for oMLX models (its top-level `reasoning_effort` works there); llama.cpp and Ollama models are marked non-reasoning in omp config because those servers ignore the field (wire-verified).

## [2.3.1] - 2026-08-18

### Fixed
- Ollama models no longer show thinking-level controls in Pi. Ollama's OpenAI-compatible `/v1` endpoint ignores every thinking field (`chat_template_kwargs`, `reasoning_effort`, `reasoning`, even Ollama's own `think` — curl-verified on 0.32.14), so the Shift+Tab thinking knob did nothing for Ollama models. minimal-ai no longer advertises reasoning for Ollama profiles; oMLX and llama.cpp profiles are unchanged. Reconfigure an Ollama profile (models → Reconfigure) to apply.

## [2.3.0] - 2026-08-18

### Added
- Vision detection for managed models. Ollama profiles now store the model's vision capability (from Ollama's own `/api/show` — previously it was displayed at setup but never saved, so Pi was told the model was text-only), and oMLX profiles detect vision from the model's `config.json` (`vision_config`). Vision-capable managed models now get image input in Pi. Note: stripped builds like MTPLX speed variants have no vision weights and correctly stay text-only. Reconfigure a profile once (models → Reconfigure) to pick this up for an existing setup.

## [2.2.1] - 2026-08-18

### Fixed
- Thinking levels actually reach oMLX models now. v2.2.0 wrote Pi configs using the `qwen-chat-template` thinking format, which sends only the on/off toggle and silently drops the level — so a Qwen3.8 model stayed at its template default (`xhigh`, i.e. thinks for minutes on simple prompts) no matter what level was picked. Qwen/Gemma-4 models now use the generic `chat-template` format, which passes both `enable_thinking` and `reasoning_effort` through `chat_template_kwargs`. `/think off` also fully disables thinking now. Reconfigure a profile once (models → Reconfigure) to refresh an existing Pi config.

## [2.2.0] - 2026-08-16

### Added
- Thinking levels for local models in Pi. minimal-ai now tells Pi that local servers accept `reasoning_effort`, so thinking-capable models get Pi's level controls (`/think low` in a session, or `pi --model <provider>/<model>:low`). Managed oMLX/Ollama models — which have no readable GGUF metadata — are detected by name (Qwen3, Gemma 4, DeepSeek-R families). No level is ever set by default; if you don't pick one, the model's own template default applies. Reconfigure a profile once (models → Reconfigure) to refresh an existing Pi config.

## [2.1.0] - 2026-08-16

### Added
- Benchmark prepare flow: pick a configured model in `minimal-ai models`, choose **Benchmark**, pick a visual or data-science prompt, and minimal-ai creates a run slot in the local-llm-visual-benchmark gallery and launches Pi in that directory with the prompt ready to go. The gallery repo is auto-detected (or cloned/linked on first use) and remembered in `config.json`. Review results and capture preview media with `npm run dev` in the gallery repo.

## [2.0.8] - 2026-08-16

### Fixed
- The context/KV-cache heatmap header no longer labels momentary free memory as "System RAM". It now shows both installed RAM and currently-available RAM (e.g. "RAM: 48 GB installed · 20.5 GB available now"), since fit decisions are based on what's actually available.

## [2.0.7] - 2026-08-16

### Fixed
- Deleting a profile whose model was already removed outside minimal-ai (deleted from the oMLX app or via `ollama rm`) no longer dead-ends. oMLX profiles with undiscoverable files now offer config-only removal, and an Ollama 404 is treated as already gone.
- oMLX and Ollama runtime updates are now notification-only with manual update instructions, instead of minimal-ai attempting the update itself. The oMLX check no longer points at the dev channel (oMLX publishes rc/dev builds as full GitHub releases, which caused a re-prompt loop for stable-channel users); it now tracks the newest stable tag. llama.cpp updates are unchanged — minimal-ai manages that runtime itself.

## [2.0.6] - 2026-08-14

### Fixed
- Memory estimates for hybrid linear-attention GGUF models (Qwen3.5/Qwen3.8 dense, e.g. Qwen3.8-27B) no longer charge every layer as full attention. Only the periodic full-attention layers (`full_attention_interval`) carry a KV cache; the Gated DeltaNet layers' small fixed recurrent state is now counted as fixed overhead instead. Previously, context/KV totals were inflated ~4x and grew wrongly with context, making usable context windows look impossible on machines where they fit.

## [2.0.5] - 2026-08-08

### Removed
- Removed the unreleased benchmark feature (the `enable_benchmarking` dev flag and the model-picker Benchmark action). It depended on the external, unpinned `llama-benchy` Python tool, which we don't manage. The flag key in existing `config.json` files is now ignored and can be deleted.

## [2.0.4] - 2026-07-28

### Changed
- Cards no longer render body text in magenta. The accent color now applies to card borders and titles only, so card contents use your terminal's default text color. (Via @eeshans/cli-kit 0.1.1.)
- The "Update available" card and the runtime-updates header are now yellow, so cards that ask for an action stand out from informational ones.

## [2.0.3] - 2026-07-27

### Fixed
- The context & KV cache heatmap showed the same value in every cell for Gemma 4 models. Gemma 4 GGUFs store fewer attention layers than `block_count` (e.g. 32 attention layers in 48 blocks); the estimator treated the layers without attention metadata as an error and zeroed the whole KV estimate. Those layers have no KV cache and are now skipped, so the heatmap shows a real memory gradient again.

## [2.0.2] - 2026-07-27

### Fixed
- The managed `llama-server` symlink is now created with a relative target, so it survives moving or renaming the data directory. Previously, moving `~/.minimal-ai` left a dangling link and minimal-ai silently fell back to an older `llama-server` from PATH/Homebrew while reporting itself up to date. A dangling managed link now prints a warning before falling back.
- Deleting an oMLX model no longer offers a guessed path (`~/.omlx/models/<id>`) when the model directory can't be discovered. The delete flow now says the directory wasn't found and points you at manual deletion instead.

## [2.0.1] - 2026-07-26

### Changed
- Removed the one-time `~/.offgrid-ai` → `~/.minimal-ai` data migration. No installs predate the rename, so the shim had no remaining audience. The on-disk data-dir marker is now `.minimal-ai-data`.

## [2.0.0] - 2026-07-26

### Changed
- **Renamed from offgrid-ai to minimal-ai.** The npm package, command, and GitHub repo are all `minimal-ai` now. Your data migrates automatically on first run (`~/.offgrid-ai` → `~/.minimal-ai`). To update: `npm install -g minimal-ai`. The `OFFGRID_*` environment variables are now `MINIMAL_*`.

### Added
- Unified terminal UI on @eeshans/cli-kit. Every prompt runs on Clack now, so Escape cancels cleanly on every surface.
- Model picker groups render as real headers: bold labels, a blank line between groups, no radio bullets on header rows.
- Status card shows a per-backend model breakdown, e.g. "5 models → llama.cpp (2) | oMLX (3) | Ollama (0)".

### Changed
- Setup and reconfigure no longer show an explanation card per setting. Each prompt gets a one-line hint instead; the state cards (model overview, context & KV cache heatmap, memory estimate, configuration summary) stay.
- Number prompts in reconfigure come pre-filled with the current value. Press Enter to keep it, type to change it.
- oMLX and Ollama backends are always on. The `enable_omlx` / `enable_ollama` config flags are retired — stale keys in config.json are simply ignored. `enable_benchmarking` stays as a dev flag.

### Fixed
- Escape on the uninstall and stop prompts cancelled visually but proceeded anyway. Both now actually cancel.
- Number prompts crashed on submit after a valid entry (validate convention mismatch with Clack).
- `offgrid-ai run <model> --with server` failed argument parsing.
- Removed duplicate section headers above cards that already have their own titles, and a duplicate memory estimate card in reconfigure.

### Removed
- @inquirer/prompts dependency. The UI is entirely Clack.

## [1.0.13] - 2026-07-14

### Changed
- Update flow now prioritizes offgrid-ai package updates. If an offgrid-ai update is available, the tool shows the notification and stops — runtime update checks and main flow are skipped. This prevents overlapping update prompts and ensures the user runs the latest offgrid-ai code before dealing with runtime updates.

## [1.0.12] - 2026-07-14

### Fixed
- Removed `prompt.close()` call that crashed after runtime update completed. The `createPrompt()` factory doesn't expose a `close` method (Inquirer prompts are stateless and need no cleanup).

## [1.0.11] - 2026-07-14

### Fixed
- `offgrid-ai update` now verifies the npm install actually changed the version. If npm reports success but the version is unchanged (stale cache), it automatically clears the npm cache and retries. Previously it would print "Updated" even when nothing changed.

## [1.0.10] - 2026-07-14

### Fixed
- Restored the "Update now?" yes/no prompt for runtime updates (llama.cpp, oMLX, Ollama). A previous change (v1.0.7) made these notification-only, which meant users could see the update notice but had no way to actually update from within offgrid-ai.

## [1.0.9] - 2026-07-14

### Fixed
- llama.cpp update check now falls back to `llama-server --version` when VERSION.json doesn't exist (Homebrew/PATH installs), matching the oMLX pattern. Previously the check silently returned null for non-managed installations, so users with Homebrew llama.cpp never saw update prompts.

### Security & Hardening (issue #5, 37/37 items closed)
- P0: data-dir safety, deletion gating, oMLX root protection, PID identity, symlink cycle detection, GGUF bounds checking
- Deletion confirmation gates, atomic JSON writes, start.sh injection prevention, disk probe fail-open
- oMLX DMG integrity verification, runtime digest verification, parallel readiness checks
- Ollama endpoint centralization via parseOllamaHost(), Pi provider endpoint-specific IDs
- install.sh Node >=20 check, CI version/changelog validation, lint scope includes tests
- Removed dead recommendations.json, stale downloadFlow comment, unused variables

### Tests
- Added 13 regression tests (test/p0-regressions.mjs)

## [1.0.8] - 2026-07-12

### Fixed
- Ollama install now uses the official curl installer first, Homebrew as fallback. The Homebrew package can be missing the `llama-server` binary, which causes model load failures. The official installer always includes a complete binary bundle.

## [1.0.7] - 2026-07-12

### Changed
- Runtime update notifications (llama.cpp, oMLX, Ollama) are now notification-only, matching the offgrid-ai update flow. No more inline "Update now?" prompt that could fail silently and re-prompt on every launch.

## [1.0.6] - 2026-07-12

### Fixed
- MTP drafter exclusion now reads `model_type` from the on-disk `config.json` instead of relying on the oMLX API (which doesn't return `model_type`). The 227MB drafter model will no longer appear in the picker.
- Disabled oMLX download line no longer shows a redundant `○` circle prefix.

## [1.0.5] - 2026-07-12

### Fixed
- Blank line added after the "Update available" message for readability.

## [1.0.4] - 2026-07-12

### Fixed
- Standalone MTP drafter models (e.g. `mlx-community/Qwen3.6-27B-MTP-4bit`) are now excluded from the oMLX model picker. These are companion weights for speculative decoding, not independently runnable chat models. Detected by `model_type` ending in `_mtp` (e.g. `qwen3_5_mtp`), not by model name — so real MTP-capable chat models with "mtp" in their name are still shown.

## [1.0.3] - 2026-07-12

### Changed
- oMLX download option in the model picker is now a disabled (non-clickable) info line that says "open and download from oMLX app" instead of a clickable item that opens a separate message.

## [1.0.2] - 2026-07-12

### Fixed
- Release notes now show bullet points (`-`) with hanging indent, matching the changelog format.

## [1.0.1] - 2026-07-11

### Added
- `offgrid-ai update` command — runs `npm install -g offgrid-ai@latest` directly, same as `pi update`. The update notification now says "Run: offgrid-ai update" instead of showing the raw npm command.

## [1.0.0] - 2026-07-11

### v1.0 stable release

offgrid-ai is production-ready. This release consolidates the v0.27.x improvements and adds final hardening for stable release.

### Added
- Config validation — `loadConfig` now validates types of all known fields after merge. Wrong types in `config.json` (e.g. `modelScanDirs` as a string) reset to defaults instead of crashing at runtime.
- Ollama backend now respects the `OLLAMA_HOST` environment variable, matching Ollama's own behavior for non-default bind addresses.

### Changed
- Three backends: llama.cpp (GGUF), oMLX (MLX on Apple Silicon), Ollama (GGUF + MLX). Platform support updated in README.
- Server startup timeout scales by model size: 180s base + 10s per GB, capped at 600s. Preflight inference timeout scales similarly.
- `maxTokens` in Pi harness config now uses the model's configured context window instead of a hardcoded 16384.
- Memory estimate overhead scales with model size (5% of model bytes, min 256MB) instead of a fixed 1GB.
- Release notes display in a card with text wrapping, markdown bold rendering, and terminal-width awareness.
- Update flow simplified to notification-only: shows release notes and the command to run, no inline npm install.
- Dynamic page size for model picker — shows all choices that fit terminal height instead of a hardcoded cap.

### Fixed
- Models with missing `context_length` in GGUF metadata are now blocked with a clear error instead of guessing 32k/80k, which could cause OOM or silent context truncation.
- Context labels below 1000 tokens now show the raw number (e.g. "512") instead of misleadingly rounding to "1k".
- Vision projector memory display shows actual file size instead of hardcoded "~200 MB".
- Default `presencePenalty` for non-thinking models reduced from 1.5 to 1.0 to avoid incoherent output with some models.
- Timeout bumps for reliability: server readiness 1s to 2s, model scan 3s to 5s, oMLX start 30s to 60s.

### Removed
- Dead code: `downloadFlow` (legacy), `detectHardware`, `badge`, `isManaged` (all never imported by any consumer).

## [0.27.5] - 2026-07-11

### Changed
- **Simplified update flow** — offgrid-ai no longer runs `npm install` inline. When an update is available, it shows the release notes and the command to run (`npm install -g offgrid-ai@latest`), then continues to the app. The user runs the update when ready. This matches how Pi handles updates and eliminates the infinite update loop, npm cache issues, and ETARGET errors that occurred when CI hadn't finished publishing.

## [0.27.4] - 2026-07-11

### Fixed
- **Auto-retry update when npm cache is stale** — when `npm install -g` reports success but doesn't actually update the package (a known npm cache issue), offgrid-ai now automatically clears npm's cache with `npm cache clean --force` and retries the install, then verifies the version changed. The user no longer has to manually fix cache issues or get stuck in an infinite update loop. If the retry also fails, a clear error is shown.

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