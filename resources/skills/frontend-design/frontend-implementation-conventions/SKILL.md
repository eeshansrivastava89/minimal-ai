---
name: frontend-implementation-conventions
description: Use when implementing frontend/UI changes in an existing project, especially when adding views, tabs, comparison surfaces, or styling. Prioritizes project conventions, Tailwind/utilities, DRY helpers, and minimal custom CSS/custom code.
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [frontend, tailwind, ui, maintainability, conventions]
    related_skills: [frontend-design, test-driven-development, visual-qa]
---

# Frontend Implementation Conventions

Use this skill when changing an existing frontend application. It complements creative `frontend-design`: the default is not to invent a new styling system, but to extend the current one cleanly.

## Core Rule

Inspect and follow the project's existing UI system before adding new styles or helpers.

Prefer, in order:
1. Existing components, helpers, and rendering seams.
2. Existing design tokens and utility classes.
3. Tailwind/utility classes in markup when the project uses Tailwind or utility-first styling.
4. Small shared helpers for repeated behavior.
5. New custom CSS/custom JS only when the above cannot express the need cleanly.

## Workflow

1. Identify the styling stack and conventions:
   - package dependencies (`tailwindcss`, component libraries, CSS modules, global CSS)
   - existing utility classes and design tokens
   - existing helpers for URLs, media rendering, identity labels, filtering, or state
2. Add tests first for behavior when the change is functional.
3. Implement the smallest useful UI slice.
4. Reuse existing helpers instead of duplicating logic in the new view.
5. If you add custom CSS, justify why utilities/tokens were insufficient.
6. Run focused tests, full tests, typecheck/lint/check, E2E when UI-visible, and build/static build when public output changes.
7. Update plans/docs with visible checkboxes when the user is tracking work from an implementation plan.

## Tailwind / Utility-First Preference

When the user says or has established that they prefer Tailwind utilities, avoid adding new `.feature-*` CSS classes for simple layout, spacing, borders, typography, colors, or responsive grids. Put utility classes directly on the rendered elements/components and keep custom CSS reserved for reusable primitives or behavior that utility classes cannot cover.

If you already added custom CSS and the user reminds you to use Tailwind/utilities, refactor the new CSS out immediately rather than merely acknowledging the preference.

## DRY/KISS Frontend Helpers

For UI features such as compare views, galleries, tables, detail modals, or static previews:
- Centralize stable identity logic in one helper.
- Centralize asset/media URL generation instead of constructing paths inline.
- Centralize selection state helpers when multiple controls use the same keying behavior.
- Avoid hardcoded labels when existing metadata or display helpers can produce them.
- Keep the first feature slice small; defer synchronized playback, scoring, leaderboards, or complex metrics until the simple view works.

## Pitfalls

- Do not treat a passing component test as complete if `tsc`, framework check, or E2E still fails.
- Do not bury implementation-plan progress in prose only; if the plan uses checkboxes, mark completed items explicitly.
- Do not create a second public/editorial UI when the plan says to extend the existing workbench.
- Do not leak local-only data into static/public UI: raw HTML, raw responses, streams, commands, local paths, localhost URLs, or prepared prompts must remain local-only.

## Verification Checklist

- [ ] New behavior has focused tests or E2E coverage.
- [ ] UI follows existing project conventions and utilities.
- [ ] No avoidable new custom CSS/custom JS/hardcoded styling.
- [ ] Shared helpers own identity/path/media/selection logic.
- [ ] Full tests and project check/typecheck pass.
- [ ] E2E passes for visible UI changes.
- [ ] Static/public build and privacy scan pass when static output changes.
- [ ] Implementation plan/docs have explicit checked-off progress when relevant.
