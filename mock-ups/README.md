# Minimal Intelligence Hub — mock-up

A fully interactive mock-up of the **Minimal Intelligence Hub** — the consolidated local
web app described in
[`internal-docs/active/2026-08-27-minimal-intelligence-hub.md`](../internal-docs/active/2026-08-27-minimal-intelligence-hub.md).

Built with **shadcn/ui components only** — React + Vite + Tailwind v4, default shadcn theme
(no custom colors, default Geist font). No hand-rolled UI primitives: every button, card,
table, badge, dialog, select, input, switch, progress bar, sidebar, and scroll area is a
shadcn component.

## Run it

```bash
cd /Users/eeshans/dev/minimal-ai/mock-ups
npm install
npm run dev        # http://localhost:5173
```

## Surfaces

| Surface | What's in it |
|---|---|
| **Dashboard** | backend status, machine stats, quick launch, recent runs + sweeps |
| **Models** | 5 profiles, oMLX/Ollama/GGUF catalogs, per-model settings, context×cache heatmap (shadcn Table), run-in-terminal |
| **Autotune** | 3 real sweeps, result matrix (shadcn Table), **new sweep as a page** (not a modal) |
| **Benchmark** | 157 runs, 143 previews, filters, run detail, data-science scorecards, **prepare run as a page** |
| **Logs & jobs** | job runner + streaming server log |
| **Learn** | 7 glass-box concept cards |
| **Settings** | harness, discovery paths, oMLX server settings, feature flags, update |

## shadcn components in use

`button` · `card` · `table` · `badge` · `dialog` (settings only) · `select` · `input` ·
`switch` · `progress` · `scroll-area` · `label` · `sidebar` · `sonner` (toasts) ·
`tooltip` · `accordion` · `skeleton` · `command` · `chart` · `sheet` · `separator` · `tabs`

Thin wrappers in `src/components/shared.tsx` (`StatCard`, `StatusBadge`, `BackendBadge`,
`RunCard`, `SectionTitle`, `CapabilityBadges`) exist only to DRY up repeated shadcn usage —
they render shadcn components with default variants, nothing hand-rolled.

## Data — all real

Read from the live machine on 2026-08-27, nothing invented:

- **5 saved profiles** — `~/.minimal-ai/profiles/*/profile.json`
- **oMLX models** — live `GET /v1/models` (8 models)
- **Ollama models** — live `GET /api/tags`
- **oMLX server status** — live `GET /api/status` (0.6.3rc3)
- **3 autotune sweeps** — `~/.minimal-ai/autotune/*/sweep.jsonl` + `optimal.json`
- **157 benchmark runs** — `local-llm-visual-benchmark/runs/**/metadata.json`
- **14 data-science scorecards** — real A/B-test scoring
- **143 preview images** — downscaled from real `preview.png` files
- **6 benchmark prompts** · **oMLX settings** · **hardware** (M4 Pro, 48 GB)

**Simulated** (labelled in the UI): launching the agent, running a sweep, capturing media,
applying settings, downloads, updates.

## Structure

```
mock-ups/
├── src/
│   ├── App.tsx                 # state-based router + shadcn Sidebar layout
│   ├── components/
│   │   ├── ui/                 # shadcn components (generated)
│   │   ├── shared.tsx          # thin DRY wrappers
│   │   └── flows.tsx           # settings Dialog (configure)
│   ├── views/                  # one file per surface (pages, not modals)
│   ├── data/                   # real data (types.ts, data.ts, runs.ts)
│   └── lib/                    # cn() + format helpers
├── public/previews/            # 143 downscaled real previews
├── data.json                   # extracted run metadata (source)
└── scripts/extract-data.mjs    # one-time extractor (re-run to refresh)
```

## Regenerate the run data

```bash
node scripts/extract-data.mjs   # rewrites data.json + public/previews + src/data/runs.ts
```
