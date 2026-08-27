import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { HUB_DATA } from "@/data/data";
import type { Navigate } from "@/App";

export function BenchmarkNew({ navigate }: { navigate: Navigate }) {
  const [prompt, setPrompt] = useState(HUB_DATA.benchmarks[0].id);
  const [model, setModel] = useState(HUB_DATA.profiles[0].id);

  const b = HUB_DATA.benchmarks.find((x) => x.id === prompt);
  const p = HUB_DATA.profiles.find((x) => x.id === model);

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">Prepare benchmark run</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Creates a run slot in runs/&lt;benchmark&gt;/&lt;model&gt;/&lt;run-id&gt;/, then launches the agent in that directory.
      </p>

      <Card className="mt-4 max-w-xl">
        <CardHeader>
          <CardTitle>Run slot</CardTitle>
          <CardDescription>Pick the prompt and the model that will run it.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Prompt</Label>
            <Select value={prompt} onValueChange={setPrompt}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {HUB_DATA.benchmarks.map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {x.title}{x.kind === "data-science" ? " (data science)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {HUB_DATA.profiles.map((x) => (
                  <SelectItem key={x.id} value={x.id}>{x.label}</SelectItem>
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

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => navigate("benchmark")}>Back</Button>
            <Button onClick={() => toast(`Run slot prepared for ${p?.label} → ${b?.title}. Launching agent — simulated.`)}>
              Create slot &amp; launch
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
