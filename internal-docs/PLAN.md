# offgrid-ai: Standalone CLI

## Vision

`offgrid-ai` — a privacy-first CLI for running local LLMs on your laptop. Your AI, your machine, nothing leaves. Zero configuration. You run it, it makes sure you have everything you need, then you pick a model and go.

## Product

`npm install -g offgrid-ai` then `offgrid-ai` anywhere.

Core loop: **install dependencies → pick a model → run**. No setup wizards, no parameter tuning, no guided questions. Auto-detect everything from the model. If something's missing, install it right there. Non-optional dependencies are non-optional.

## First-Run Onboarding

The dependency chain, walked top to bottom. Each step: check → if missing, offer to install with clear consequences for saying no.

1. **Homebrew** — "Homebrew is required. Install?" (No → "offgrid-ai cannot continue without Homebrew.")
2. **llama-server** — "llama-server is required. Install via Homebrew?" (No → "offgrid-ai cannot start models without llama-server.")
3. **Model backend** — at least one is mandatory. One choice:
   - **LM Studio** (recommended) — visual model browser + `lms` CLI, e.g. `lms get qwen/qwen3.5-9b`
   - **Ollama** — alternative model runtime, e.g. `ollama pull gemma3:4b`
   - **oMLX** — Apple Silicon optimized models
   - **All three** — install everything
4. **Models** — if LM Studio installed but no models found → "You need to download a model first. Run `lms get qwen/qwen3.5-9b`, then come back."
5. **Done** — proceed to model selection.

Subsequent runs: skip everything that's already installed, go straight to model selection.

## Benchmark Flow

Optional feature. Always visible, never mandatory.

- "Benchmark" is always shown as an action in the CLI.
- When selected, check if the visual-benchmark repo is present (path configured or auto-detected).
- **Repo found** → normal benchmark flow: pick a prompt, pick a model, run it.
- **Repo not found** → upsell prompt: "Benchmark prompts require the local-llm-visual-benchmark repo. Install?" with a link to the GitHub repo so they can see what it is. Yes → clone it, configure the path, proceed. No → back to main menu.
- This prompt repeats every time they select Benchmark without the repo installed. It's always there, always marketing the project.

Not part of the onboarding chain — the user encounters it naturally when they explore the CLI.

## Normal Flow

`offgrid-ai` → show available models from all backends → pick one → auto-detect everything → create profile → run server → launch Pi.

No parameter questions. No preset selection. Auto-detect sets flags from GGUF metadata (QAT, MTP, thinking, vision, memory). Power users edit `~/.offgrid-ai/profiles/<id>/command.json` by hand.

## Decisions

| Decision | Choice |
|---|---|
| Package name | `offgrid-ai` |
| Data directory | `~/.offgrid-ai/` |
| Install | `npm install -g offgrid-ai` |
| Updates | Active prompt on startup via `update-notifier` |
| Target user | Non-developer first — opinionated, zero config, hide all complexity |
| Model downloads | Per-backend: `lms get` for LM Studio, `ollama pull` for Ollama, `omlx start` for oMLX |
| Backends | llama-server (required), plus at least one of LM Studio / Ollama / oMLX |
| llama-server | Discovery: `$LLAMA_SERVER_BINARY` → `which` → Homebrew path. Missing → install via Homebrew |
| Concurrent models | One at a time — laptop users, RAM is scarce |
| Profiles | Per-GGUF file, auto-created on first run of a model |
| Command files | JSON — kills the shell parser, still editable by power users |
| Auto-detect | QAT, MTP, thinking mode, vision (mmproj) — all from GGUF metadata and filenames |
| Sampling / flags | Computed from model metadata. No user questions. Power users edit JSON. |
| Presets | Gone. Replaced by auto-detect. |
| Harness | Pi only. Not installed → offer to install. |
| Benchmark | Conditional on visual-benchmark repo. Absent → offer to clone. Always visible as upsell. |
| Config | `~/.offgrid-ai/config.json` — surfaces auto-detected paths, hand-editable if user wants to override |
| Model scan dirs | `~/.lmstudio/models/`, `~/.cache/huggingface/`, common paths + custom in config |
| MTP | Auto-detected option, same Homebrew binary, different flags |

## Approach

**Move, don't split.** The entire CLI moves to a new repo as `offgrid-ai`. The visual-benchmark project lists it as a dev dependency. No shared library, no programmatic API — the benchmark project calls the CLI the same way it does today.

**Conditional benchmark feature.** The CLI always shows "Benchmark" as an action. If benchmark prompts are found, it works. If not, the user sees a prompt offering to clone the repo or set the path. Model management works standalone; benchmarking is the upsell.

**No feature loss.** Everything ships — model scanning, profiles, server management, harness sync, benchmark orchestration. The benchmark flow just degrades gracefully when prompts aren't available.

## Data Directory

```
~/.offgrid-ai/
  config.json          # auto-detected paths surfaced here, editable if user wants to override
  profiles/            # one subdir per profile
    <id>/
      profile.json     # profile metadata + model info
      command.json     # llama-server flags (auto-generated, editable)
      notes.md         # scratch notes
  logs/
  run/                 # PID state files
```

## Simplifications from Current Code

- **Drop the shell parser.** ~80 lines of bash parsing (shellSplit, stripShellComment, parseLlamaCommand). JSON command files eliminate all of it.
- **Drop presets.** `presets.mjs` deleted entirely. Auto-detect replaces it.
- **Drop guided setup questions.** No sampling param prompts, no cache type choices, no preset selection. Auto-detect everything.
- **Drop OpenCode harness.** Half of `harnesses.mjs` gone.
- **Drop hardcoded paths.** No personal binary paths. Discovery chain + config.
- **Drop manual backend/server variant choices.** Auto-detected from GGUF metadata.
- **Split cli.mjs.** 1100 lines → command modules for maintainability.

## What Doesn't Change

- The visual-benchmark project uses `offgrid-ai` as a dev dependency instead of `scripts/local-llm`. Same commands, same behavior.
- The profile concept. JSON now instead of shell, but same idea: editable source of truth for server flags.
- Model discovery approach. Scan directories, walk Ollama/oMLX APIs.
- Server lifecycle. Start, wait for `/v1/models`, tail logs, stop on exit.

## Open Questions

- npm namespace: `offgrid-ai` confirmed available.
- Should onboarding auto-install Homebrew/llama-server or just print the commands and verify after? ✅ Yes — installs via Homebrew.
- How to detect oMLX installation — pip package check, binary check, or just try the API? ✅ Binary check + API.