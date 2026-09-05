// The model's autotune tab. Two states, one page:
//
//  • Sweep running → the page IS the live view: progress + the animated
//    matrix (spinner on the config being measured, tps as configs land).
//    Previous results collapse to a one-liner — the running sweep owns
//    the page until it finishes.
//  • Idle → the recommendation (reasoning + the settings it puts on the
//    server) → the config-space matrix → per-config numbers → clickable
//    sweep history (each row is a job; it opens the job's log).

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { api } from "@/api";
import { fmtDate, fmtPct, fmtTps, backendLabel } from "@/lib/format";
import { ClickableRow, SectionTitle, Spinner, StatusBadge, SweepMatrix, type SweepConfig } from "@/components/shared";
import { useJobsLive } from "@/hooks/use-jobs";
import type { Navigate } from "@/App";
import type { AutotuneRun, Profile } from "@/data/types";

// The autotune job's metrics shape (executors fill it as the sweep runs).
interface SweepMetrics {
  runDir: string;
  modelId: string;
  total: number;
  done: number;
  plan: SweepConfig[];
  results: { configId: string; summary: { median: number | null; mad: number; mtp?: { acceptPct: number } | null } }[];
  recommendation?: { configId: string; label: string; reasoning: string; noChange?: boolean } | null;
  applied?: boolean;
}

/** Merge the plan grid with measured results → one matrix at any moment. */
function liveConfigs(m: SweepMetrics): SweepConfig[] {
  return (m.plan ?? []).map((p) => ({
    ...p,
    median: m.results?.find((r) => r.configId === p.id)?.summary.median ?? null,
  }));
}

/** The config the sweep is measuring right now: the first planned one
 *  without a result (the sweep walks the plan in order). */
function runningConfigId(m: SweepMetrics | undefined): string | null {
  return (
    m?.plan?.find((p) => p.tested !== false && !m.results?.some((r) => r.configId === p.id))?.id ?? null
  );
}

function LiveSweep({ modelRef, navigate }: { modelRef: string; navigate: Navigate }) {
  const { jobs } = useJobsLive();
  const active = (jobs ?? []).find(
    (j) => j.type === "autotune" && j.ref === modelRef && (j.status === "queued" || j.status === "running")
  );
  const metrics = active?.metrics as unknown as SweepMetrics | undefined;

  const cancel = async () => {
    try {
      await api.cancelJob(active!.id);
      toast("Cancelling — finishes the current config, then restores your settings");
    } catch (err) {
      toast((err as Error).message);
    }
  };

  if (!active) return null;
  return (
    <div>
      <SectionTitle
        title="Sweep in progress"
        meta={active.status === "queued" ? "queued" : `${metrics?.done ?? 0}/${metrics?.total ?? "?"} configs`}
        action={
          <Button variant="outline" size="sm" onClick={() => navigate("jobs", { jobId: active.id })}>
            Job log
          </Button>
        }
      />
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <div className="flex items-center gap-3">
            {active.progress != null ? (
              <Progress value={active.progress} className="flex-1" />
            ) : (
              <Spinner className="size-4" />
            )}
            <span className="shrink-0 text-xs text-muted-foreground">{active.message ?? "working"}</span>
            {active.status === "running" && (
              <Button variant="destructive" size="sm" onClick={cancel}>
                Cancel
              </Button>
            )}
          </div>
          {metrics?.plan?.length ? (
            <SweepMatrix
              configs={liveConfigs(metrics)}
              activeId={runningConfigId(metrics)}
              recommended={metrics.recommendation?.configId ?? null}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Probing the server and building the config grid…</p>
          )}
          <p className="text-xs text-muted-foreground">
            ⟳ measuring · … queued · – compatible, not measured · NA not possible. Each config is a cold load + warm
            runs with unload + RAM-gate bookends; your settings are restored at the end.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** One line about the previous result while a new sweep owns the page. */
function PreviousSweepLine({ run }: { run: AutotuneRun | null }) {
  if (!run) return null;
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      Previous sweep ({fmtDate(run.recommendedAt)}): {run.noChange ? "kept current settings" : run.recommended} —
      results return when this sweep finishes.
    </p>
  );
}

export function ModelAutotune({
  backend,
  run: a,
  profile,
  modelRef,
  navigate,
}: {
  backend: string;
  run: AutotuneRun | null;
  profile?: Profile;
  modelRef: string;
  navigate: Navigate;
}) {
  const { jobs } = useJobsLive();
  // Finished sweeps only — the running one owns the page via LiveSweep.
  const history = (jobs ?? []).filter(
    (j) => j.type === "autotune" && j.ref === modelRef && !["queued", "running"].includes(j.status)
  );
  const active = (jobs ?? []).some(
    (j) => j.type === "autotune" && j.ref === modelRef && (j.status === "queued" || j.status === "running")
  );

  // Poll the recommendation while a sweep runs so the finished result lands
  // without a manual refresh.
  const { data: live } = useQuery({
    queryKey: ["autotune", modelRef],
    queryFn: () => api.autotune(modelRef),
    refetchInterval: active ? 5000 : false,
    enabled: backend === "omlx",
  });
  const run = live ?? a;

  if (backend !== "omlx") {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Autotune drives the oMLX admin API — this model runs on {backendLabel(backend)}.
        </CardContent>
      </Card>
    );
  }

  const rec = run?.configs.find((c) => c.id === run.recommended);
  const base = run?.configs.find((c) => c.id === "vanilla");

  // ── live: the running sweep owns the page ────────────────────────────────
  if (active) {
    return (
      <div>
        <LiveSweep modelRef={modelRef} navigate={navigate} />
        <PreviousSweepLine run={run} />
      </div>
    );
  }

  // ── idle ─────────────────────────────────────────────────────────────────
  return (
    <div>
      {!run ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10">
            <p className="text-sm text-muted-foreground">No sweep for this model yet.</p>
            {profile && (
              <Button onClick={() => navigate("autotuneNew", { modelId: modelRef })}>◉ New sweep</Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <SectionTitle
            title="Recommendation"
            meta={run.noChange ? "keep current settings" : fmtDate(run.recommendedAt)}
            action={
              profile ? (
                <Button variant="outline" size="sm" onClick={() => navigate("autotuneNew", { modelId: modelRef })}>
                  ◉ New sweep
                </Button>
              ) : undefined
            }
          />
          <Card>
            <CardContent className="flex flex-col gap-4 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={run.noChange ? "warn" : "ok"}>
                  {run.noChange ? "nothing beat your settings" : rec?.label}
                </StatusBadge>
                {run.dflashDraft && <StatusBadge status="active">{run.dflashDraft} draft</StatusBadge>}
              </div>
              <p className="max-w-3xl text-sm text-muted-foreground">{run.reasoning}</p>
              {rec && (
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                  {Object.entries(rec.settings).map(([k, v]) => (
                    <span key={k} className="text-muted-foreground">
                      {k}: <span className="tabular-nums text-foreground">{String(v)}</span>
                    </span>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <SectionTitle title="Result matrix" meta="the full config space" />
          <Card>
            <CardContent className="p-4">
              <SweepMatrix configs={run.configs} recommended={run.recommended} />
              <p className="mt-2 text-xs text-muted-foreground">– compatible, not measured · NA not possible · ★ recommended</p>
            </CardContent>
          </Card>

          <SectionTitle title="Per-config results" meta="median tps across warm runs" />
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Config</TableHead>
                    <TableHead>Path</TableHead>
                    <TableHead className="text-right">Median tps</TableHead>
                    <TableHead className="text-right">MAD</TableHead>
                    <TableHead className="text-right">Accept</TableHead>
                    <TableHead className="text-right">vs vanilla</TableHead>
                    <TableHead className="text-right">Pick</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {run.configs.map((c) => {
                    const isThink = c.id === "thinking" || c.id === "mtp-thinking";
                    const delta = c.id === "vanilla" || !base ? null : ((c.median - base.median) / base.median) * 100;
                    return (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium text-foreground">{c.label}</TableCell>
                        <TableCell>
                          <StatusBadge status={isThink ? "warn" : "ok"}>{isThink ? "beauty" : "fast"}</StatusBadge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtTps(c.median)}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.mad.toFixed(2)}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.accept ? fmtPct(c.accept) : "—"}</TableCell>
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
                        <TableCell className="text-right">{c.id === run.recommended ? <span className="text-primary">★</span> : ""}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <p className="px-4 py-2 text-xs text-muted-foreground">
                ≈ a difference is "real" when it's ≥ 2× the within-config noise (MAD). ★ = recommended.
              </p>
            </CardContent>
          </Card>
        </>
      )}

      {history.length > 0 && (
        <>
          <SectionTitle title="Sweep history" meta="each row opens the job's log" />
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableBody>
                  {history.map((j) => (
                    <ClickableRow key={j.id} onClick={() => navigate("jobs", { jobId: j.id })}>
                      <TableCell className="font-medium text-foreground">{j.title}</TableCell>
                      <TableCell>
                        <StatusBadge status={j.status} />
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{fmtDate(j.createdAt)}</TableCell>
                    </ClickableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}