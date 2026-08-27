import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HUB_DATA } from "@/data/data";
import { RUNS } from "@/data/runs";
import { fmtBytes, fmtCtx, fmtTps } from "@/lib/format";
import { profileForRun } from "@/lib/lookup";
import { StatCard, StatusBadge, BackendBadge, SectionTitle, RunCard } from "@/components/shared";
import type { Navigate } from "@/App";

export function Dashboard({ navigate }: { navigate: Navigate }) {
  const o = HUB_DATA.omlxStatus as Record<string, unknown>;
  const omlxUp = o.status === "ok";
  const profiles = HUB_DATA.profiles;
  const recentRuns = RUNS.slice(0, 6);

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Dashboard</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        One surface for your local models — <strong className="text-foreground">{profiles.length} profiles</strong> across
        three backends, all on this machine. Nothing leaves it.
      </p>

      <SectionTitle title="Backends" />
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          label="oMLX"
          value={omlxUp ? String(o.version) : "down"}
          sub={omlxUp ? `${o.modelsLoaded} loaded · ${o.modelsDiscovered} discovered · ${fmtBytes(o.modelMemoryMax as number)} max` : "server not running"}
        />
        <StatCard
          label="Ollama"
          value={HUB_DATA.ollamaModels.length || "down"}
          sub={HUB_DATA.ollamaModels.length ? HUB_DATA.ollamaModels.map((m) => m.id).join(", ") : "server not running"}
        />
        <StatCard
          label="llama.cpp"
          value={HUB_DATA.ggufModels.length || "—"}
          sub={HUB_DATA.ggufModels.length ? "GGUF models scanned" : "no GGUF models scanned"}
        />
      </div>

      <div className="mt-3 grid grid-cols-4 gap-3">
        <StatCard label="Machine" value={HUB_DATA.hardware.chip} sub={`${HUB_DATA.hardware.ramLabel} · ${HUB_DATA.hardware.metal}`} />
        <StatCard label="Profiles" value={profiles.length} sub="saved model setups" />
        <StatCard label="Benchmark runs" value={RUNS.length} sub={`across ${HUB_DATA.benchmarks.length} prompts`} />
        <StatCard label="Autotune sweeps" value={HUB_DATA.autotune.length} sub="completed speed tunes" />
      </div>

      <SectionTitle title="Quick launch" meta="opens Terminal/iTerm with the command" />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Backend</TableHead>
                <TableHead className="text-right">Context</TableHead>
                <TableHead>Thinking</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="font-medium text-foreground">{p.label}</div>
                    <div className="text-xs text-muted-foreground">{p.modelAlias}</div>
                  </TableCell>
                  <TableCell>
                    <BackendBadge backend={p.backend} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtCtx((p.capabilities.contextLength ?? p.capabilities.ctxSize) as number | undefined)}
                  </TableCell>
                  <TableCell>
                    {p.thinkingOff ? (
                      <StatusBadge status="down">off</StatusBadge>
                    ) : (
                      <StatusBadge status="ok">{p.thinkingLevel ?? "default"}</StatusBadge>
                    )}
                  </TableCell>
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

      <SectionTitle title="Recent benchmark runs" />
      <div className="grid grid-cols-3 gap-3">
        {recentRuns.map((r) => (
          <RunCard
            key={r.id}
            run={r}
            onClick={() => navigate("benchmarkRun", { modelId: profileForRun(r)?.id, runId: r.id })}
          />
        ))}
      </div>

      <SectionTitle title="Recent autotune" />
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
              {HUB_DATA.autotune.map((a) => {
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
    </div>
  );
}
