# Session Context
<!-- Last saved: 2026-06-07 local -->

## Project Anchor
- Project: offgrid-ai
- Goal: Privacy-first CLI for running local LLMs — discover, configure, run, benchmark
- Current phase: Implementation complete, ready to publish to npm
- Repo: https://github.com/eeshansrivastava89/offgrid-ai
- Source reference: ~/dev/local-llm-visual-benchmark/scripts/local-llm/

## Git Snapshot
- Branch: main
- Remote: origin → https://github.com/eeshansrivastava89/offgrid-ai.git
- Recent commits:
  - c1aff38 add interactive clean-room test environment
  - e57896d simplify: one install path — curl installer
  - 84a333c add README
  - 694977b fix: update install.sh URLs to real GitHub repo
  - c62bf66 feat: add curl-based installer script
  - f41606b feat: simplified command structure + clean-room test tools
  - 143d099 feat: milestone 1 — package skeleton and all core modules (initial)
  - 8641db7 init: repo with plan and context

## What We Were Doing
- Task: Publish offgrid-ai to npm, then test the curl installer end-to-end
- Progress:
  - [x] Full codebase scan of source project (3,113 lines)
  - [x] Product planning — all decisions resolved
  - [x] PLAN.md written
  - [x] Repo created and pushed to GitHub
  - [x] All core modules implemented (1,816 lines, 42% reduction from source)
  - [x] CLI simplified to 3 commands: offgrid-ai, status, stop
  - [x] Onboarding flow (Homebrew → llama-server → model backends)
  - [x] Auto-detect from GGUF metadata (replaces presets)
  - [x] JSON command files (replaces shell parser)
  - [x] Pi-only harness (dropped OpenCode)
  - [x] Binary discovery chain (env → which → Homebrew)
  - [x] curl install script created (install.sh)
  - [x] README written and pushed
  - [x] GitHub repo created: eeshansrivastava89/offgrid-ai
  - [x] Clean-room test environment (test-clean.sh — source it to enter, exit-clean to leave)
  - [ ] Publish to npm
  - [ ] Test curl installer end-to-end (as a real new user would)
  - [ ] Test actual onboarding flow (Homebrew → llama-server → model selection → run)
  - [ ] Test in UTM VM (macOS clean slate) — UTM install was failing, needs investigation

## Decisions
- Package name: offgrid-ai (confirmed available on npm, repo created)
- Install method: curl installer is THE primary method (one command, installs Node if needed)
- No Homebrew distribution (too much overhead for maintainer)
- npm is secondary (for developers who already have Node)
- Standalone binary (Bun compile) is future option, not now
- Three commands only: offgrid-ai (main), status, stop
- Data dir: ~/.offgrid-ai/
- Command files: JSON (shell parser eliminated)
- Auto-detect everything from GGUF metadata (presets eliminated)
- Pi only (OpenCode dropped)
- Binary discovery: env var → which → Homebrew path
- Onboarding: Homebrew → llama-server → model backend → models → done

## Architecture
### Modules (13 source files):
- src/config.mjs (101 lines) — ~/.offgrid-ai/ paths, binary discovery chain, config load/save
- src/json.mjs (15 lines) — shared JSON read/write utility
- src/gguf.mjs (69 lines) — binary GGUF metadata reader (reused from source)
- src/autodetect.mjs (112 lines) — auto-detect capabilities from GGUF (replaces presets)
- src/scan.mjs (77 lines) — multi-dir GGUF model scanner
- src/estimate.mjs (112 lines) — memory estimation from GGUF metadata
- src/backends.mjs (134 lines) — backend defs (llama-cpp, mtp, ollama, omlx)
- src/profiles.mjs (164 lines) — profile CRUD with JSON commands
- src/process.mjs (174 lines) — server start/stop/ready with binary discovery
- src/harness-pi.mjs (139 lines) — Pi-only harness sync (OpenCode dropped)
- src/logs.mjs (41 lines) — friendly log tailing
- src/ui.mjs (101 lines) — @clack/prompts + picocolors
- src/cli.mjs (568 lines) — command router, onboarding, models, run, stop, status

### Key files:
- bin/offgrid-ai.mjs — entry point (shebang)
- install.sh — curl-based installer script
- test-clean.sh — interactive clean-room test environment
- package.json — deps: @clack/prompts, picocolors

## Open Items
- Publish to npm (next step — check eeshansrivastava89/side-quests and how-i-prompt for reference)
- The curl installer references the GitHub raw URL (works since repo is public)
- UTM macOS VM installation was failing — known UTM/Apple Virtualization issues. Not blocking for npm publish.
- Benchmark flow is stubbed — needs local-llm-visual-benchmark repo integration
- update-notifier not yet added (in PLAN but not implemented)

## Resume Plan
1. Check side-quests and how-i-prompt repos for npm publish patterns
2. Publish offgrid-ai to npm
3. Test curl installer end-to-end (`curl ... | bash` in clean room)
4. Test onboarding flow as a brand new user
5. Test in UTM VM (clean Mac)

## Notes
- Source code reduced from 3,113 lines to 1,816 lines (42% reduction)
- Eliminated: shell parser, presets, OpenCode harness, hardcoded binary paths, repo-relative paths
- All modules import cleanly and CLI runs all commands successfully
- Clean-room test (test-clean.sh) works: source it, run offgrid-ai commands, exit-clean to restore
- The user wants to test the ACTUAL curl installer flow (not dev code), so npm publish is prerequisite
- install.sh handles: no Node → install nvm → install Node LTS → npm install -g offgrid-ai