// One-time extraction: walk the local-llm-visual-benchmark runs/ tree and
// produce a compact, real dataset for the hub mock-up. Also downscales every
// preview.png into public/previews/ so the mock-up is self-contained.
//
// Run: node scripts/extract-data.mjs
// Output: data.json (source) + public/previews/*.jpg + src/data/runs.ts

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GALLERY = "/Users/eeshans/dev/local-llm-visual-benchmark";
const RUNS_ROOT = join(GALLERY, "runs");
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW_DIR = join(OUT_DIR, "public", "previews");

const BENCH_TITLES = {
  "ab-test-analysis": "A/B Test Production Analysis",
  "macro-wildflower-meadow": "Macro Wildflower Meadow",
  "sakura": "Sakura Tree",
  "snow-globe-village": "Snow Globe Village",
  "solar-system": "Solar System",
  "sunset-ocean-study": "Sunset Ocean Study",
};

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name === "metadata.json") out.push(p);
  }
  return out;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function main() {
  const files = await walk(RUNS_ROOT);
  const runs = [];
  const previewJobs = [];

  for (const file of files) {
    let m;
    try {
      m = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (!m || !m.runId || !m.benchmark?.id) continue;
    // Skip nested .venv metadata (site-packages noise).
    if (file.includes(".venv")) continue;

    const bench = m.benchmark.id;
    const runDir = dirname(file);
    const previewSrc = join(runDir, "preview.png");
    let preview = null;
    try {
      const s = await stat(previewSrc);
      if (s.isFile()) {
        const name = `${m.model?.slug ?? "model"}-${m.runId}.jpg`;
        preview = `previews/${name}`;
        previewJobs.push({ src: previewSrc, dest: join(PREVIEW_DIR, name) });
      }
    } catch { /* no preview */ }

    const cap = m.capture?.video?.quality ?? {};
    const tok = m.runner?.tokenMetrics ?? {};
    const spd = m.runner?.speedMetrics ?? {};
    const res = m.results ?? {};

    // Data-science runs carry a scorecard + summary (the "scoring" surface).
    let ds = null;
    if (m.kind === "data-science") {
      try {
        const sc = JSON.parse(await readFile(join(runDir, "scorecard.json"), "utf8"));
        const su = JSON.parse(await readFile(join(runDir, "summary.json"), "utf8"));
        ds = {
          scorecard: {
            total: sc.total, earned: sc.earned, pct: sc.pct,
            checks: Object.values(sc.checks ?? {}).map((c) => ({
              label: c.label, earned: c.earned, max: c.max, pass: Boolean(c.pass), detail: c.detail,
            })),
          },
          summary: {
            status: su.status, recommendedVariant: su.recommended_variant, decision: su.decision,
            metrics: (su.metrics ?? []).map((x) => ({ label: x.label, value: x.value, delta: x.delta, context: x.context })),
          },
        };
      } catch { /* no scorecard/summary */ }
    }

    runs.push({
      id: m.runId,
      bench,
      benchTitle: BENCH_TITLES[bench] ?? bench,
      kind: m.kind ?? "visual",
      model: m.model?.id ?? null,
      modelDisplay: m.model?.displayName ?? m.model?.id ?? null,
      slug: m.model?.slug ?? null,
      backend: m.runner?.backendLabel ?? null,
      source: m.runner?.modelSource ?? null,
      harness: m.runner?.intendedRunner ?? null,
      status: m.status ?? "prepared",
      createdAt: m.createdAt ?? null,
      completedAt: m.completedAt ?? null,
      fps: num(cap.measuredFps),
      minFps: num(cap.minFps),
      frames: num(cap.frames),
      viewport: cap.viewport ?? null,
      promptTok: num(tok.promptTokens),
      compTok: num(tok.completionTokens),
      totalTok: num(tok.totalTokens),
      tokReported: Boolean(tok.reported),
      prefill: num(spd.prefillTokensPerSecond),
      gen: num(spd.generationTokensPerSecond),
      ttft: num(spd.ttftMs),
      specAccept: num(spd.speculativeDecodeAcceptance),
      wallMs: num(res.wallClockMs),
      turns: num(res.agentTurns),
      toolCalls: num(res.toolCalls),
      success: Boolean(res.success),
      preview,
      ds,
    });
  }

  runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  await mkdir(PREVIEW_DIR, { recursive: true });
  let copied = 0;
  for (const job of previewJobs) {
    try {
      // Downscale to 640px-wide JPEG (quality ~80) — keeps the mock-up light.
      execFileSync("sips", ["-Z", "640", "-s", "format", "jpeg", "-s", "formatOptions", "80", job.src, "--out", job.dest], { stdio: "ignore" });
      copied++;
    } catch { /* skip unreadable image */ }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: "local-llm-visual-benchmark/runs/**/metadata.json",
    runCount: runs.length,
    previewCount: copied,
    runs,
  };
  await writeFile(join(OUT_DIR, "data.json"), JSON.stringify(out, null, 2) + "\n");

  // Generate src/data/runs.ts directly (typed, exported).
  const runsTs =
    'import type { Run } from "./types";\n\n' +
    "// Real benchmark runs, generated from ../data.json by scripts/extract-data.mjs.\n" +
    `export const RUNS: Run[] = ${JSON.stringify(runs)};\n`;
  await writeFile(join(OUT_DIR, "src", "data", "runs.ts"), runsTs);

  console.log(`extracted ${runs.length} runs, copied ${copied} previews, wrote src/data/runs.ts`);
}

main().catch((e) => { console.error(e); process.exit(1); });
