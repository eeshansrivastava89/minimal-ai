// Prepare a benchmark run for a model: pick a prompt, enqueue the benchmark
// job (prepare slot → pi headless → chained capture/score). Live data.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { api } from "@/api";
import type { Navigate } from "@/App";

export function BenchmarkNew({ modelRef, navigate }: { modelRef: string; navigate: Navigate }) {
  const { data: detail } = useQuery({ queryKey: ["model", modelRef], queryFn: () => api.model(modelRef) });
  const { data: benchmarks } = useQuery({ queryKey: ["benchmarks"], queryFn: api.benchmarks, staleTime: 300_000 });
  const [prompt, setPrompt] = useState<string | null>(null);

  const b = (benchmarks ?? []).find((x) => x.id === (prompt ?? benchmarks?.[0]?.id));
  const [launching, setLaunching] = useState(false);

  const back = () => navigate("model", { modelId: modelRef, tab: "benchmark" });

  const start = async () => {
    if (!b) return;
    setLaunching(true);
    try {
      await api.benchmarkLaunch(modelRef, b.id);
      toast(`Benchmark queued — ${b.title}`);
      navigate("model", { modelId: modelRef, tab: "benchmark" });
    } catch (err) {
      toast((err as Error).message);
      setLaunching(false);
    }
  };

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">Prepare benchmark run</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        <strong className="text-foreground">{detail?.profile?.label ?? detail?.title ?? modelRef}</strong> — creates a run slot in
        runs/&lt;benchmark&gt;/&lt;model&gt;/&lt;run-id&gt;/, launches the agent there, then captures (or scores) automatically.
      </p>

      <Card className="mt-4 max-w-xl">
        <CardHeader>
          <CardTitle>Run slot</CardTitle>
          <CardDescription>Pick the prompt this model will run.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Prompt</Label>
            <Select value={b?.id ?? ""} onValueChange={setPrompt}>
              <SelectTrigger><SelectValue placeholder={benchmarks ? "Pick a prompt" : "Loading…"} /></SelectTrigger>
              <SelectContent>
                {(benchmarks ?? []).map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {x.title}{x.kind === "data-science" ? " (data science)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {b && (
            <div className="rounded border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              <div className="mb-1 font-medium text-foreground">{b.title}</div>
              {b.description}
            </div>
          )}

          {!benchmarks || benchmarks.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No benchmark prompts found — link the local-llm-visual-benchmark gallery repo (benchmarks/).
            </p>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" onClick={back}>Back</Button>
              <Button onClick={start} disabled={!b || launching}>
                {launching ? "Queueing…" : "Create slot & launch"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}