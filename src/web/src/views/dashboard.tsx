import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/api";
import { fmtCtx, fmtRelative } from "@/lib/format";
import { AutotuneTable, SummaryCard, StatusBadge, BackendBadge, SectionTitle, RunCard } from "@/components/shared";
import type { Navigate } from "@/App";

export function Dashboard({ navigate }: { navigate: Navigate }) {
  const { data: machine } = useQuery({ queryKey: ["machine"], queryFn: api.machine, staleTime: 60_000 });
  const { data: modelsData } = useQuery({ queryKey: ["models"], queryFn: api.models, staleTime: 30_000 });
  const { data: runs } = useQuery({ queryKey: ["runs"], queryFn: api.runs, staleTime: 30_000 });
  const { data: autotune } = useQuery({ queryKey: ["autotune"], queryFn: api.allAutotune, staleTime: 60_000 });

  const backends = modelsData?.backends ?? [];
  const profiles = modelsData?.profiles ?? [];
  const backend = (id: string) => backends.find((b) => b.id === id);
  const countFor = (id: string) => modelsData?.models.filter((m) => m.backend === id).length ?? 0;
  // Quick launch = saved profiles, most recently used first.
  const recentProfiles = [...profiles].sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
  const recentRuns = (runs ?? []).slice(0, 6);

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Dashboard</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        One surface for your local models — <strong className="text-foreground">{profiles.length} profiles</strong> across
        three backends, all on this machine. Nothing leaves it.
      </p>

      <div className="mt-6 grid grid-cols-4 gap-3">
        <SummaryCard
          name="Machine"
          meta={machine?.chip ?? "…"}
          value={machine?.ramLabel ?? "…"}
          unit="unified memory"
        />
        {(["omlx", "ollama", "llama-cpp"] as const).map((id) => {
          const b = backend(id);
          const n = countFor(id);
          return (
            <SummaryCard
              key={id}
              name={b?.label ?? id}
              meta={b?.up ? b.version ?? "running" : "not running"}
              value={b?.up || n > 0 ? n : "—"}
              unit={n === 1 ? "model" : "models"}
            />
          );
        })}
      </div>

      <SectionTitle
        title="Quick launch"
        meta="opens Terminal/iTerm with the command"
        action={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => navigate("models")}>
            All models
          </Button>
        }
      />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Backend</TableHead>
                <TableHead className="text-right">Context</TableHead>
                <TableHead>Thinking</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentProfiles.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="font-medium text-foreground">{p.label}</div>
                    <div className="text-xs text-muted-foreground">{p.modelAlias}</div>
                  </TableCell>
                  <TableCell>
                    <BackendBadge backend={p.backend} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtCtx((p.capabilities?.contextLength ?? p.capabilities?.ctxSize) as number | undefined)}
                  </TableCell>
                  <TableCell>
                    {p.thinkingOff ? (
                      <StatusBadge status="down">off</StatusBadge>
                    ) : (
                      <StatusBadge status="ok">{p.thinkingLevel ?? "default"}</StatusBadge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtRelative(p.lastUsedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" onClick={() => navigate("model", { modelId: p.id })}>
                      Run
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SectionTitle
        title="Recent benchmark runs"
        action={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => navigate("benchmarks")}>
            All benchmarks
          </Button>
        }
      />
      {recentRuns.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No benchmark runs yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {recentRuns.map((r) => (
            <RunCard
              key={r.id}
              run={r}
              onClick={() => navigate("benchmarkRun", { runId: r.id, bench: r.bench, slug: r.slug ?? "" })}
            />
          ))}
        </div>
      )}

      <SectionTitle
        title="Recent autotune"
        action={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => navigate("autotune")}>
            All autotune results
          </Button>
        }
      />
      <AutotuneTable autotune={autotune} navigate={navigate} />
    </div>
  );
}
