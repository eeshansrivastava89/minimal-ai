import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/api";
import { toast } from "sonner";
import { fmtBytes, fmtCtx } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useJobsLive } from "@/hooks/use-jobs";
import { CapabilityBadges, ClickableRow, SectionTitle, StatusBadge } from "@/components/shared";
import { DownloadDialog } from "@/components/flows";
import type { Navigate } from "@/App";
import type { ModelSummary } from "@/data/types";

// One fixed column layout for every backend table — auto-layout would size
// each table independently and the columns would drift apart per bucket.
const COLS = (
  <colgroup>
    <col className="w-[38%]" />
    <col className="w-[12%]" />
    <col className="w-[12%]" />
    <col className="w-[26%]" />
    <col className="w-[12%]" />
  </colgroup>
);

// Start = the hub-owned lifecycle: job brings the server up, loads the
// model, preflights it — then the model page shows the API + pi command.
function StartButton({ ref, label }: { ref: string; label: string }) {
  const queryClient = useQueryClient();
  const { jobs } = useJobsLive();
  const pending = (jobs ?? []).some(
    (j) => j.type === "start" && j.ref === ref && (j.status === "queued" || j.status === "running")
  );
  const start = async (e: React.MouseEvent) => {
    e.stopPropagation(); // the row navigates — the button starts
    try {
      await api.startModel(ref);
      toast(`Starting ${label} — watch it in Jobs`);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    } catch (err) {
      toast((err as Error).message);
    }
  };
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={start}>
      {pending ? "Starting…" : "Start"}
    </Button>
  );
}

// A model is running when its backend reports it loaded — hub jobs and
// copy-pasted pi sessions alike.
function StopButton({ ref, label }: { ref: string; label: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const stop = async (e: React.MouseEvent) => {
    e.stopPropagation(); // the row navigates — the button stops
    if (!window.confirm(`Stop ${label}? Any active session using it will end.`)) return;
    setBusy(true);
    try {
      const r = await api.stopModel(ref);
      toast(r.stopped ? r.message : `Could not stop: ${r.message}`);
      await queryClient.invalidateQueries({ queryKey: ["models"] });
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" variant="destructive" disabled={busy} onClick={stop}>
      {busy ? "Stopping…" : "Stop"}
    </Button>
  );
}

function ModelTable({ rows, running, navigate }: { rows: ModelSummary[]; running: (m: ModelSummary) => boolean; navigate: Navigate }) {
  return (
    <Card>
      <CardContent className="p-0">
        <Table className="table-fixed">
          {COLS}
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Context</TableHead>
              <TableHead>Capabilities</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const isRunning = running(r);
              const isSidekick = r.status === "draft" || r.status === "helper";
              return (
              <ClickableRow
                key={r.ref}
                className={cn(
                  isRunning && "bg-green-500/5 ring-1 ring-green-500/30 ring-inset shadow-[0_0_16px_-6px_theme(colors.green.500)]",
                  isSidekick && "[&_td]:text-muted-foreground/70 [&_.font-medium]:italic"
                )}
                // Row click replaces the old Open/Set up buttons: ready models
                // open their page, un-setup models go straight to setup.
                onClick={() =>
                  r.status === "setup"
                    ? navigate("setupNew", { modelId: r.ref, tab: r.backend })
                    : navigate("model", { modelId: r.ref })
                }
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1 truncate font-medium text-foreground" title={r.title}>{r.title}</div>
                    {isRunning ? (
                      <StopButton ref={r.ref} label={r.title} />
                    ) : r.status === "ready" ? (
                      <StartButton ref={r.ref} label={r.title} />
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.sizeBytes ? fmtBytes(r.sizeBytes) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtCtx(r.contextLength)}</TableCell>
                <TableCell>
                  {isSidekick ? "—" : <CapabilityBadges caps={r.capabilities} />}
                </TableCell>
                <TableCell>
                  {isRunning ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/15 px-2.5 py-0.5 text-xs font-medium text-green-600 ring-1 ring-green-500/40 dark:text-green-400">
                      <span className="size-1.5 animate-pulse rounded-full bg-green-500" />
                      running
                    </span>
                  ) : r.status === "ready" ? (
                    <StatusBadge status="ok">ready</StatusBadge>
                  ) : r.status === "setup" ? (
                    <StatusBadge status="needs-setup">needs setup</StatusBadge>
                  ) : r.status === "draft" ? (
                    <StatusBadge status="active">draft</StatusBadge>
                  ) : (
                    <StatusBadge status="warn">helper</StatusBadge>
                  )}
                </TableCell>
              </ClickableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function Models({ navigate }: { navigate: Navigate }) {
  const { data, isLoading, error } = useQuery({ queryKey: ["models"], queryFn: api.models });

  if (error) {
    return (
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Models</h1>
        <Card className="mt-4">
          <CardContent className="py-8 text-center text-sm text-destructive">
            Hub API unreachable — is `npm run hub` (or the dev proxy) up? {error.message}
          </CardContent>
        </Card>
      </div>
    );
  }

  const backends = data?.backends ?? [];
  const metaFor = (id: string, n: number) => {
    const b = backends.find((x) => x.id === id);
    return `${n} model${n === 1 ? "" : "s"} · ${b?.up ? b.version ?? "running" : "not running"}`;
  };
  // Running = the backend reports this exact model id loaded (llama.cpp's
  // server reports the profile alias, so that matches too).
  const runningFor = (backendId: string) => {
    const b = backends.find((x) => x.id === backendId);
    const ids = new Set(b?.runningModels ?? []);
    if (ids.size === 0) return () => false;
    const aliasFor = (m: ModelSummary) =>
      (data?.profiles ?? []).find((p) => p.id === m.profileId)?.modelAlias;
    return (m: ModelSummary) => ids.has(m.id) || (aliasFor(m) ? ids.has(aliasFor(m)!) : false);
  };
  // Every backend bucket sorts the same way: running models first, then
  // recency of use, then the rest — drafters and helpers sink.
  const lastUsedAt = (m: ModelSummary) =>
    (data?.profiles ?? []).find((p) => p.id === m.profileId)?.lastUsedAt ?? "";
  const bucket = (id: string) => {
    const running = runningFor(id);
    const rank = (m: ModelSummary) =>
      running(m) ? 0 : m.status === "draft" || m.status === "helper" ? 2 : 1;
    return (data?.models ?? [])
      .filter((m) => m.backend === id)
      .sort((a, b) =>
        rank(a) - rank(b) ||
        lastUsedAt(b).localeCompare(lastUsedAt(a)) ||
        a.title.localeCompare(b.title)
      );
  };

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Models</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Every model this machine knows about, bucketed by backend. Models with a saved profile are
        ready to run; the rest need setup.
      </p>

      {(["omlx", "ollama", "llama-cpp"] as const).map((id) => {
        const rows = bucket(id);
        const label = backends.find((b) => b.id === id)?.label ?? id;
        // Fragment, not a wrapper div: SectionTitle's first:mt-0 spacing
        // keys on the DOM parent — only the page's first section skips mt-8.
        return (
          <Fragment key={id}>
            <SectionTitle title={label} meta={isLoading ? "…" : metaFor(id, rows.length)} />
            <ModelTable rows={rows} running={runningFor(id)} navigate={navigate} />
          </Fragment>
        );
      })}

      <div className="mt-4 flex gap-2">
        <DownloadDialog />
      </div>
    </div>
  );
}
