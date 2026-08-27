import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HUB_DATA } from "@/data/data";
import { RUNS } from "@/data/runs";
import { RunCard, SectionTitle } from "@/components/shared";
import type { Navigate } from "@/App";

export function Benchmark({ navigate }: { navigate: Navigate }) {
  const [bench, setBench] = useState("all");
  const [backend, setBackend] = useState("all");
  const [q, setQ] = useState("");

  const backends = useMemo(() => [...new Set(RUNS.map((r) => r.backend).filter(Boolean))] as string[], []);

  const filtered = useMemo(
    () =>
      RUNS.filter(
        (r) =>
          (bench === "all" || r.bench === bench) &&
          (backend === "all" || r.backend === backend) &&
          (!q || (r.modelDisplay ?? "").toLowerCase().includes(q.toLowerCase()) || (r.model ?? "").toLowerCase().includes(q.toLowerCase()))
      ),
    [bench, backend, q]
  );

  const groups = useMemo(() => {
    const byBench = new Map<string, typeof RUNS>();
    for (const r of filtered) {
      if (!byBench.has(r.bench)) byBench.set(r.bench, []);
      byBench.get(r.bench)!.push(r);
    }
    return [...byBench.entries()];
  }, [filtered]);

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Benchmark</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Visual build tasks run through the agent, then captured and scored. {RUNS.length} real runs across{" "}
        {HUB_DATA.benchmarks.length} prompts.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Select value={bench} onValueChange={setBench}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="All prompts" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All prompts</SelectItem>
            {HUB_DATA.benchmarks.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={backend} onValueChange={setBackend}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All backends" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All backends</SelectItem>
            {backends.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search model…" className="w-56" />

        <Button className="ml-auto" onClick={() => navigate("benchmarkNew")}>
          + Prepare run
        </Button>
      </div>

      {groups.length === 0 ? (
        <div className="mt-10 text-center text-sm text-muted-foreground">No runs match — adjust the filters.</div>
      ) : (
        groups.map(([benchId, runs]) => {
          const b = HUB_DATA.benchmarks.find((x) => x.id === benchId);
          return (
            <div key={benchId}>
              <SectionTitle
                title={b?.title ?? benchId}
                meta={`${runs.length} runs · ${b?.kind === "data-science" ? "data science" : "visual"}`}
              />
              <div className="grid grid-cols-3 gap-3">
                {runs.map((r) => (
                  <RunCard key={r.id} run={r} onClick={() => navigate("benchmarkRun", r.id)} />
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
