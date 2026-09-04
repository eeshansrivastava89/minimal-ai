import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { api } from "@/api";
import { fmtBytes, fmtCtx, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BackendBadge, CapabilityBadges, SectionTitle, StatCard, StatusBadge } from "@/components/shared";
import { useJobsLive } from "@/hooks/use-jobs";
import { ModelAutotune } from "@/views/model-autotune";
import { ModelBenchmark } from "@/views/model-benchmark";
import { ModelLogs } from "@/views/model-logs";
import type { Navigate } from "@/App";
import type { MemoryHeatmap, ModelDetail as ModelDetailT, Profile } from "@/data/types";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "configuration", label: "Configuration" },
  { id: "logs", label: "Logs" },
  { id: "autotune", label: "Autotune" },
  { id: "benchmark", label: "Benchmark" },
];

// Context × cache heatmap, computed server-side by the real estimator
// (estimate.mjs) from the GGUF on disk — llama.cpp models only.
function Heatmap({ heatmap, ramBytes, profile }: { heatmap: MemoryHeatmap; ramBytes: number; profile?: Profile }) {
  const currentCtx = (profile?.capabilities?.contextLength ?? profile?.capabilities?.ctxSize) as number | undefined;
  const currentPrec = profile?.flags?.cacheTypeK as string | undefined;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>KV precision</TableHead>
          {heatmap.grid.map((g) => (
            <TableHead key={g.ctx} className="text-right">
              {g.ctx >= 1024 ? `${g.ctx / 1024}K` : g.ctx}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {heatmap.caches.map((cache, i) => (
          <TableRow key={cache}>
            <TableCell className="font-medium">{cache}</TableCell>
            {heatmap.grid.map((g) => {
              const total = g.cells[i];
              const ratio = total / ramBytes;
              const isCurrent = g.ctx === currentCtx && cache === currentPrec;
              const cls = ratio > 1 ? "bg-destructive/15 text-destructive" : ratio > 0.8 ? "bg-muted" : "bg-muted/40";
              return (
                <TableCell key={g.ctx} className={cn("text-right tabular-nums", cls, isCurrent && "ring-2 ring-ring ring-inset")}>
                  {fmtBytes(total)}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SettingsTable({ rows }: { rows: [string, unknown][] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableBody>
            {rows.map(([k, v]) => (
              <TableRow key={k}>
                <TableCell className="w-56 text-muted-foreground">{k}</TableCell>
                <TableCell className="tabular-nums text-foreground">
                  {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function OverviewTab({
  detail,
  profile,
  heatmap,
  ramBytes,
  navigate,
}: {
  detail: ModelDetailT;
  profile?: Profile;
  heatmap: MemoryHeatmap | null;
  ramBytes: number;
  navigate: Navigate;
}) {
  const caps = detail.capabilities;
  const [prompt, setPrompt] = useState("");
  const [launching, setLaunching] = useState(false);

  const runInBrowser = async () => {
    setLaunching(true);
    try {
      await api.launchModel(detail.ref, { message: prompt.trim() || undefined });
      toast("Queued — tracking live in Jobs");
      navigate("jobs");
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  const openInTerminal = async () => {
    try {
      await api.openTerminal(detail.ref);
      toast("Opened in Terminal — the session lives there");
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <div>
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Size" value={fmtBytes(detail.sizeBytes)} />
        <StatCard label="Context" value={fmtCtx(detail.contextLength)} />
        <StatCard label="Architecture" value={String(caps.architecture ?? "—")} />
        <StatCard label="Thinking" value={profile ? (profile.thinkingOff ? "off" : (profile.thinkingLevel ?? "default")) : "—"} />
      </div>

      <SectionTitle title="Context × cache heatmap" meta={heatmap ? "estimated memory vs installed RAM" : "llama.cpp models only"} />
      <Card>
        <CardContent className="p-4">
          {heatmap ? (
            <>
              <Heatmap heatmap={heatmap} ramBytes={ramBytes} profile={profile} />
              <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
                <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-muted/40 align-[-1px]" />fits</span>
                <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-muted align-[-1px]" />tight</span>
                <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-destructive/15 align-[-1px]" />doesn't fit</span>
                <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm ring-2 ring-ring align-[-1px]" />current config</span>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              The heatmap is computed from GGUF metadata by the local estimator — managed backends
              (oMLX, Ollama) size memory server-side.
            </p>
          )}
        </CardContent>
      </Card>

      <SectionTitle title="Run" meta={profile ? undefined : "set the model up first"} />
      <Card>
        <CardContent className="flex flex-col gap-2 p-4">
          {profile ? (
            <>
              <p className="text-sm text-muted-foreground">
                Run in browser: the hub starts the server, spawns pi headless, and streams its output
                in Jobs. Open in Terminal: an interactive pi session in Terminal.app — the hub
                doesn't own that process, it watches backend state instead.
              </p>
              <Textarea
                placeholder="Optional prompt for the run (leave empty to let pi decide)"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="flex gap-2">
                <Button size="sm" disabled={launching} onClick={runInBrowser}>
                  {launching ? "Queueing…" : "Run in browser"}
                </Button>
                <Button size="sm" variant="outline" onClick={openInTerminal}>
                  Open in Terminal
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No saved profile yet — set this model up first and the run actions appear here.
            </p>
          )}
        </CardContent>
      </Card>

      <RecentActivity modelRef={detail.ref} navigate={navigate} />
    </div>
  );
}

/** Every job recorded against this model — launches, sweeps, benchmarks.
 *  The spine law: a job names its parent; this is the model's own record. */
function RecentActivity({ modelRef, navigate }: { modelRef: string; navigate: Navigate }) {
  const { jobs } = useJobsLive();
  const rows = (jobs ?? []).filter((j) => j.ref === modelRef).slice(0, 8);
  if (rows.length === 0) return null;
  return (
    <>
      <SectionTitle
        title="Recent activity"
        meta="jobs recorded against this model"
        action={
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => navigate("jobs")}>
            All jobs
          </Button>
        }
      />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {rows.map((j) => (
                <TableRow key={j.id}>
                  <TableCell className="font-medium text-foreground">{j.title}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{j.type}</TableCell>
                  <TableCell>
                    <StatusBadge status={j.status} />
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{fmtRelative(j.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function ConfigurationTab({ detail, navigate }: { detail: ModelDetailT; navigate: Navigate }) {
  const queryClient = useQueryClient();
  const profile = detail.profile;
  const settings = detail.omlxModelSettings ?? null;
  const flags = profile?.flags ?? null;

  const remove = async () => {
    if (!window.confirm(`Remove the saved configuration for ${profile?.label ?? detail.title}? Model files stay on disk.`)) return;
    try {
      await api.removeProfile(detail.ref);
      toast("Configuration removed");
      await queryClient.invalidateQueries({ queryKey: ["model", detail.ref] });
      await queryClient.invalidateQueries({ queryKey: ["models"] });
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <div>
      {settings && (
        <>
          <SectionTitle title="oMLX settings" meta="applied on the server" />
          <SettingsTable rows={Object.entries(settings)} />
        </>
      )}
      {flags && (
        <>
          <SectionTitle title="llama.cpp flags" />
          <SettingsTable rows={Object.entries(flags)} />
        </>
      )}
      {!settings && !flags && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No extra server settings for this model.
          </CardContent>
        </Card>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="outline" onClick={() => navigate("setupNew", { modelId: detail.ref, tab: detail.backend })}>
          {profile ? "Reconfigure" : "Set up"}
        </Button>
        {profile && (
          <Button variant="destructive" onClick={remove}>
            Remove configuration
          </Button>
        )}
      </div>
    </div>
  );
}

export function ModelDetail({ id, tab, navigate }: { id: string; tab: string; navigate: Navigate }) {
  const { data: detail, isLoading, error } = useQuery({ queryKey: ["model", id], queryFn: () => api.model(id) });
  const { data: setup } = useQuery({ queryKey: ["setup", id], queryFn: () => api.setup(id) });
  const { data: machine } = useQuery({ queryKey: ["machine"], queryFn: api.machine, staleTime: 60_000 });
  const { data: autotune } = useQuery({ queryKey: ["autotune", id], queryFn: () => api.autotune(id), enabled: tab === "autotune" });
  const { data: runs } = useQuery({ queryKey: ["modelRuns", id], queryFn: () => api.modelRuns(id), enabled: tab === "benchmark" });
  const { data: logs } = useQuery({ queryKey: ["modelLogs", id], queryFn: () => api.modelLogs(id), enabled: tab === "logs" });

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (error || !detail) {
    return (
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">No model "{id}".</p>
      </div>
    );
  }

  const profile = detail.profile;

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{profile?.label ?? detail.title}</h1>
        <span className="text-sm text-muted-foreground">{detail.id}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <BackendBadge backend={detail.backend} />
        <CapabilityBadges caps={detail.capabilities} />
      </div>

      <Tabs value={tab} onValueChange={(t) => navigate("model", { modelId: id, tab: t })} className="mt-6">
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="mt-4">
        {tab === "overview" && (
          <OverviewTab
            detail={detail}
            profile={profile}
            heatmap={setup?.heatmap ?? null}
            ramBytes={machine?.ramBytes ?? 0}
            navigate={navigate}
          />
        )}
        {tab === "configuration" && <ConfigurationTab detail={detail} navigate={navigate} />}
        {tab === "logs" && <ModelLogs logs={logs} />}
        {tab === "autotune" && <ModelAutotune backend={detail.backend} run={autotune ?? null} profile={profile} modelRef={id} navigate={navigate} />}
        {tab === "benchmark" && <ModelBenchmark runs={runs} profile={profile} navigate={navigate} />}
      </div>
    </div>
  );
}
