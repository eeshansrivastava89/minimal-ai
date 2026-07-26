# Agent Instructions for minimal-ai

## Project Context

- **Renamed from offgrid-ai to minimal-ai** (v2.0.0). Umbrella brand: Minimal Intelligence (eeshans.com, "a Minimal Intelligence tool" byline). Sibling tools (goalbot, sidequests) carry their own plain names — no shared prefix.
- **@eeshans/cli-kit** (`~/dev/eeshans-cli-kit`, github.com/eeshansrivastava89/cli-kit) is the shared CLI design system (Clack-based), published on npm. This repo depends on `@eeshans/cli-kit: ^0.1.0`; the kit follows the same tag-triggered CI release workflow. For local co-development across the two repos, use `npm link`; bump the dep range here when a new kit minor ships.

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

- Every release must add an entry to `CHANGELOG.md` before tagging.
- Format: `## [x.y.z] - YYYY-MM-DD` with `### Added`, `### Fixed`, `### Changed` sections.
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
