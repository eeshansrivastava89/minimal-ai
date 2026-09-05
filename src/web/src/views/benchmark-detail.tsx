// Run detail — the cross-model record's per-run page. Reachable from the
// model page (live models) and /benchmarks (historical). Media is served by
// the hub with HTTP range; actions enqueue real jobs (capture/score).

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { api, type RunRef } from "@/api";
import { fmtDate, fmtDur, fmtPct } from "@/lib/format";
import { SectionTitle, StatCard, StatusBadge } from "@/components/shared";
import type { Navigate } from "@/App";

export function BenchmarkDetail({ run, navigate }: { run: RunRef; navigate: Navigate }) {
  const queryClient = useQueryClient();
  const { data: runs, isLoading } = useQuery({ queryKey: ["runs"], queryFn: api.runs, staleTime: 30_000 });
  const { data: benchmarks } = useQuery({ queryKey: ["benchmarks"], queryFn: api.benchmarks, staleTime: 300_000 });
  const { data: modelsData } = useQuery({ queryKey: ["models"], queryFn: api.models, staleTime: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const r = (runs ?? []).find((x) => x.id === run.runId && x.bench === run.bench && x.slug === run.slug);
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (!r) {
    return (
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">No run "{run.runId}".</p>
      </div>
    );
  }

  const b = (benchmarks ?? []).find((x) => x.id === r.bench);
  const owner = modelsData?.models.find((m) => m.ref === r.ownerRef);
  const mediaUrl = (file: string) => `/api/media/run/${r.bench}/${r.slug}/${r.id}/${file}`;

  const enqueue = async (name: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(name);
    try {
      await fn();
      toast(done);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setBusy("delete");
    try {
      await api.deleteRun(run);
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["modelRuns"] });
      toast("Run deleted");
      navigate("benchmarks");
    } catch (err) {
      toast((err as Error).message);
      setBusy(null);
    }
  };

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">{r.benchTitle}</h1>
        {owner ? (
          <button
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            onClick={() => navigate("model", { modelId: r.ownerRef ?? "", tab: "benchmark" })}
          >
            {r.modelDisplay ?? r.model}
          </button>
        ) : (
          <span className="text-sm text-muted-foreground">
            {r.modelDisplay ?? r.model}
            <span className="ml-2 text-xs text-muted-foreground/70">(no longer on this machine)</span>
          </span>
        )}
      </div>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{b?.description}</p>

      {/* Controls first — media and detail tables follow. */}
      <div className="mt-4 flex flex-wrap gap-2">
        {owner && (
          <Button variant="outline" onClick={() => navigate("model", { modelId: r.ownerRef ?? "", tab: "benchmark" })}>
            ← Back to {owner.title}
          </Button>
        )}
        {r.kind !== "data-science" && (
          <>
            <Button variant="outline" onClick={() => window.open(mediaUrl("index.html"), "_blank")}>
              Open index.html
            </Button>
            <Button
              variant="outline"
              disabled={busy === "capture"}
              onClick={() => enqueue("capture", () => api.runCapture(run, true), "Recapture queued — watch it in Jobs")}
            >
              Recapture media
            </Button>
          </>
        )}
        {b?.prompt && (
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(b.prompt);
              toast("Prompt copied");
            }}
          >
            Copy prompt
          </Button>
        )}
        {r.kind === "data-science" && (
          <Button
            variant="outline"
            disabled={busy === "score"}
            onClick={() => enqueue("score", () => api.runScore(run), "Scoring queued — watch it in Jobs")}
          >
            Score run
          </Button>
        )}
        <Button variant="destructive" disabled={busy === "delete"} onClick={() => setConfirmDelete(true)}>
          Delete run
        </Button>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete run?</DialogTitle>
            <DialogDescription>
              Removes the whole run folder from disk — metadata, prompt, HTML, preview, and raw responses. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={remove}>
              Delete folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="mt-4 overflow-hidden">
        <CardContent className="p-0">
          {r.video ? (
            <video src={r.video} controls autoPlay muted loop playsInline preload="auto" poster={r.preview ?? undefined} className="mx-auto max-h-[65vh] w-full bg-black object-contain" />
          ) : r.preview ? (
            <img src={r.preview} alt="" loading="lazy" className="w-full" />
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
    </div>
  );
}