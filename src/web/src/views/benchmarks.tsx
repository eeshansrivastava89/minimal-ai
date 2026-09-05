// The benchmarks workbench — ported from the benchmark gallery's
// WorkbenchPage so the structure, positioning, and behavior match the
// original: kind tabs (Visual / Data Science), view tabs (By model / By
// prompt / Compare), collapsible filters (model, prompt, harness, search),
// the include-cloud-models toggle, group summaries, and a paginated
// compare table. Sorting is recency, inherited from the API. Runs whose
// model is no longer in the live catalog stay grouped under their recorded
// identity, marked read-only (a hub rule the gallery didn't need).

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronLeft, ChevronRight, SlidersHorizontal, X } from "lucide-react";
import { toast } from "sonner";
import { api, type RunRef } from "@/api";
import { fmtDateShort } from "@/lib/format";
import {
  runMatchesKind,
  filterOptions,
  filterRuns,
  groupRuns,
  runCardMediaMessage,
  runCardState,
  runSummaryText,
  stackLabel,
  type RunKind,
} from "@/lib/runs-view";
import { RunCard, StatusBadge } from "@/components/shared";
import type { Navigate } from "@/App";
import type { Benchmark, Run } from "@/data/types";

const RUNS_PER_PAGE = 10;
const keyOf = (r: Run) => `${r.bench}/${r.slug}/${r.id}`;

const VIEW_META: Record<string, { title: string; subtitle: string }> = {
  model: { title: "Model comparison", subtitle: "Group attempts by model and prompt." },
  benchmark: { title: "Prompt comparison", subtitle: "Compare one prompt across models." },
  compare: { title: "Compare", subtitle: "Select rows to compare outputs." },
};

export function Benchmarks({ navigate }: { navigate: Navigate }) {
  const queryClient = useQueryClient();
  const { data: runs } = useQuery({ queryKey: ["runs"], queryFn: api.runs, staleTime: 30_000 });
  const { data: benchmarks } = useQuery({ queryKey: ["benchmarks"], queryFn: api.benchmarks, staleTime: 300_000 });
  const { data: machine } = useQuery({ queryKey: ["machine"], queryFn: api.machine, staleTime: 60_000 });

  const [kind, setKind] = useState<RunKind>("visual");
  const [mode, setMode] = useState<"model" | "benchmark" | "compare">("model");
  const [model, setModel] = useState("all");
  const [benchmark, setBenchmark] = useState("all");
  const [harness, setHarness] = useState("all");
  const [search, setSearch] = useState("");
  const [includeCloud, setIncludeCloud] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);

  // The kind's workspace — select options and filters derive from it, like
  // the gallery's runsForCurrentWorkspace.
  const kindRuns = useMemo(
    () => (runs ?? []).filter((r) => runMatchesKind(r, kind)),
    [runs, kind]
  );
  const options = useMemo(() => filterOptions(kindRuns), [kindRuns]);
  const filtered = useMemo(
    () => filterRuns(runs ?? [], { kind, model, benchmark, harness, search, includeCloud }),
    [runs, kind, model, benchmark, harness, search, includeCloud]
  );

  const promptTitle = (id: string) => benchmarks?.find((b) => b.id === id)?.title ?? id;
  const groups = useMemo(() => {
    if (mode === "compare") return [];
    return mode === "model"
      ? groupRuns(filtered, (r) => r.model ?? "Unknown model", (r) => r.benchTitle ?? r.bench)
      : groupRuns(filtered, (r) => r.benchTitle ?? r.bench, (r) => r.model ?? "Unknown model");
  }, [filtered, mode]);

  const activeFilterCount =
    (model !== "all" ? 1 : 0) + (benchmark !== "all" ? 1 : 0) + (harness !== "all" ? 1 : 0) + (search.trim() ? 1 : 0);

  const clearFilters = () => {
    setModel("all");
    setBenchmark("all");
    setHarness("all");
    setSearch("");
    setSelected([]);
    setPage(1);
  };

  const openRun = (r: Run) => navigate("benchmarkRun", { runId: r.id, bench: r.bench, slug: r.slug ?? "" });

  const selectedRuns = filtered.filter((r) => selected.includes(keyOf(r)));

  const exportComparison = async () => {
    const refs: RunRef[] = selectedRuns.map((r) => ({ bench: r.bench, slug: r.slug ?? "", runId: r.id }));
    try {
      await api.comparisonVideo(refs);
      toast("Comparison video queued — watch it in Jobs");
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

  const totalPages = Math.max(1, Math.ceil(filtered.length / RUNS_PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const pageRuns = filtered.slice((currentPage - 1) * RUNS_PER_PAGE, currentPage * RUNS_PER_PAGE);

  return (
    <div>
      <div className="flex items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Benchmarks</h1>
        <div className="ml-auto flex gap-2">
          {machine?.devMode && (
            <Button onClick={publish} disabled={publishing}>
              {publishing ? "Queueing…" : "Publish gallery"}
            </Button>
          )}
        </div>
      </div>

      {/* Kind tabs — Visual / Data Science */}
      <Tabs value={kind} onValueChange={(k) => { setKind(k as RunKind); setPage(1); }} className="mt-4">
        <TabsList>
          <TabsTrigger value="visual">Visual Benchmark</TabsTrigger>
          <TabsTrigger value="data-science">Data Science Benchmark</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Toolbar — view tabs + filters */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Tabs value={mode} onValueChange={(m) => { setMode(m as typeof mode); setPage(1); }}>
          <TabsList>
            <TabsTrigger value="model">By model</TabsTrigger>
            <TabsTrigger value="benchmark">By prompt</TabsTrigger>
            <TabsTrigger value="compare">Compare</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
          >
            <SlidersHorizontal className="size-4" />
            Filters
            {activeFilterCount > 0 && <Badge variant="secondary">{activeFilterCount}</Badge>}
          </Button>
        </div>
      </div>

      {filtersOpen && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select value={model} onValueChange={(v) => { setModel(v); setPage(1); }}>
            <SelectTrigger className="w-44"><span className="truncate">{model === "all" ? "All run models" : model}</span></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All run models</SelectItem>
              {options.models.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={benchmark} onValueChange={(v) => { setBenchmark(v); setPage(1); }}>
            <SelectTrigger className="w-44"><span className="truncate">{benchmark === "all" ? "All prompts" : promptTitle(benchmark)}</span></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All prompts</SelectItem>
              {options.benchmarks.map((b) => (
                <SelectItem key={b} value={b}>{promptTitle(b)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={harness} onValueChange={(v) => { setHarness(v); setPage(1); }}>
            <SelectTrigger className="w-40"><span className="truncate">{harness === "all" ? "All harnesses" : harness}</span></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All harnesses</SelectItem>
              {options.harnesses.map((h) => (
                <SelectItem key={h} value={h}>{h}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="search"
            className="w-64"
            placeholder="Search runs, models, prompts, harnesses"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
      )}

      {/* Summary — title, count, subtitle, run summary; cloud toggle + clear */}
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight">{VIEW_META[mode].title}</h2>
            <Badge variant="outline">{filtered.length}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{VIEW_META[mode].subtitle}</p>
          <p className="text-sm text-muted-foreground">{runSummaryText(filtered, kind)}</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={includeCloud} onCheckedChange={(v) => { setIncludeCloud(v); setPage(1); }} />
            Include cloud models
          </label>
          {(activeFilterCount > 0 || selected.length > 0) && (
            <Button variant="outline" size="sm" onClick={clearFilters}>
              <X className="size-4" />
              {activeFilterCount > 0 && selected.length > 0 ? "Reset view" : selected.length > 0 ? "Clear selection" : "Clear filters"}
            </Button>
          )}
        </div>
      </div>

      {/* Surface */}
      <div className="mt-4">
        {filtered.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No runs match the current filters.
            </CardContent>
          </Card>
        ) : mode === "compare" ? (
          <>
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"><span className="sr-only">Compare</span></TableHead>
                      <TableHead>Prompt</TableHead>
                      <TableHead>Model</TableHead>
                      <TableHead>Stack</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Message</TableHead>
                      <TableHead>Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRuns.map((r) => {
                      const key = keyOf(r);
                      const state = runCardState(r);
                      return (
                        <TableRow key={key} className="cursor-pointer" onClick={() => openRun(r)}>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              aria-label={`Compare ${r.benchTitle} on ${r.model}`}
                              checked={selected.includes(key)}
                              onChange={(e) => {
                                setSelected((prev) =>
                                  e.target.checked ? [...prev, key] : prev.filter((k) => k !== key)
                                );
                              }}
                            />
                          </TableCell>
                          <TableCell className="max-w-48 truncate font-medium text-foreground">{r.benchTitle}</TableCell>
                          <TableCell className="max-w-48 truncate">{r.model ?? "—"}</TableCell>
                          <TableCell className="max-w-56 truncate text-muted-foreground">{stackLabel(r)}</TableCell>
                          <TableCell>
                            <StatusBadge status={state.status}>{state.label}</StatusBadge>
                          </TableCell>
                          <TableCell className="max-w-48 truncate text-muted-foreground">{runCardMediaMessage(r)}</TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDateShort(r.updatedAt ?? r.createdAt)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                Showing {filtered.length === 0 ? 0 : (currentPage - 1) * RUNS_PER_PAGE + 1}–
                {Math.min(currentPage * RUNS_PER_PAGE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                  <ChevronLeft className="size-4" /> Previous
                </Button>
                <Badge variant="outline">Page {currentPage} of {totalPages}</Badge>
                <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>
                  Next <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>

            {/* Selected runs, side by side + the comparison-video export */}
            {selectedRuns.length > 0 && (
              <div className="mt-4">
                <div className="mb-2 flex items-center gap-3">
                  <span className="text-sm font-medium text-foreground">Selected ({selectedRuns.length})</span>
                  <Button
                    size="sm"
                    disabled={selectedRuns.length < 2 || selectedRuns.length > 6}
                    onClick={exportComparison}
                  >
                    Export comparison video
                  </Button>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {selectedRuns.map((r) => (
                    <RunCard key={keyOf(r)} run={r} onClick={() => openRun(r)} mode="model" />
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((g) => (
              <section key={g.title}>
                <div className="mb-2 flex items-center gap-2">
                  <h3 className="text-base font-semibold tracking-tight text-foreground">{g.title}</h3>
                  {mode === "benchmark" && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="cursor-default">See prompt</Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-96 p-3 text-xs">
                        <div className="font-medium text-foreground">{g.title}</div>
                        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                          {benchmarks?.find((b: Benchmark) => b.title === g.title)?.prompt ?? "Prompt unavailable."}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {g.historical && (
                    <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                      no longer on this machine
                    </Badge>
                  )}
                  <span className="text-sm text-muted-foreground">
                    {g.subtitles.length} {mode === "model" ? "prompt" : "model"}{g.subtitles.length === 1 ? "" : "s"}
                  </span>
                  <Badge variant="outline" className="ml-auto">{g.runs.length}</Badge>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {g.runs.map((r) => (
                    <RunCard
                      key={keyOf(r)}
                      run={r}
                      mode={mode === "model" ? "model" : "benchmark"}
                      onClick={() => openRun(r)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}