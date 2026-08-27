import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { HUB_DATA } from "@/data/data";
import { StatusBadge } from "@/components/shared";
import type { Navigate } from "@/App";

const SWEEP_CONFIGS = ["vanilla", "MTP on", "DFlash on", "thinking + budget", "MTP + thinking", "ANE prefill", "turboquant q4", "turboquant q8"];

export function AutotuneNew({ navigate }: { navigate: Navigate }) {
  const [step, setStep] = useState<"form" | "probe" | "sweep" | "done">("form");
  const [model, setModel] = useState(HUB_DATA.omlxModels.find((m) => m.kind === "chat")?.id ?? "");
  const [warm, setWarm] = useState("4");
  const [progress, setProgress] = useState(0);

  const medians = model.includes("27B")
    ? [13.3, null, 17.2, 14.0, null, 14.2, 13.7, 13.7]
    : model.includes("4B")
      ? [57.5, null, null, 54.9, null, 56.1, 56.25, 54.45]
      : [31.95, 38.5, 28.35, 30.15, 47.95, 31.0, 31.0, 30.5];

  useEffect(() => {
    if (step !== "sweep") return;
    const iv = setInterval(() => {
      setProgress((p) => {
        const next = p + 100 / SWEEP_CONFIGS.length;
        if (next >= 100) {
          clearInterval(iv);
          setStep("done");
          return 100;
        }
        return next;
      });
    }, 400);
    return () => clearInterval(iv);
  }, [step]);

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">New autotune sweep</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Autotune drives the oMLX admin API — oMLX models only. A sweep measures ~8 configs, each a cold load + warm runs.
      </p>

      {step === "form" && (
        <Card className="mt-4 max-w-xl">
          <CardHeader>
            <CardTitle>Configure the sweep</CardTitle>
            <CardDescription>Pick the model and how many warm runs to average per config.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {HUB_DATA.omlxModels.filter((m) => m.kind === "chat").map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.id}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Warm runs per config</Label>
              <Select value={warm} onValueChange={setWarm}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["2", "4", "6"].map((w) => (
                    <SelectItem key={w} value={w}>{w}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => setStep("probe")}>Probe &amp; plan</Button>
          </CardContent>
        </Card>
      )}

      {step === "probe" && (
        <Card className="mt-4 max-w-xl">
          <CardHeader>
            <CardTitle>Probe results</CardTitle>
            <CardDescription>{model} on the oMLX server.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Table>
              <TableBody>
                {[
                  ["MTP", "compatible"],
                  ["DFlash", `compatible (draft z-lab/${model.includes("27B") ? "Qwen3.8-27B-DFlash2" : "Qwen3.5-9B-DFlash"})`],
                  ["Thinking default", "true"],
                  ["Tested configs", "8/8"],
                ].map(([k, v]) => (
                  <TableRow key={k}>
                    <TableCell className="w-44 text-muted-foreground">{k}</TableCell>
                    <TableCell className="text-foreground">{v}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-xs text-muted-foreground">Estimated total ~{model.includes("27B") ? "64" : "48"}m across 8 configs.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep("form")}>Back</Button>
              <Button onClick={() => { setProgress(0); setStep("sweep"); }}>Start sweep</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {(step === "sweep" || step === "done") && (
        <Card className="mt-4 max-w-xl">
          <CardHeader>
            <CardTitle>{step === "done" ? "Sweep complete" : "Sweep running"}</CardTitle>
            <CardDescription>{model}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {SWEEP_CONFIGS.map((c, i) => {
              const done = progress >= ((i + 1) / SWEEP_CONFIGS.length) * 100;
              const m = medians[i];
              return (
                <div key={c} className="flex items-center gap-2 text-sm">
                  <StatusBadge status={done ? (m == null ? "warn" : "ok") : "running"}>
                    {done ? (m == null ? "skipped" : `${m.toFixed(1)} tps`) : "…"}
                  </StatusBadge>
                  <span className={done ? "text-foreground" : "text-muted-foreground"}>{c}</span>
                </div>
              );
            })}
            <Progress value={progress} className="mt-2" />
            {step === "done" && (
              <div className="mt-2 flex gap-2">
                <Button onClick={() => toast("Recommendation applied — simulated")}>Apply recommendation</Button>
                <Button variant="outline" onClick={() => navigate("autotune")}>Back to autotune</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
