import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/api";
import { fmtBytes, fmtCtx } from "@/lib/format";
import { CapabilityBadges, SectionTitle, StatusBadge } from "@/components/shared";
import { DownloadDialog } from "@/components/flows";
import type { Navigate } from "@/App";
import type { ModelSummary } from "@/data/types";

function ModelTable({ rows, navigate }: { rows: ModelSummary[]; navigate: Navigate }) {
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Context</TableHead>
              <TableHead>Capabilities</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.ref}>
                <TableCell className="max-w-[280px]">
                  <div className="truncate font-medium text-foreground">{r.title}</div>
                  {r.subtitle ? (
                    <div className="truncate text-xs text-muted-foreground" title={r.subtitle}>{r.subtitle}</div>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.sizeBytes ? fmtBytes(r.sizeBytes) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtCtx(r.contextLength)}</TableCell>
                <TableCell>
                  {r.status === "draft" || r.status === "helper" ? "—" : <CapabilityBadges caps={r.capabilities} />}
                </TableCell>
                <TableCell>
                  {r.status === "ready" ? (
                    <StatusBadge status="ok">ready</StatusBadge>
                  ) : r.status === "setup" ? (
                    <StatusBadge status="needs-setup">needs setup</StatusBadge>
                  ) : r.status === "draft" ? (
                    <StatusBadge status="active">draft</StatusBadge>
                  ) : (
                    <StatusBadge status="warn">helper</StatusBadge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {r.status === "setup" ? (
                    <Button size="sm" variant="outline" onClick={() => navigate("setupNew", { modelId: r.ref, tab: r.backend })}>
                      Set up
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => navigate("model", { modelId: r.ref })}>
                      Open
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
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
  const bucket = (id: string) => (data?.models ?? []).filter((m) => m.backend === id);

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
            <ModelTable rows={rows} navigate={navigate} />
          </Fragment>
        );
      })}

      <div className="mt-4 flex gap-2">
        <DownloadDialog />
      </div>
    </div>
  );
}
