// Thin presentational helpers built entirely on shadcn primitives.
// These exist only to DRY up repeated shadcn usage across views — no
// hand-rolled UI, no custom colors. Every visual is a shadcn component
// using its default variants.

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { backendLabel, fmtTps } from "@/lib/format";
import type { AutotuneRun, Run } from "@/data/types";
import type { Navigate } from "@/App";

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

export function RunCard({ run, onClick }: { run: Run; onClick?: () => void }) {
  return (
    <Card className="cursor-pointer overflow-hidden transition-colors hover:border-foreground/20" onClick={onClick}>
      <div className="relative aspect-[16/10] overflow-hidden bg-muted">
        {run.preview ? (
          <img src={run.preview} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {run.ds ? `score ${run.ds.scorecard.pct}%` : "no preview"}
          </div>
        )}
        {run.fps != null && (
          <div className="absolute right-2 top-2 rounded border border-border bg-background/80 px-1.5 py-0.5 text-[10px] text-foreground">
            {run.fps} fps
          </div>
        )}
      </div>
      <CardContent className="flex flex-col gap-1.5 p-3">
        <div className="text-[13px] leading-tight font-medium text-foreground">{run.benchTitle}</div>
        <div className="truncate text-xs text-muted-foreground">{run.modelDisplay ?? run.model}</div>
        <div className="flex flex-wrap gap-1">
          {run.backend && <BackendBadge backend={run.backend} />}
          {run.ds && <StatusBadge status="ok">score {run.ds.scorecard.pct}%</StatusBadge>}
          <StatusBadge status={run.status} />
        </div>
      </CardContent>
    </Card>
  );
}
