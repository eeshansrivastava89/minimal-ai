# Agent Instructions for offgrid-ai

## Release Workflow

- **Never run `npm publish` locally.** Pushing a `v*` tag triggers `.github/workflows/ci.yml`, which runs tests and publishes to npm with provenance. Publishing manually causes CI to fail with npm 403.
- Version bumps: commit first, then push the tag. Let CI publish.

## How to Work in This Repo

- **Root cause first.** Understand the problem before writing code. Read relevant source, reproduce if possible, then fix.
- **DRY and minimal.** Avoid duplication. Prefer deleting code to adding code. If a helper already exists, use it.
- **Reuse existing solutions.** Prefer standard library, established npm packages, and patterns already in the codebase over custom implementations.
- **Usability over cleverness.** Make workflows simple and friendly for non-technical users. Clear errors, sensible defaults, minimal steps.
- **No implicit skill runs.** Only run skills on explicit invocation (`$skill` in Codex, `/skill:` in Pi, or direct selection).
- **Codebase is the source of truth.** Verify assumptions against current files and tests, not memory or old docs.
- **Test and lint before committing.** Run `npm test` and `npm run lint`. Keep the change focused.
