// New autotune sweep — the live plan preview (probe + grid, read-only) and
// the Start button that enqueues the sweep job. The same matrix component
// renders the plan here and the live/results matrix on the model tab.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { api } from "@/api";
import { SectionTitle, StatusBadge, SweepMatrix, type SweepConfig } from "@/components/shared";
import type { Navigate } from "@/App";

export function AutotuneNew({ modelRef, navigate }: { modelRef: string; navigate: Navigate }) {
  const { data: detail } = useQuery({ queryKey: ["model", modelRef], queryFn: () => api.model(modelRef) });
  const { data: plan, isLoading, error } = useQuery({
    queryKey: ["autotunePlan", modelRef],
    queryFn: () => api.autotunePlan(modelRef),
  });
  const [apply, setApply] = useState(true);
  const [starting, setStarting] = useState(false);

  const back = () => navigate("model", { modelId: modelRef, tab: "autotune" });

  const start = async () => {
    setStarting(true);
    try {
      await api.autotuneStart(modelRef, apply);
      toast("Sweep queued — live progress on the model page");
      navigate("model", { modelId: modelRef, tab: "autotune" });
    } catch (err) {
      toast((err as Error).message);
      setStarting(false);
    }
  };

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">New autotune sweep</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        <strong className="text-foreground">{detail?.profile?.label ?? detail?.title ?? modelRef}</strong> — a sweep
        measures every config in the grid against the live oMLX server (one model loaded at a time, RAM-gated), then
        recommends the fastest.
      </p>

      <SectionTitle title="Plan" meta="read-only preview — nothing is changed yet" />
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Probing the oMLX server…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{(error as Error).message}</p>
          ) : !plan ? (
            <p className="text-sm text-muted-foreground">No plan.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{plan.model.displayName}</span>
                <StatusBadge status={plan.model.mtpCompatible ? "ok" : "warn"}>
                  MTP {plan.model.mtpCompatible ? "compatible" : "off"}
                </StatusBadge>
                <StatusBadge status={plan.model.dflashCompatible ? "ok" : "warn"}>
                  DFlash {plan.model.dflashCompatible ? "compatible" : "off"}
                </StatusBadge>
                <span>{plan.testedCount} of {plan.rows.length} configs will be measured</span>
              </div>
              <SweepMatrix configs={plan.rows as SweepConfig[]} />
              <p className="text-xs text-muted-foreground">
                ✓ will measure · – compatible, not measured · NA not possible. The sweep unloads between configs and
                restores your settings at the end (or applies the recommendation).
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <SectionTitle title="Start" />
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Run the sweep</CardTitle>
          <CardDescription>One job in the queue — progress and the live matrix stream on the model page.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Switch id="apply" checked={apply} onCheckedChange={setApply} />
            <Label htmlFor="apply">Apply the recommendation when the sweep finishes</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            {apply
              ? "The winning config is PUT to the server (echo-verified) and applied to the profile's oMLX settings."
              : "Your current settings are restored when the sweep finishes; the recommendation is saved for later."}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={back}>Back</Button>
            <Button onClick={start} disabled={starting || !plan}>
              {starting ? "Queueing…" : "Start sweep"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}