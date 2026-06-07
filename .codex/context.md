# Session Context
<!-- Last saved: 2026-06-08 -->

## Project Anchor
- Project: offgrid-ai
- Goal: Privacy-first CLI for running local LLMs — discover, configure, run, benchmark
- Repo: https://github.com/eeshansrivastava89/offgrid-ai
- npm: https://www.npmjs.com/package/offgrid-ai
- Current version published: v0.3.10 (but has critical issues — DO NOT publish another patch without thorough manual testing)

## Critical Feedback (MUST READ)
**The implementation quality is shoddy.** We went from v0.3.4 to v0.3.10 entirely on bug fixes, not features. Every user test revealed a crash or broken flow. Root causes:
1. **No manual testing before publishing.** ESLint + unit tests pass but don't exercise any real CLI flow. Bugs like `pc.strip is not a function` would have been caught instantly by running the command once.
2. **Publishing too fast.** Every fix was immediately published as a new patch version, often introducing new bugs (installer PATH fix used deprecated `npm bin -g`, uninstaller didn't clean PATH, etc.).
3. **Not running the actual CLI locally before shipping.** Should always `node bin/offgrid-ai.mjs` or `npx offgrid-ai` to verify before `npm publish`.

**Mandatory rule: NEVER publish without running the actual CLI end-to-end locally first.**

## Known Bugs (UNFIXED, found during v0.3.10 laptop testing)

### 1. `npx offgrid-ai` does NOT auto-update
- Other npm CLI tools (how-i-prompt, side-quest, etc.) prompt users when a new version is available and offer to update
- Our update notifier (added in v0.3.10) only prints a message suggesting `npm install -g offgrid-ai@latest`
- `npx` caches packages and won't re-fetch until cache expires — running `npx offgrid-ai` keeps using the old cached version even after a new version is published
- **Fix needed**: The update notifier should actually offer to update (run `npm install -g offgrid-ai@latest`), or we need a different mechanism (like a self-updater, or `npx`-friendly version check that prompts the user like other tools do)

### 2. PATH evaporates after upgrade
- After running `npm install -g offgrid-ai@latest`, the `offgrid-ai` command was "not found" again
- The installer adds npm's global bin to `~/.zshrc`, but `npm install -g` overwrites the binary symlink and may change paths
- On this machine (Hermes node manager), npm's global bin is `/Users/eeshans/.hermes/node/bin/` which is NOT on PATH by default
- The `~/.zshrc` PATH addition from the installer gets written once, but may not survive npm upgrades correctly
- **Need to verify**: Does `npm update -g` preserve the symlink path? Does the PATH entry persist correctly?

### 3. `pc.strip is not a function` (FIXED in v0.3.9)
- `picocolors` doesn't have a `.strip()` method. Was used in `ui.mjs` (profile detail rendering) and `logs.mjs` (stripping ANSI from log files)
- Fixed by replacing with Node's built-in `stripVTControlCharacters` from `node:util`

### 4. Installer still showing old version on GitHub CDN
- `curl | bash` was serving a cached version of install.sh from `raw.githubusercontent.com`
- Even after `git push`, the CDN served the old script (with deprecated `npm bin -g` and no PATH fix)
- Temporary fix: use commit-hash URL to bust cache. Long-term: need a way to ensure users get the latest script.

### 5. `items is not defined` crash (STATUS UNCLEAR)
- Originally reported on VM after saving a profile and relaunching
- No `items` variable found in current source code — may have been fixed by earlier refactors
- Needs reproduction to confirm

## Git Snapshot
- Branch: main
- Latest commit: 946c493 feat: add update notifier
- Working tree: clean
- Total source: ~2,300 lines (cli.mjs grew to ~1060 lines with update notifier)

## What Was Done This Session
1. Context restore from `.pi/context.md`
2. Code review — found and fixed:
   - Orphaned server process on startup failure (cli.mjs `runProfile`)
   - `uninstall --force` flag now works (was ignoring argv)
   - Removed unused params/imports (7 ESLint warnings → 0)
   - `normalizeProfile` dead params removed
3. Installer fixes (install.sh):
   - Replaced deprecated `npm bin -g` with `npm prefix -g` + `/bin`
   - Auto-adds npm global bin to `~/.zshrc` and current session PATH
   - Shows installed version after `npm install -g`
4. Uninstaller fix (cli.mjs):
   - `removeShellPath()` now removes the installer's PATH entry from all shell configs
5. `pc.strip` → `stripVTControlCharacters` fix (ui.mjs, logs.mjs)
6. Update notifier added (cli.mjs):
   - Checks npm registry once per 24h (cached in `~/.offgrid-ai/update-cache.json`)
   - Shows on `offgrid-ai` run and `offgrid-ai version`
   - Does NOT auto-update or prompt to update (needs work)

## Architecture (current)
### Source files (13 + 1 test):
- src/cli.mjs (~1060 lines) — command router, onboarding, model selection, update notifier, uninstall
- src/config.mjs (101 lines) — paths, binary discovery, config load/save
- src/json.mjs (15 lines) — shared JSON read/write
- src/gguf.mjs (69 lines) — binary GGUF metadata reader
- src/autodetect.mjs (112 lines) — auto-detect capabilities from GGUF
- src/scan.mjs (77 lines) — multi-dir GGUF model scanner
- src/estimate.mjs (112 lines) — memory estimation from GGUF metadata
- src/backends.mjs (118 lines) — backend defs (llama-cpp, mtp, ollama, omlx)
- src/profiles.mjs (165 lines) — profile CRUD with JSON commands
- src/process.mjs (174 lines) — server start/stop/ready with binary discovery
- src/harness-pi.mjs (139 lines) — Pi-only harness sync
- src/logs.mjs (46 lines) — friendly log tailing
- src/ui.mjs (78 lines) — @clack/prompts + picocolors + stripVTControlCharacters
- test/smoke.mjs (123 lines) — node:test smoke tests

### Key infrastructure:
- bin/offgrid-ai.mjs — entry point (shebang)
- install.sh — curl-based installer script
- scripts/privacy-gate.mjs — 4-gate check
- .github/workflows/ci.yml — lint + smoke test + auto-publish on tag

## Testing Status
- **ESLint**: 0 errors, 0 warnings (all cleaned up)
- **Smoke tests**: 13 pass (module imports + GGUF pipeline)
- **Manual testing**: INSUFFICIENT. Only tested on dev machine. Laptop testing by user revealed multiple crashes.
- **VM E2E**: Previously passing but Tart VMs deleted (97GB freed)

## Decisions
- Package name: `offgrid-ai` (unscoped)
- Install: curl primary, npm secondary
- No Homebrew distribution
- Pi is mandatory (onboarding step 3)
- Model backends: LM Studio (recommended) → Ollama → oMLX
- `--verbose` flag for install output; default is quiet
- ESLint with no-undef rule enforced in CI
- node:test for smoke tests (built-in, no dependencies)
- Hermes node manager on user's laptop puts npm global bin at `/Users/eeshans/.hermes/node/bin/` (not on default PATH)

## Open Items (PRIORITIZED)
1. **Fix npx auto-update behavior** — current update notifier just prints a message; need to either prompt+install or match how other tools (how-i-prompt, side-quest) handle this
2. **Fix PATH persistence after npm upgrades** — verify the ~/.zshrc PATH entry survives `npm install -g` upgrades
3. **Reproduce `items is not defined` crash** — may be fixed already, needs confirmation
4. **Test all commands end-to-end on laptop** — run, stop, status, uninstall, version — before ANY more publishing
5. **Benchmark flow** — still stubbed
6. **Installer CDN caching** — GitHub raw CDN serves stale install.sh; consider cache-busting strategy

## Resume Plan
1. **DO NOT PUBLISH** until every command has been manually tested end-to-end locally
2. Fix the npx update behavior (study how how-i-prompt/side-quest do it)
3. Verify PATH persistence across upgrades
4. Test: `offgrid-ai` (main flow), `offgrid-ai version`, `offgrid-ai status`, `offgrid-ai stop`, `offgrid-ai uninstall`
5. Test: clean install via curl | bash on a fresh machine or temp dir
6. Only then: publish a clean version (consider semver bump to 0.4.0 for the batch of fixes)