// The global job queue — every long-running thing the hub does (downloads,
// setups, launches; sweeps/captures in later phases). Live list via SSE,
// live logs via per-job SSE. Cancel while queued/running; restart anything.

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { api } from "@/api";
import { fmtBytes } from "@/lib/format";
import { SectionTitle, StatusBadge } from "@/components/shared";
import type { Job } from "@/data/types";

const ACTIVE = new Set(["queued", "running"]);
const RESTARTABLE = new Set(["failed", "cancelled", "interrupted"]);

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** One SSE-driven live query: initial fetch, then /api/jobs/stream updates. */
function useJobsLive() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["jobs"], queryFn: api.jobs });
  useEffect(() => {
    const es = new EventSource("/api/jobs/stream");
    es.addEventListener("jobs", (e) => {
      queryClient.setQueryData(["jobs"], JSON.parse((e as MessageEvent).data) as Job[]);
    });
    es.onerror = () => es.close();
    return () => es.close();
  }, [queryClient]);
  return { jobs: data, isLoading };
}

/** Live tail of one job's log while it's active (initial content + stream). */
function LiveLog({ job }: { job: Job }) {
  const [lines, setLines] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let es: EventSource | null = null;
    (async () => {
      const initial = await api.jobLog(job.id).catch(() => "");
      if (!active) return;
      setLines(initial ? initial.split("\n").filter(Boolean) : []);
      if (job.status !== "queued" && job.status !== "running") return;
      es = new EventSource(`/api/jobs/${encodeURIComponent(job.id)}/stream`);
      es.addEventListener("log", (e) => {
        setLines((prev) => [...prev, (e as MessageEvent).data]);
      });
      es.onerror = () => es?.close();
    })();
    return () => {
      active = false;
      es?.close();
    };
  }, [job.id, job.status]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [lines.length]);

  return (
    <ScrollArea className="h-80">
      <div className="p-4 font-mono text-xs leading-relaxed">
        {lines.length === 0 ? (
          <div className="text-muted-foreground">No log output yet.</div>
        ) : (
          lines.map((line, i) => <div key={i} className="whitespace-pre-wrap break-all text-muted-foreground">{line}</div>)
        )}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}

function JobRow({ job, selected, onSelect }: { job: Job; selected: boolean; onSelect: () => void }) {
  const onCancel = async () => {
    try {
      await api.cancelJob(job.id);
    } catch (err) {
      toast((err as Error).message);
    }
  };
  const onRestart = async () => {
    try {
      await api.restartJob(job.id);
      toast("Restarted — tracking here");
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <TableRow className={selected ? "bg-muted/50" : "cursor-pointer"} onClick={onSelect}>
      <TableCell>
        <span className={selected ? "font-medium" : ""}>{job.title}</span>
        <div className="text-xs text-muted-foreground">{job.type}</div>
      </TableCell>
      <TableCell>
        <StatusBadge status={job.status} />
      </TableCell>
      <TableCell className="w-56">
        {job.status === "running" || job.status === "queued" ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{job.message ?? "waiting"}</span>
            <Progress value={job.progress} />
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{job.message ?? job.error ?? ""}</span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtTime(job.createdAt)}</TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtTime(job.finishedAt)}</TableCell>
      <TableCell onClick={(e) => e.stopPropagation()}>
        <div className="flex gap-1">
          {ACTIVE.has(job.status) && (
            <Button size="sm" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {RESTARTABLE.has(job.status) && (
            <Button size="sm" variant="outline" onClick={onRestart}>
              Restart
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function Jobs() {
  const { jobs, isLoading } = useJobsLive();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = jobs?.find((j) => j.id === selectedId) ?? null;
  // Default to the first active job so the log view is useful on arrival.
  const shown = selected ?? jobs?.find((j) => ACTIVE.has(j.status)) ?? null;

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Logs &amp; jobs</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        One runner for everything long-running — downloads, setups, agent launches. Progress streams over SSE.
      </p>

      <SectionTitle title="Queue" meta="newest first" />
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : !jobs || jobs.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No jobs yet. Download a model, set one up, or run one in the browser — it shows up here.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Finished</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} selected={job.id === shown?.id} onSelect={() => setSelectedId(job.id)} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {shown && (
        <>
          <SectionTitle
            title={shown.title}
            meta={
              shown.status === "running"
                ? `${shown.progress}% · live`
                : `${shown.status}${shown.metrics?.durationMs != null ? ` · ${(Number(shown.metrics.durationMs) / 1000).toFixed(1)}s` : ""}`
            }
          />
          <Card>
            <CardContent className="p-0">
              <LiveLog job={shown} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}