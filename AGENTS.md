# Agent Instructions for minimal-ai

## Project Context

- **Renamed from offgrid-ai to minimal-ai** (v2.0.0). Umbrella brand: Minimal Intelligence (eeshans.com, "a Minimal Intelligence tool" byline). Sibling tools (goalbot, sidequests) carry their own plain names — no shared prefix.
- **CLI UI toolkit lives in `src/ui/`** (theme, layout, components, prompts, cli, help) — inlined from the archived `@eeshans/cli-kit` package (single consumer; the npm package remains published but unmaintained). Rules: **no boxes/cards** — bold headings (`theme.bold`), `renderList` rows, plain padded tables clamped to the terminal width (`maxWidth()`), ✓/✗/!/→ status lines via `status()`.

## Release Workflow

- **Never run `npm publish` locally.** Pushing a `v*` tag triggers `.github/workflows/ci.yml`, which runs tests and publishes to npm with provenance. Publishing manually causes CI to fail with npm 403.
- Version bumps: commit first, then push the tag. Let CI publish.

### Versioning convention

The version follows `MAJOR.MINOR.PATCH` (semver). Bump rules:

| Commit type | Bump | Example |
|-------------|------|---------|
| `feat:` | Minor (middle) | `1.0.13` → `1.1.0` |
| `fix:` | Patch (last) | `1.1.0` → `1.1.1` |
| `refactor:` | Patch (last) | `1.1.1` → `1.1.2` |
| `chore:` | Patch (last) | `1.1.2` → `1.1.3` |
| Breaking change | Major | `1.x` → `2.0.0` |

**Simple rule:** `feat:` → bump middle, everything else → bump last.

### Beta features & dev flags

- Unfinished features ship behind a `config.json` dev flag (e.g. `enable_benchmarking`), default off and undocumented. Flags are dev scaffolding, not user settings.
- A flag enters with an unfinished feature and is removed in the release that ships it — delete the flag, make the code unconditional. Don't let them accumulate.
- For pre-release soak testing use npm dist-tags (`minimal-ai@next`) rather than in-app flags. Rollback = revert + patch release.

### Changelog

- Every release adds an entry to `CHANGELOG.md` before tagging.
- Format: `## [x.y.z] - YYYY-MM-DD` with sections in fixed order, each at most
  once: `### Added` → `### Changed` → `### Fixed` → `### Removed`
  (`### Breaking Changes` first when a major needs it).
- **Pi-style bullets: one change = one bullet = one fact**, verb-first
  ("Fixed …", "Added …"), no bold-headline leads, no editorializing. Link the
  GitHub issue (`#N`) when one exists.
- **A bullet is a single source line** — never hand-wrap continuation lines.
- `scripts/check-changelog.mjs` runs in `npm test` and CI and enforces these
  rules for entries ≥ 3.0.0 (older entries are grandfathered); new entries
  must pass it.
- `CHANGELOG.md` is included in the npm package so installed users can read it.
- On startup, if the installed version is newer than the last-seen version
  (tracked in `config.json`), release notes are printed to the terminal.
- When an update is available, the changelog for the new version is fetched
  from GitHub and displayed.

## How to Work in This Repo

- **Root cause first.** Understand the problem before writing code. Read relevant source, reproduce if possible, then fix.
- **DRY and minimal.** Avoid duplication. Prefer deleting code to adding code. If a helper already exists, use it.
- **Reuse existing solutions.** Prefer standard library, established npm packages, and patterns already in the codebase over custom implementations.
- **Single path over competing paths.** Keep one clear way to do each behavior; remove duplicate/legacy pathways instead of maintaining parallel implementations.
- **No hidden fallbacks.** Do not silently substitute stale caches, alternate mechanisms, or best-effort behavior that changes outcomes without telling the user; make fallback behavior explicit or remove it.
- **Usability over cleverness.** Make workflows simple and friendly for non-technical users. Clear errors, sensible defaults, minimal steps.
- **Explain failures, don't just report them.** When something fails, diagnose the cause and surface a specific, actionable reason.
- **Terminal output should fit.** Long messages must wrap so cards/tables stay aligned and readable.
- **Commit workflow.** Propose a focused conventional-commit message and ask for approval before committing. Keep commits small and logical.
- **Document consolidation.** Completed plans go to `internal-docs/archive/`. Living runbooks go to `internal-docs/reference/`. Active strategy stays in `internal-docs/active/`. Keep the README simple; detailed internals live in `internal-docs/`.
- **Protect user data and live runs.** Never overwrite, move, delete, or truncate files that belong to active user sessions, run directories, logs, or model data. If you need to inspect or reproduce against live data, copy it to a temporary or test location first.
- **Codebase is the source of truth.** Verify assumptions against current files and tests, not memory or old docs.
- **Distinguish repo state from user environment.** The local repo version may differ from what the user has installed globally. Check installed state when relevant (`npm list -g`, `which minimal-ai`, etc.).
- **Test and lint before committing.** Run `npm test` and `npm run lint`. Keep the change focused.

## TODO Tracking

- **All to-do items, feature requests, and planned work live in GitHub issues** — not in planning docs or internal-docs.
- Before starting work, check `gh issue list` for open issues. Close issues when the work is done.
- Planning docs go stale silently; GitHub issues have status (open/closed), labels, and tracking.
- If you discover a gap or future enhancement during a session, create a GitHub issue rather than noting it in a doc.
- Internal-docs are for reference material and architecture decisions only — not for tracking work.

## Session Start: Codebase Health Report

At the start of every new session, before other work, run a read-only
codebase-health snapshot and give a brief interpretive summary. The goal is a
running sense of direction and early detection of structural drift — **not
enforcement.** No thresholds, no failing rules.

    node scripts/health-report.mjs

This wraps three established tools and prints a compact terminal report:
- **scc** (static binary) — size + file-level complexity (with a COCOMO estimate).
- **madge** (npx) — circular dependencies in the ESM import graph.
- **jscpd** (npx) — copy-paste duplication.

Generated artifacts (jscpd JSON) land under `reports/` (gitignored), and a
one-line dated snapshot is appended to `reports/health.log` so trends are
visible across sessions.

After running it, summarize in 2–3 lines: code size + total complexity, the
most complex files (and whether any are climbing), circular deps (none, or
list them), and duplication %. Call out anything that shifted since the last
report (read the tail of the trend log).

One-time setup: `scc` must be on PATH. It is a static Go binary — download
the darwin-arm64 build from https://github.com/boyter/scc/releases into
`~/.local/bin` (on PATH), or `brew install scc` if Homebrew is healthy.
`madge` and `jscpd` are fetched by `npx` on first use.

## Visual benchmark harness (cross-repo)

The visual benchmark spans two repos. **minimal-ai is the launcher**;
**local-llm-visual-benchmark** (`~/dev/local-llm-visual-benchmark`, sibling)
is the gallery (astro dev server on `:4321`). The gallery **never launches
the agent** — it only prepares run slots and later captures/scores.

**Launch chain** (`minimal-ai <profile> benchmark`): `benchmarkForProfile`
(`src/benchmark.mjs`) → `prepareBenchmarkRun` (writes
`runs/<benchmark-id>/<model-slug>/<run-id>/{metadata.json status=prepared,
prompt.md}`) → `runProfile` (`src/commands/run.mjs`: ensure server up + model
available, `preflightInference` 1-token, then `launchModel` → `spawn("pi",
["--model", "<provider>/<alias>", "--thinking", <level>, "<prompt>"],
{ stdio:"inherit", cwd: runDir })`). Thinking = `options.thinking ??
profile.thinkingLevel`; if `profile.thinkingOff === true` the model config
advertises no reasoning so pi's client kwargs can't override the server
off-switch (`src/harness-pi.mjs`). When pi exits, the model unloads unless
`--keep-server`.

**Run status** (gallery): `prepared → completed/failed`. Status flips only on
**capture** (Playwright `preview.png`/`preview.webm`/`preview.mp4`), not during
the agent run. The gallery sees progress solely by stat-checking which files
exist in the run dir (`src/lib/runs.ts: hydrateAssetAvailability`). It has no
live generation monitoring; `src/lib/omlx.ts` only lists `/v1/models`.

**Monitoring a live run** (the gallery can't help — do this directly):
- `~/.omlx/logs/server.log` `Chat completion:` lines = each model request.
  **The oMLX admin stats counter (`total_requests`/`completion_tokens`) ticks
  on completion, not arrival.** A long in-flight first turn shows frozen
  counters + high GPU = actively decoding, NOT stuck. The first turn
  routinely takes ~8-10 min (pi boot + prefill + one large decode) before
  the first `Chat completion:` line logs — do not call that a hang.
- Run dir files: `index.html` (agent output), `screenshot1.png`…
  (pi's Playwright review iterations); `preview.*` only after gallery
  capture.
- pi session JSONL: `~/.pi/agent/sessions/--<cwd-slug>--/`.
- GPU % is noisy: high during prefill+decode, but a resident model holds
  memory even when idle — not a verdict on its own.
