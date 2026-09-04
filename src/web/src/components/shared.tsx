// Thin presentational helpers built entirely on shadcn primitives.
// These exist only to DRY up repeated shadcn usage across views — no
// hand-rolled UI, no custom colors. Every visual is a shadcn component
// using its default variants.

import { LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { backendLabel, fmtDateShort, fmtTps } from "@/lib/format";
import {
  runCardIdentity,
  runCardMediaMessage,
  runCardState,
} from "@/lib/runs-view";
import type { AutotuneRun, Run } from "@/data/types";
import type { Navigate } from "@/App";

// One config cell in the sweep matrix — plan rows (median null), live
// results, and finished sweeps all feed the same shape.
export interface SweepConfig {
  id: string;
  label?: string;
  settings: Record<string, unknown>;
  tested?: boolean;
  median?: number | null;
}

// The sweep config-space matrix: 3 KV-quant blocks, each a 3×4 sub-matrix
// (speculative × thinking×ANE). One component renders all three states:
// plan (✓ will measure), live (values as they land), results (★ on the pick).
// The axes mirror src/autotune/matrix.mjs but can't import it — that module
// pulls node:fs through report.mjs → recommend.mjs. If the grid changes in
// the CLI, these axes change with it.
const SPEC_ROWS: [string, string][] = [
  ["none", "none"],
  ["mtp", "MTP (own heads)"],
  ["dflash", "DFlash (z-lab)"],
];
const COL_AXES: [string, string][] = [
  ["off", "off"],
  ["off", "on"],
  ["on", "off"],
  ["on", "on"],
];
const KV_STATES = ["off", "q4", "q8"];

function sweepCoord(s: Record<string, unknown>) {
  return {
    spec: s.dflash_enabled ? "dflash" : s.mtp_enabled ? "mtp" : "none",
    think: s.enable_thinking ? "on" : "off",
    ane: s.qwen35_ane_prefill_enabled ? "on" : "off",
    kv: s.turboquant_kv_enabled ? `q${s.turboquant_kv_bits ?? ""}` : "off",
  };
}

export function SweepMatrix({ configs, recommended }: { configs: SweepConfig[]; recommended?: string | null }) {
  const base = configs.find((c) => c.id === "vanilla");
  const thinkLabel = (() => {
    const t = configs.find((c) => c.settings.enable_thinking);
    return (t?.settings.thinking_budget_tokens as number) ? `think +${t?.settings.thinking_budget_tokens}` : "think on";
  })();

  const headers = COL_AXES.map(([think, ane]) => (
    <TableHead key={`${think}-${ane}`} className="text-center text-[10px] uppercase tracking-wide">
      {think === "on" ? <span className="text-foreground">{thinkLabel}</span> : <span className="text-destructive">think off</span>}
      {" · "}
      {ane === "on" ? <span className="text-foreground">ANE on</span> : <span className="text-destructive">ANE off</span>}
    </TableHead>
  ));

  const cellFor = (spec: string, think: string, ane: string, kv: string) => {
    if (spec === "dflash" && (think === "on" || ane === "on")) {
      return { cls: "bg-muted/40 text-muted-foreground", t: "NA", d: null as string | null, star: false };
    }
    const c = configs.find((x) => {
      const k = sweepCoord(x.settings);
      return k.spec === spec && k.think === think && k.ane === ane && k.kv === kv;
    });
    if (!c) return { cls: "text-muted-foreground", t: "–", d: null, star: false };
    if (c.median == null) {
      // In the grid but not measured: untested (–) or planned/pending (✓).
      return c.tested === false
        ? { cls: "text-muted-foreground", t: "–", d: null, star: false }
        : { cls: "text-muted-foreground", t: "✓", d: null, star: false };
    }
    const delta = c.id === "vanilla" || !base?.median ? null : ((c.median - base.median) / base.median) * 100;
    const star = c.id === recommended;
    return {
      cls: star ? "bg-primary/10 text-primary" : "",
      t: c.median.toFixed(1),
      d: delta == null ? "baseline" : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(0)}%`,
      star,
    };
  };

  return (
    <div className="flex flex-col gap-4">
      {KV_STATES.map((kv) => (
        <div key={kv}>
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">KV-quant: {kv}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">Speculative</TableHead>
                {headers}
              </TableRow>
            </TableHeader>
            <TableBody>
              {SPEC_ROWS.map(([spec, label]) => (
                <TableRow key={spec}>
                  <TableCell className="text-muted-foreground">{label}</TableCell>
                  {COL_AXES.map(([think, ane]) => {
                    const cell = cellFor(spec, think, ane, kv);
                    return (
                      <TableCell key={`${think}-${ane}`} className={cn("text-center tabular-nums", cell.cls)}>
                        {cell.star && <span className="mr-1 text-primary">★</span>}
                        <span className="font-medium">{cell.t}</span>
                        {cell.d && <div className="text-[10px] text-muted-foreground">{cell.d}</div>}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </div>
  );
}

type Status = string;

const OK = new Set(["ok", "ready", "completed", "done", "up"]);
const ACTIVE = new Set(["running", "active", "starting"]);
const WARN = new Set(["prepared", "warn"]);
const ERR = new Set(["failed", "missing", "down", "error"]);
const SETUP = new Set(["setup", "needs-setup"]);

export function StatusBadge({ status, children }: { status: Status; children?: React.ReactNode }) {
  // "Needs setup" gets a warm amber treatment so it reads as an action item,
  // distinct from both healthy (default) and failed (destructive).
  if (SETUP.has(status)) {
    return (
      <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
        {children ?? "needs setup"}
      </Badge>
    );
  }
  const variant = ERR.has(status) ? "destructive" : OK.has(status) ? "default" : ACTIVE.has(status) || WARN.has(status) ? "secondary" : "outline";
  return <Badge variant={variant}>{children ?? status}</Badge>;
}

export function BackendBadge({ backend }: { backend: string }) {
  return <Badge variant="outline">{backendLabel(backend)}</Badge>;
}

export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 p-4">
        <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
        <div className="text-2xl leading-none font-medium text-foreground">{value}</div>
        {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}

// Compact summary card for the dashboard machine/backends row:
// header = name + meta (version), stat below. Deliberately one line tall.
export function SummaryCard({
  name,
  meta,
  value,
  unit,
}: {
  name: React.ReactNode;
  meta?: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-sm font-medium text-foreground">{name}</div>
          {meta ? <div className="text-xs text-muted-foreground">{meta}</div> : null}
        </div>
        <div className="flex items-baseline gap-1.5">
          <div className="text-2xl leading-none font-medium tabular-nums text-foreground">{value}</div>
          {unit ? <div className="text-xs text-muted-foreground">{unit}</div> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function SectionTitle({ title, meta, action }: { title: string; meta?: string; action?: React.ReactNode }) {
  return (
    <div className="mt-8 mb-3 flex items-baseline gap-3 first:mt-0">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="h-px flex-1 bg-border" />
      {meta ? <div className="text-xs text-muted-foreground">{meta}</div> : null}
      {action}
    </div>
  );
}

export function CapabilityBadges({ caps }: { caps: Record<string, unknown> }) {
  const items: string[] = [];
  if (caps.thinking) items.push("Reasoning");
  if (caps.vision) items.push("Vision");
  if (caps.mtp) items.push("MTP");
  if (caps.tools) items.push("Tools");
  if (caps.imatrix) items.push("iMatrix");
  if (caps.qat) items.push("QAT");
  if (typeof caps.quant === "string") items.push(caps.quant);
  if (items.length === 0) items.push("chat");
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((i) => (
        <Badge key={i} variant="secondary">
          {i}
        </Badge>
      ))}
    </span>
  );
}

// The autotune results table — one component, used by both the dashboard
// (recent) and the /autotune section (all models).
export function AutotuneTable({ autotune, navigate, limit }: { autotune?: AutotuneRun[]; navigate: Navigate; limit?: number }) {
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Recommended</TableHead>
              <TableHead className="text-right">Median tps</TableHead>
              <TableHead className="text-right">vs vanilla</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(autotune ?? []).slice(0, limit).map((a) => {
              const rec = a.configs.find((c) => c.id === a.recommended);
              const base = a.configs.find((c) => c.id === "vanilla");
              const delta = rec && base && rec.id !== "vanilla" ? ((rec.median - base.median) / base.median) * 100 : null;
              return (
                <TableRow key={a.modelId}>
                  <TableCell className="font-medium text-foreground">{a.modelId}</TableCell>
                  <TableCell>
                    <StatusBadge status="ok">{rec?.label}</StatusBadge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtTps(rec?.median)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {delta == null ? (
                      "baseline"
                    ) : (
                      <span className={delta >= 0 ? "text-foreground" : "text-destructive"}>
                        {delta >= 0 ? "+" : ""}
                        {delta.toFixed(0)}%
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => navigate("model", { modelId: a.profileId, tab: "autotune" })}>
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// The green activity spinner — used wherever a job is running (sidebar,
// jobs page, live sweep). One definition.
export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden
      className={cn("size-3.5 animate-spin text-green-600 dark:text-green-400", className)}
    />
  );
}

// One run card, ported from the gallery's workbench: preview, mode-aware
// primary identity, model/harness/backend pills, state label + date.
// `mode` mirrors the workbench view: "model" groups name the prompt on the
// card, "benchmark" groups name the model.
export function RunCard({ run, onClick, mode }: { run: Run; onClick?: () => void; mode?: "model" | "benchmark" }) {
  const state = runCardState(run);
  const message = runCardMediaMessage(run);
  const id = runCardIdentity(run, mode ?? "model");
  return (
    <Card className="cursor-pointer overflow-hidden transition-colors hover:border-foreground/20" onClick={onClick}>
      <div className="relative aspect-[16/10] overflow-hidden bg-muted">
        {run.preview ? (
          <img src={run.preview} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center px-2 text-center text-xs text-muted-foreground">
            {message}
          </div>
        )}
      </div>
      <CardContent className="flex flex-col gap-1.5 p-3">
        <div className="truncate text-[13px] leading-tight font-medium text-foreground">{id.primary}</div>
        <div className="flex flex-wrap gap-1 overflow-hidden text-xs">
          {mode !== "benchmark" && run.model && <Badge variant="outline" className="max-w-full truncate">{run.model}</Badge>}
          {run.harness && <Badge variant="secondary">{run.harness}</Badge>}
          {run.backend && <BackendBadge backend={run.backend} />}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <StatusBadge status={state.status}>{state.label}</StatusBadge>
            {run.ds && <Badge variant="secondary">score {run.ds.scorecard.pct}%</Badge>}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{fmtDateShort(run.updatedAt ?? run.createdAt)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
