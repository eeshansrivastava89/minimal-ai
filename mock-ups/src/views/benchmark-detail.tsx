import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HUB_DATA } from "@/data/data";
import { RUNS } from "@/data/runs";
import { fmtDate, fmtDur, fmtPct } from "@/lib/format";
import { profileForRun } from "@/lib/lookup";
import { SectionTitle, StatCard, StatusBadge } from "@/components/shared";
import type { Navigate } from "@/App";

export function BenchmarkDetail({ runId, modelId, navigate }: { runId: string; modelId?: string; navigate: Navigate }) {
  const r = RUNS.find((x) => x.id === runId);
  if (!r) {
    return (
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">No run "{runId}".</p>
      </div>
    );
  }

  const b = HUB_DATA.benchmarks.find((x) => x.id === r.bench);
  const owner = (modelId && HUB_DATA.profiles.find((p) => p.id === modelId)) || profileForRun(r);

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">{r.benchTitle}</h1>
        {owner ? (
          <button
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={() => navigate("model", { modelId: owner.id, tab: "benchmark" })}
          >
            {r.modelDisplay ?? r.model}
          </button>
        ) : (
          <span className="text-sm text-muted-foreground">{r.modelDisplay ?? r.model}</span>
        )}
      </div>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{b?.description}</p>

      <Card className="mt-4 overflow-hidden">
        <CardContent className="p-0">
          {r.preview ? (
            <img src={r.preview} alt="" className="w-full" />
          ) : (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              {r.kind === "data-science" ? "Data-science run — notebook + charts, no visual preview." : "No preview captured for this run."}
            </div>
          )}
        </CardContent>
      </Card>

      {r.ds && (
        <>
          <SectionTitle title="Scorecard" meta={`${r.ds.scorecard.earned}/${r.ds.scorecard.total} · ${r.ds.scorecard.pct}%`} />
          <Card>
            <CardContent className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap gap-2">
                {r.ds.summary.recommendedVariant && (
                  <StatusBadge status="ok">Recommended: Variant {r.ds.summary.recommendedVariant}</StatusBadge>
                )}
                {r.ds.summary.status && <StatusBadge status="warn">{r.ds.summary.status}</StatusBadge>}
              </div>
              {r.ds.summary.decision && <p className="text-sm text-muted-foreground">{r.ds.summary.decision}</p>}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Check</TableHead>
                    <TableHead className="text-right">Earned</TableHead>
                    <TableHead className="text-right">Max</TableHead>
                    <TableHead className="text-right">Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r.ds.scorecard.checks.map((c) => (
                    <TableRow key={c.label}>
                      <TableCell>
                        <div className="text-foreground">{c.label}</div>
                        {c.detail && <div className="text-xs text-muted-foreground">{c.detail}</div>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{c.earned}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.max}</TableCell>
                      <TableCell className="text-right">
                        <StatusBadge status={c.pass ? "ok" : "failed"}>{c.pass ? "pass" : "fail"}</StatusBadge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {r.ds.summary.metrics && r.ds.summary.metrics.length > 0 && (
                <>
                  <SectionTitle title="Metrics" />
                  <Table>
                    <TableBody>
                      {r.ds.summary.metrics.map((m) => (
                        <TableRow key={m.label}>
                          <TableCell className="w-56 text-muted-foreground">{m.label}</TableCell>
                          <TableCell className="tabular-nums text-foreground">
                            {m.value}
                            {m.delta && <span className="text-muted-foreground"> ({m.delta})</span>}
                            {m.context && <span className="text-muted-foreground"> · {m.context}</span>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <div className="mt-4 grid grid-cols-4 gap-3">
        <StatCard label="Status" value={r.status} />
        <StatCard label="Render fps" value={r.fps ?? "—"} sub={r.minFps != null ? `min ${r.minFps} · ${r.frames} frames` : undefined} />
        <StatCard label="Wall clock" value={fmtDur(r.wallMs)} sub={r.turns != null ? `${r.turns} agent turns` : undefined} />
        <StatCard
          label="Tokens"
          value={r.totalTok ? `${(r.totalTok / 1e6).toFixed(2)}M` : "—"}
          sub={r.tokReported ? `${r.promptTok?.toLocaleString()} in / ${r.compTok?.toLocaleString()} out` : "not reported"}
        />
      </div>

      <SectionTitle title="Runner" />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {[
                ["Model", r.model],
                ["Backend", r.backend ? `${r.backend} (${r.source})` : "—"],
                ["Harness", r.harness],
                ["Created", fmtDate(r.createdAt)],
                ["Completed", fmtDate(r.completedAt)],
                ["Prefill", r.prefill != null ? `${r.prefill.toFixed(1)} tok/s` : "—"],
                ["Generation", r.gen != null ? `${r.gen.toFixed(1)} tok/s` : "—"],
                ["TTFT", r.ttft != null ? `${r.ttft.toFixed(0)} ms` : "—"],
                ["Spec accept", r.specAccept != null ? fmtPct(r.specAccept) : "—"],
              ].map(([k, v]) => (
                <TableRow key={String(k)}>
                  <TableCell className="w-56 text-muted-foreground">{k}</TableCell>
                  <TableCell className="text-foreground">{v}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SectionTitle title="Prompt" />
      <Card>
        <CardContent className="p-4">
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{b?.prompt}</p>
        </CardContent>
      </Card>

      <div className="mt-4 flex gap-2">
        {owner && (
          <Button variant="outline" onClick={() => navigate("model", { modelId: owner.id, tab: "benchmark" })}>
            ← Back to {owner.label}
          </Button>
        )}
        <Button variant="outline">Open index.html</Button>
        <Button variant="outline">Recapture media</Button>
        <Button variant="destructive">Delete run</Button>
      </div>
    </div>
  );
}
