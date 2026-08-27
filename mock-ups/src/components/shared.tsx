// Thin presentational helpers built entirely on shadcn primitives.
// These exist only to DRY up repeated shadcn usage across views — no
// hand-rolled UI, no custom colors. Every visual is a shadcn component
// using its default variants.

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { backendLabel } from "@/lib/format";
import type { Run } from "@/data/types";

type Status = string;

const OK = new Set(["ok", "ready", "completed", "done", "up"]);
const ACTIVE = new Set(["running", "active", "starting"]);
const WARN = new Set(["prepared", "warn"]);
const ERR = new Set(["failed", "missing", "down", "error"]);

export function StatusBadge({ status, children }: { status: Status; children?: React.ReactNode }) {
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

export function SectionTitle({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="mt-8 mb-3 flex items-baseline gap-3 first:mt-0">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="h-px flex-1 bg-border" />
      {meta ? <div className="text-xs text-muted-foreground">{meta}</div> : null}
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
