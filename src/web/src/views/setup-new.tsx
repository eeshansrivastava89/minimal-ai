// Per-model setup/reconfigure — a page, not a modal. Mirrors the CLI flows
// in src/profile-setup/ one-to-one: the llama.cpp path carries the full
// capability + context/KV-cache heatmap + samplers sequence; oMLX carries
// MTP + the server-side thinking controls; Ollama is thin (thinking only).
// Entered only through the model hierarchy: a "needs setup" row on the
// Models page, or Reconfigure on a model detail page.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { HUB_DATA } from "@/data/data";
import type { MemoryHeatmap } from "@/data/types";
import { fmtBytes, fmtCtx } from "@/lib/format";
import { profileForModel } from "@/lib/lookup";
import { BackendBadge, CapabilityBadges, SectionTitle, StatusBadge } from "@/components/shared";
import type { Navigate } from "@/App";

// ── CLI constants (src/profile-setup/questions.mjs) ────────────────────────
const CACHE_CHOICES = [
  { value: "bf16", label: "bf16", hint: "16-bit · best quality · 2 bytes/elem" },
  { value: "f16", label: "f16", hint: "16-bit · stable fallback · 2 bytes/elem" },
  { value: "q8_0", label: "q8_0", hint: "8-bit · half memory · usually safe · 1 byte/elem" },
  { value: "q4_0", label: "q4_0", hint: "4-bit · quarter memory · quality tradeoff · 0.5 bytes/elem" },
];
const THINKING_CHOICES = [
  { value: "", label: "Harness default (Pi/omp session level)" },
  { value: "off", label: "Off — no thinking" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];
const SAMPLERS = [
  { field: "temperature", label: "Temperature", hint: "Randomness · 0 = deterministic · 0.6 balanced · 0.9+ creative" },
  { field: "topP", label: "Top-p", hint: "Token pool by probability mass · 0.9–0.95 good default" },
  { field: "topK", label: "Top-k", hint: "Limits to top K tokens · 0 = off (uses top-p) · 20 chat · 40–64 thinking" },
  { field: "minP", label: "Min-p", hint: "Probability floor · 0 = off · 0.05–0.1 reduces hallucination" },
  { field: "presencePenalty", label: "Presence penalty", hint: "Penalizes any used token · 0 = off · 1.0–1.5 general chat" },
  { field: "repeatPenalty", label: "Repeat penalty", hint: "Multiplies down repeated tokens · 1.0 = no effect · 1.0–1.1 typical" },
] as const;
const LOW_BIT_KV_HINT = "⚠ low-bit KV at 32K+ context can degrade tool-call fidelity — prefer q8_0+ for agentic runs";
// fitCheck thresholds (src/hardware.mjs): ≤70% available = fits, ≤90% = tight.
function fitOf(total: number, available: number): "fits" | "tight" | "wont" {
  const ratio = total / available;
  return ratio <= 0.7 ? "fits" : ratio <= 0.9 ? "tight" : "wont";
}

// ── shadcn field wrappers (DRY for the long form) ──────────────────────────
function NumField({
  label, hint, value, onChange, min, max, step,
}: { label: string; hint?: string; value: number | string; onChange: (v: string) => void; min?: number; max?: number; step?: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      <Input type="number" className="w-40" value={value} min={min} max={max} step={step} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function SwitchRow({
  label, hint, checked, onChange,
}: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm text-foreground">{label}</div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SelectField({
  label, hint, value, onChange, options,
}: { label: string; hint?: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function OverviewRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b py-2 last:border-b-0">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{k}</div>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

// ── The context × KV-cache heatmap (llama.cpp, has-KV-params path) ─────────
function Heatmap({
  heatmap, selectedCtx, selectedCache, onPick,
}: {
  heatmap: MemoryHeatmap;
  selectedCtx: number;
  selectedCache: string;
  onPick: (ctx: number, cache: string) => void;
}) {
  const cellTone = (bytes: number) => {
    const fit = fitOf(bytes, heatmap.ramAvailable);
    return fit === "fits"
      ? "text-emerald-600 dark:text-emerald-400"
      : fit === "tight"
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";
  };
  return (
    <div>
      <div className="mb-2 text-xs text-muted-foreground">
        RAM: {heatmap.ramInstalledGB} GB installed · {fmtBytes(heatmap.ramAvailable)} available now · Fixed
        (model + overhead): {fmtBytes(heatmap.fixedBytes)} · {heatmap.kvLayers} KV layers
      </div>
      <div className="mb-2 flex gap-3 text-xs">
        <span className="text-emerald-600 dark:text-emerald-400">fits</span>
        <span className="text-amber-600 dark:text-amber-400">tight</span>
        <span className="text-red-600 dark:text-red-400">won't fit</span>
        <span className="text-muted-foreground">— click a cell to pick context + cache</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Context</TableHead>
            {heatmap.caches.map((c, i) => (
              <TableHead key={c} className="text-right">
                {c} <span className="text-muted-foreground">({CACHE_CHOICES.find((x) => x.value === c)?.hint.match(/([\d.]+ bytes\/elem)/)?.[1]})</span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {heatmap.grid.map((row) => (
            <TableRow key={row.ctx}>
              <TableCell className={row.ctx === selectedCtx ? "font-medium text-foreground" : "text-muted-foreground"}>
                {fmtCtx(row.ctx)}
              </TableCell>
              {row.cells.map((bytes, colIdx) => {
                const cache = heatmap.caches[colIdx];
                const active = row.ctx === selectedCtx && cache === selectedCache;
                return (
                  <TableCell
                    key={cache}
                    className={`cursor-pointer text-right tabular-nums ${cellTone(bytes)} ${active ? "ring-2 ring-foreground/30 rounded-md" : ""}`}
                    onClick={() => onPick(row.ctx, cache)}
                  >
                    ~{fmtBytes(bytes)}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Total RAM for an arbitrary ctx/K/V/parallel combination. Presets use the
 *  real precomputed grid; custom contexts scale KV linearly from the largest
 *  preset (exact for KV bytes, hence ≈ only through allocation rounding). */
function estimateFor(
  heatmap: MemoryHeatmap, ctx: number, cacheK: string, cacheV: string, parallel: number
): number {
  const row = heatmap.grid.find((r) => r.ctx === ctx);
  const fixed = heatmap.fixedBytes;
  if (row) {
    const idx = (c: string) => heatmap.caches.indexOf(c);
    if (idx(cacheK) >= 0 && idx(cacheV) >= 0 && cacheK === cacheV) return row.cells[idx(cacheK)];
  }
  const maxRow = heatmap.grid[heatmap.grid.length - 1];
  const kvPart = (cache: string) => {
    const i = heatmap.caches.indexOf(cache);
    if (i >= 0) return (maxRow.cells[i] - fixed) / 2;
    return (maxRow.cells[0] - fixed) / 2 / 2 * (cache === "q8_0" ? 1 : cache === "q4_0" ? 0.5 : 2); // f16 ≈ bf16
  };
  return fixed + (kvPart(cacheK) + kvPart(cacheV)) * parallel * (ctx / maxRow.ctx);
}

// ── The page ───────────────────────────────────────────────────────────────
export function SetupNew({
  modelId, backendId, navigate,
}: { modelId: string; backendId?: string; navigate: Navigate }) {
  const profile = profileForModel(modelId);
  const backend = backendId ?? profile?.backend ?? "omlx";
  // Backend lookups key on the model id (profile.modelAlias); reconfigure
  // arrives with the profile id, so resolve through the profile first.
  const modelKey = profile?.modelAlias ?? modelId;
  const flags = (profile?.flags ?? {}) as Record<string, unknown>;
  const caps = (profile?.capabilities ?? {}) as Record<string, unknown>;

  const gguf = backend === "llama-cpp" ? HUB_DATA.ggufModels.find((m) => String(m.id) === modelKey) : undefined;
  const g = (gguf ?? {}) as Record<string, unknown>;
  const ggufCaps = gguf
    ? { thinking: g.thinking, vision: g.vision, imatrix: g.imatrix, quant: String(g.quant), ctxSize: g.ctxSize }
    : undefined;
  const omlxEntry = backend === "omlx" ? HUB_DATA.omlxModels.find((m) => m.id === modelKey) : undefined;
  const ollamaEntry = backend === "ollama" ? HUB_DATA.ollamaModels.find((m) => m.id === modelKey) : undefined;
  const heatmap = HUB_DATA.memoryHeatmaps.find((h) => h.modelId === modelKey);

  const maxCtx =
    (heatmap?.maxCtx ?? Number(ggufCaps?.ctxSize ?? omlxEntry?.maxModelLen ?? (caps.contextLength as number) ?? 262144));
  const label = profile?.label ?? modelKey;
  const detectedCaps = { ...ggufCaps, ...caps } as Record<string, unknown>;
  const initialCtx = Number(flags.ctxSize ?? (heatmap?.maxCtx ?? 131072));

  // ── form state, prefilled from the profile on reconfigure ──────────────
  const [mtp, setMtp] = useState(Boolean(caps.mtp) && flags.specDraftNMax != null);
  const [draftTokens, setDraftTokens] = useState(String(flags.specDraftNMax ?? 2));
  const [vision, setVision] = useState(Boolean(detectedCaps.vision));
  const [thinkingDefaults, setThinkingDefaults] = useState(Boolean(detectedCaps.thinking));
  const [gpuLayers, setGpuLayers] = useState(String(flags.nGpuLayers ?? 99));
  const [ctxSize, setCtxSize] = useState(String(initialCtx));
  const [cacheK, setCacheK] = useState(String(flags.cacheTypeK ?? "bf16"));
  const [sameV, setSameV] = useState(flags.cacheTypeV == null || flags.cacheTypeV === flags.cacheTypeK);
  const [cacheV, setCacheV] = useState(String(flags.cacheTypeV ?? flags.cacheTypeK ?? "bf16"));
  const [samplers, setSamplers] = useState<Record<string, string>>(
    Object.fromEntries(SAMPLERS.map((s) => [s.field, String(flags[s.field] ?? (s.field === "topP" ? 0.95 : s.field === "topK" ? 20 : s.field === "repeatPenalty" ? 1.0 : 0))]))
  );
  const [batchSize, setBatchSize] = useState(String(flags.batchSize ?? 512));
  const [parallel, setParallel] = useState(String(flags.parallel ?? 1));
  const [flashAttn, setFlashAttn] = useState((flags.flashAttention ?? "on") === "on");
  const [jinja, setJinja] = useState(flags.jinja !== false);
  const [thinkingLevel, setThinkingLevel] = useState(profile?.thinkingLevel ?? "");
  const [thinkingOff, setThinkingOff] = useState(Boolean(profile?.thinkingOff));
  const [thinkingBudgetOn, setThinkingBudgetOn] = useState(false);
  const [thinkingBudget, setThinkingBudget] = useState("4096");

  const ctx = Math.min(Number(ctxSize) || maxCtx, maxCtx);
  const effCacheV = sameV ? cacheK : cacheV;
  const total = heatmap
    ? estimateFor(heatmap, ctx, cacheK, effCacheV, Number(parallel) || 1)
    : null;
  const fit = total != null ? fitOf(total, heatmap!.ramAvailable) : null;
  const lowBitWarn = ctx > 32768 && (cacheK === "q4_0" || (!sameV && cacheV === "q4_0"));

  const ctxOptions = [4096, 8192, 16384, 32768, 65536, 131072, 262144]
    .filter((c) => c <= maxCtx)
    .map((c) => ({ value: String(c), label: fmtCtx(c) }));

  const save = () => {
    toast(`Saved profile for ${label} — simulated`);
    navigate(profile ? "model" : "models", profile ? { modelId: profile.id } : undefined);
  };

  return (
    <div>
      <h1 className="flex flex-wrap items-center gap-2 text-3xl font-semibold tracking-tight text-foreground">
        {label}
        <BackendBadge backend={backend} />
        <StatusBadge status={profile ? "ok" : "needs-setup"}>{profile ? "reconfigure" : "new setup"}</StatusBadge>
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        {profile
          ? `Adjust ${label}'s saved profile — same flow as the CLI reconfigure.`
          : `Create a profile for ${modelKey} — same flow as the CLI setup.`}
      </p>

      <SectionTitle title="Model overview" />
      <Card>
        <CardContent className="px-4">
          <OverviewRow k="Model">{label}</OverviewRow>
          <OverviewRow k="Detected"><CapabilityBadges caps={detectedCaps} /></OverviewRow>
          <OverviewRow k="Backend">{backend === "omlx" ? "oMLX (managed server)" : backend === "ollama" ? "Ollama (managed server)" : "llama.cpp (local server)"}</OverviewRow>
          {backend === "llama-cpp" ? (
            <OverviewRow k="Model file">
              <span className="font-mono text-xs">{String(profile?.modelPath ?? g.modelPath ?? "—")}</span>
            </OverviewRow>
          ) : (
            <OverviewRow k="Context">{fmtCtx(maxCtx)}</OverviewRow>
          )}
        </CardContent>
      </Card>

      {/* ── oMLX / Ollama: managed servers own perf; profile records MTP + thinking ── */}
      {(backend === "omlx" || backend === "ollama") && (
        <>
          {backend === "omlx" && Boolean(caps.mtp) && (
            <>
              <SectionTitle title="MTP" />
              <Card>
                <CardContent className="px-4">
                  <SwitchRow
                    label="Use MTP speculative decoding?"
                    hint="oMLX native MTP — enabled at load time"
                    checked={mtp}
                    onChange={setMtp}
                  />
                </CardContent>
              </Card>
            </>
          )}

          {backend === "omlx" ? (
            <SectionTitle title="Thinking control" meta="oMLX server-side" />
          ) : (
            <SectionTitle title="Thinking" />
          )}
          <Card>
            <CardContent className="flex flex-col gap-4 px-4">
              {backend === "omlx" ? (
                <>
                  <div className="text-xs text-muted-foreground">
                    Thinking off is the only hard control — client kwargs override server settings, so off also strips
                    reasoning from harness configs.
                  </div>
                  <SwitchRow
                    label="Turn thinking off entirely?"
                    hint="Server-side hard off — hides harness thinking toggles for this model"
                    checked={thinkingOff}
                    onChange={setThinkingOff}
                  />
                  {!thinkingOff && (
                    <SwitchRow
                      label="Set a hard thinking budget?"
                      hint="Force-stops thinking at this many tokens · 4096 works well for Qwen3.8"
                      checked={thinkingBudgetOn}
                      onChange={setThinkingBudgetOn}
                    />
                  )}
                  {!thinkingOff && thinkingBudgetOn && (
                    <NumField label="Thinking budget tokens" value={thinkingBudget} onChange={setThinkingBudget} min={256} max={65536} />
                  )}
                </>
              ) : (
                <div className="text-xs text-muted-foreground">
                  Ollama /v1 honors thinking levels as soft steering — but the thinking trace is never shown, and "off"
                  still thinks at the server default (harness limitation).
                </div>
              )}
              {!thinkingOff && (
                <SelectField
                  label="Thinking level for launches"
                  hint={backend === "omlx" ? "Soft steering (~2x swing) — benchmark runs inherit this" : undefined}
                  value={thinkingLevel || ""}
                  onChange={setThinkingLevel}
                  options={THINKING_CHOICES}
                />
              )}
            </CardContent>
          </Card>

          <div className="text-xs text-muted-foreground">
            {backend === "omlx"
              ? "Server settings (quant, KV cache, MTP internals) live in the oMLX dashboard."
              : "Server settings live in the Ollama app / OLLAMA_* environment."}
          </div>
        </>
      )}

      {/* ── llama.cpp: the full CLI flow ── */}
      {backend === "llama-cpp" && (
        <>
          <SectionTitle title="Capabilities" />
          <Card>
            <CardContent className="flex flex-col gap-4 px-4">
              {Boolean(caps.mtp) && (
                <>
                  <SwitchRow
                    label="Enable MTP speculative decoding?"
                    hint="Predicts multiple tokens per step — 1.5–3x faster, no quality loss"
                    checked={mtp}
                    onChange={setMtp}
                  />
                  {mtp && (
                    <NumField
                      label="Draft tokens per step"
                      hint="Tokens the draft model predicts per step · 2 recommended · 4 aggressive"
                      value={draftTokens}
                      onChange={setDraftTokens}
                      min={1}
                      max={8}
                    />
                  )}
                </>
              )}
              {Boolean(caps.vision) && (
                <SwitchRow
                  label="Enable vision?"
                  hint="Enables image understanding via the multimodal projector"
                  checked={vision}
                  onChange={setVision}
                />
              )}
              {Boolean(caps.thinking) && (
                <SwitchRow
                  label="Use thinking/loop-safe defaults?"
                  hint="Step-by-step reasoning — slower but better for math/code/logic · sets top-k 64, presence 0, repeat 1.1"
                  checked={thinkingDefaults}
                  onChange={setThinkingDefaults}
                />
              )}
              <NumField
                label="GPU layers"
                hint="Layers offloaded to GPU · 99 = all on GPU (recommended for Apple Silicon) · 0 = CPU only"
                value={gpuLayers}
                onChange={setGpuLayers}
                min={0}
                max={999}
              />
            </CardContent>
          </Card>

          <SectionTitle title="Context & KV cache" meta="total RAM by context window" />
          {heatmap ? (
            <Card>
              <CardContent className="px-4">
                <Heatmap
                  heatmap={heatmap}
                  selectedCtx={ctx}
                  selectedCache={cacheK}
                  onPick={(c, cache) => {
                    setCtxSize(String(c));
                    setCacheK(cache);
                  }}
                />
                <div className="mt-4 flex flex-col gap-4">
                  <SelectField
                    label="Context window"
                    hint={`Model max ${maxCtx.toLocaleString()} tokens · KV cache grows with context`}
                    value={ctxOptions.some((o) => o.value === ctxSize) ? ctxSize : "custom"}
                    onChange={(v) => v === "custom" || setCtxSize(v)}
                    options={[...ctxOptions, { value: "custom", label: "Custom (enter tokens)" }]}
                  />
                  {!ctxOptions.some((o) => o.value === ctxSize) && (
                    <NumField label="Context window tokens" value={ctxSize} onChange={setCtxSize} min={1024} max={maxCtx} />
                  )}
                  {lowBitWarn && <div className="text-xs text-amber-600 dark:text-amber-400">{LOW_BIT_KV_HINT}</div>}
                  <SelectField
                    label="KV cache precision (K)"
                    hint={CACHE_CHOICES.find((c) => c.value === cacheK)?.hint}
                    value={cacheK}
                    onChange={setCacheK}
                    options={CACHE_CHOICES.map((c) => ({
                      value: c.value,
                      label: heatmap
                        ? `${c.label} ~${fmtBytes(estimateFor(heatmap, ctx, c.value, sameV ? c.value : cacheV, Number(parallel) || 1))}`
                        : c.label,
                    }))}
                  />
                  <SwitchRow label="Use same precision for V cache?" checked={sameV} onChange={setSameV} />
                  {!sameV && (
                    <SelectField
                      label="V cache precision"
                      value={cacheV}
                      onChange={setCacheV}
                      options={CACHE_CHOICES}
                    />
                  )}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="flex flex-col gap-4 px-4">
                <div className="text-xs text-muted-foreground">
                  No KV metadata for this model — plain path: context + separate K/V precision (like the CLI's
                  hasKvParams=false branch).
                </div>
                <NumField label="Context window tokens" hint={`Model max ${maxCtx.toLocaleString()}`} value={ctxSize} onChange={setCtxSize} min={1024} max={maxCtx} />
                {lowBitWarn && <div className="text-xs text-amber-600 dark:text-amber-400">{LOW_BIT_KV_HINT}</div>}
                <SelectField label="K cache precision" hint="KV cache precision · lower = less memory · bf16 best quality" value={cacheK} onChange={setCacheK} options={CACHE_CHOICES} />
                <SelectField label="V cache precision" hint="Same tradeoff as K cache · some models are more sensitive to V precision" value={cacheV} onChange={setCacheV} options={CACHE_CHOICES} />
              </CardContent>
            </Card>
          )}

          {total != null && (
            <>
              <SectionTitle title="Memory estimate" />
              <Card>
                <CardContent className="px-4">
                  <OverviewRow k="Model + projector + overhead">{fmtBytes(heatmap!.fixedBytes)}</OverviewRow>
                  <OverviewRow k="KV cache">
                    ≈{fmtBytes(Math.max(total - heatmap!.fixedBytes, 0))} · {cacheK}/{effCacheV} · {fmtCtx(ctx)} · ×{parallel} slot(s)
                  </OverviewRow>
                  <OverviewRow k="Total">
                    <span className="flex items-center gap-2">
                      ≈{fmtBytes(total)}
                      <StatusBadge status={fit === "fits" ? "ok" : fit === "tight" ? "prepared" : "down"}>
                        {fit === "fits" ? "fits" : fit === "tight" ? "tight" : "won't fit"}
                      </StatusBadge>
                    </span>
                  </OverviewRow>
                  <OverviewRow k="Available now">{fmtBytes(heatmap!.ramAvailable)} of {heatmap!.ramInstalledGB} GB</OverviewRow>
                </CardContent>
              </Card>
            </>
          )}

          <SectionTitle title="Samplers" />
          <Card>
            <CardContent className="grid grid-cols-2 gap-4 px-4 sm:grid-cols-3">
              {SAMPLERS.map((s) => (
                <NumField key={s.field} label={s.label} hint={s.hint} value={samplers[s.field]} onChange={(v) => setSamplers((prev) => ({ ...prev, [s.field]: v }))} step={0.05} />
              ))}
            </CardContent>
          </Card>

          <SectionTitle title="Performance" />
          <Card>
            <CardContent className="flex flex-col gap-4 px-4">
              <NumField label="Batch size" hint="Tokens processed per step during prompt ingestion · 512 default · higher for long prompts" value={batchSize} onChange={setBatchSize} min={1} max={4096} />
              <NumField label="Parallel slots" hint="Concurrent request slots · 1 = single user · KV cache multiplies by slots" value={parallel} onChange={setParallel} min={1} max={10} />
              <SwitchRow label="Enable flash attention?" hint="Faster, less memory · on for modern hardware · off only for old driver issues" checked={flashAttn} onChange={setFlashAttn} />
              <SwitchRow label="Enable Jinja templates?" hint="Proper chat formatting · on for modern models · off only for very old models" checked={jinja} onChange={setJinja} />
            </CardContent>
          </Card>

          <SectionTitle title="Thinking" />
          <Card>
            <CardContent className="px-4">
              <SelectField
                label="Thinking level for launches"
                hint="How hard the model thinks on each launch. Benchmark runs inherit this. Harness default = Pi/omp session level."
                value={thinkingLevel || ""}
                onChange={setThinkingLevel}
                options={THINKING_CHOICES}
              />
            </CardContent>
          </Card>
        </>
      )}

      <SectionTitle title="Summary" />
      <Card>
        <CardContent className="px-4">
          <OverviewRow k="Model">{label}</OverviewRow>
          <OverviewRow k="Backend">{backend}</OverviewRow>
          {backend === "llama-cpp" && (
            <>
              <OverviewRow k="Context">{`${ctx.toLocaleString()} tokens`}</OverviewRow>
              <OverviewRow k="GPU layers">{gpuLayers}</OverviewRow>
              <OverviewRow k="KV cache">{`${cacheK}/${effCacheV}`}</OverviewRow>
              {SAMPLERS.map((s) => (
                <OverviewRow key={s.field} k={s.label}>{samplers[s.field]}</OverviewRow>
              ))}
              <OverviewRow k="Batch size">{batchSize}</OverviewRow>
              <OverviewRow k="Parallel">{parallel}</OverviewRow>
              <OverviewRow k="Flash attention">{flashAttn ? "on" : "off"}</OverviewRow>
              <OverviewRow k="Jinja">{jinja ? "on" : "off"}</OverviewRow>
              {mtp && <OverviewRow k="MTP">{`enabled (${draftTokens} draft tokens)`}</OverviewRow>}
              {vision && <OverviewRow k="Vision">enabled</OverviewRow>}
            </>
          )}
          <OverviewRow k="Thinking">
            {backend === "omlx" && thinkingOff
              ? "off entirely (server-side, hard)"
              : `${thinkingLevel || "harness default"}${backend === "omlx" && thinkingBudgetOn ? ` · hard budget ${Number(thinkingBudget).toLocaleString()} tokens` : ""}`}
          </OverviewRow>
        </CardContent>
      </Card>

      <div className="mt-4 flex gap-2">
        <Button onClick={save}>Save profile</Button>
        <Button variant="outline" onClick={() => navigate(profile ? "model" : "models", profile ? { modelId: profile.id } : undefined)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}