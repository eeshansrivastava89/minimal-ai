// The benchmarks section — the cross-model record. Catalog as a single pill
// row (hover a pill for the detail card); runs grouped by benchmark OR by
// model — one at a time, never both. Historical models (runs whose model is
// no longer in the live catalog) stay grouped under their recorded identity
// and marked read-only; deleting a model never orphans its runs.

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { api, type RunRef } from "@/api";
import { RunCard, SectionTitle } from "@/components/shared";
import type { Navigate } from "@/App";
import type { Benchmark, Run } from "@/data/types";

const keyOf = (r: Run) => `${r.bench}/${r.slug}/${r.id}`;

export function Benchmarks({ navigate }: { navigate: Navigate }) {
  const queryClient = useQueryClient();
  const { data: benchmarks } = useQuery({ queryKey: ["benchmarks"], queryFn: api.benchmarks, staleTime: 300_000 });
  const { data: runs } = useQuery({ queryKey: ["runs"], queryFn: api.runs, staleTime: 30_000 });
  const { data: machine } = useQuery({ queryKey: ["machine"], queryFn: api.machine, staleTime: 60_000 });

  const [groupBy, setGroupBy] = useState<"benchmark" | "model">("benchmark");
  const [compareMode, setCompareMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);

  const benchTitle = (id: string) => (benchmarks ?? []).find((b) => b.id === id)?.title ?? id;
  const modelName = (r: Run) => r.modelDisplay ?? r.model ?? r.slug ?? "unknown";

  // Groups: benchmark → model → runs (the repo's own hierarchy) OR model →
  // runs, never both at once.
  const groups = useMemo(() => {
    const all = runs ?? [];
    if (groupBy === "model") {
      const models = new Map<string, { name: string; historical: boolean; runs: Run[] }>();
      for (const r of all) {
        const name = modelName(r);
        if (!models.has(name)) models.set(name, { name, historical: true, runs: [] });
        const m = models.get(name)!;
        m.runs.push(r);
        if (r.ownerRef) m.historical = false;
      }
      return [...models.values()].sort((a, b) => a.name.localeCompare(b.name)).map((m) => ({
        key: m.name,
        title: m.name,
        historical: m.historical,
        meta: `${m.runs.length} runs`,
        runs: m.runs,
      }));
    }
    const byBench = new Map<string, Run[]>();
    for (const r of all) {
      if (!byBench.has(r.bench)) byBench.set(r.bench, []);
      byBench.get(r.bench)!.push(r);
    }
    const ordered = [
      ...(benchmarks ?? []).map((b) => b.id),
      ...[...byBench.keys()].filter((id) => !(benchmarks ?? []).some((b) => b.id === id)),
    ];
    const out = [];
    for (const bench of ordered) {
      const benchRuns = byBench.get(bench) ?? [];
      if (benchRuns.length === 0) continue;
      const models = new Map<string, { name: string; historical: boolean; runs: Run[] }>();
      for (const r of benchRuns) {
        const name = modelName(r);
        if (!models.has(name)) models.set(name, { name, historical: true, runs: [] });
        const m = models.get(name)!;
        m.runs.push(r);
        if (r.ownerRef) m.historical = false;
      }
      for (const m of models.values()) {
        out.push({
          key: `${bench}/${m.name}`,
          title: `${benchTitle(bench)} · ${m.name}`,
          historical: m.historical,
          meta: `${m.runs.length} runs`,
          runs: m.runs,
        });
      }
    }
    return out;
  }, [groupBy, benchmarks, runs]);

  const toggle = (r: Run) => {
    const key = keyOf(r);
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const compare = async () => {
    const picked = (runs ?? []).filter((r) => selected.includes(keyOf(r)));
    const refs: RunRef[] = picked.map((r) => ({ bench: r.bench, slug: r.slug ?? "", runId: r.id }));
    try {
      await api.comparisonVideo(refs);
      toast("Comparison video queued — watch it in Jobs");
      setCompareMode(false);
      setSelected([]);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const publish = async () => {
    setPublishing(true);
    try {
      await api.publish();
      toast("Publish queued — snapshot, commit, push");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  const runCount = (id: string) => (runs ?? []).filter((r) => r.bench === id).length;

  return (
    <div>
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Benchmarks</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Every run ever produced — grouped by prompt or by model. Runs outlive their models.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {compareMode ? (
            <>
              <Button variant="outline" onClick={() => { setCompareMode(false); setSelected([]); }}>
                Cancel
              </Button>
              <Button disabled={selected.length < 2 || selected.length > 6} onClick={compare}>
                Compare ({selected.length})
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setCompareMode(true)} disabled={(runs ?? []).length < 2}>
              Compare runs
            </Button>
          )}
          {machine?.devMode && (
            <Button onClick={publish} disabled={publishing}>
              {publishing ? "Queueing…" : "Publish gallery"}
            </Button>
          )}
        </div>
      </div>

      {/* Catalog: one row of pills; hover for the detail card. */}
      <div className="mt-5 flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Catalog</span>
        {(benchmarks ?? []).map((b: Benchmark) => (
          <Tooltip key={b.id}>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="cursor-default px-2.5 py-1 text-xs">
                {b.title}
                <span className="ml-1.5 text-muted-foreground">{runCount(b.id)}</span>
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-80 p-3 text-xs">
              <div className="font-medium text-foreground">{b.title}</div>
              <div className="mt-0.5 flex items-center gap-2">
                <Badge variant="secondary">{b.kind === "data-science" ? "data science" : "visual"}</Badge>
                <span className="text-muted-foreground">{runCount(b.id)} runs</span>
              </div>
              <p className="mt-1.5 text-muted-foreground">{b.description}</p>
            </TooltipContent>
          </Tooltip>
        ))}
        {(benchmarks ?? []).length === 0 && (
          <span className="text-xs text-muted-foreground">No prompts — link the gallery repo (benchmarks/).</span>
        )}
      </div>

      <SectionTitle
        title="Runs"
        meta={`${(runs ?? []).length} total`}
        action={
          <Tabs value={groupBy} onValueChange={(v) => setGroupBy(v as "benchmark" | "model")}>
            <TabsList>
              <TabsTrigger value="benchmark">By benchmark</TabsTrigger>
              <TabsTrigger value="model">By model</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />
      {groups.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No runs yet — prepare one from a model page.
          </CardContent>
        </Card>
      ) : (
        groups.map((g) => (
          <div key={g.key} className="mb-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{g.title}</span>
              {g.historical && (
                <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  no longer on this machine
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{g.meta}</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {g.runs.map((r) => {
                const selectedNow = selected.includes(keyOf(r));
                return (
                  <div key={keyOf(r)} className={selectedNow ? "rounded-lg ring-2 ring-primary" : ""}>
                    <RunCard
                      run={r}
                      onClick={() => {
                        if (compareMode) return toggle(r);
                        navigate("benchmarkRun", { runId: r.id, bench: r.bench, slug: r.slug ?? "" });
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}