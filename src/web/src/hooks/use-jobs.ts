// The live jobs query: initial fetch + the /api/jobs/stream SSE updates.
// Shared by the Jobs page and any view that needs live job state (the
// autotune tab's live sweep matrix).
//
// ONE EventSource for the whole app (the hook is mounted from several
// views), ref-counted across mounts; EventSource's native reconnect covers
// hub restarts — every reconnect re-sends the full list, which replaces
// (never duplicates) the query cache.
//
// Completion-driven invalidation: jobs are the hub's only write path, so
// a job reaching a finished state is the moment the models/runs/autotune
// caches went stale. Invalidate here and every view reflects a finished
// job immediately — no waiting out staleTime, no manual reload.

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import type { Job } from "@/data/types";

const listeners = new Set<(jobs: Job[]) => void>();
let shared: EventSource | null = null;

const FINISHED = new Set(["completed", "failed", "cancelled", "interrupted"]);

function ensureStream(onJobs: (jobs: Job[]) => void): () => void {
  listeners.add(onJobs);
  if (!shared) {
    shared = new EventSource("/api/jobs/stream");
    shared.addEventListener("jobs", (e) => {
      const jobs = JSON.parse((e as MessageEvent).data) as Job[];
      for (const l of listeners) l(jobs);
    });
  }
  return () => {
    listeners.delete(onJobs);
    if (listeners.size === 0 && shared) {
      shared.close();
      shared = null;
    }
  };
}

export function useJobsLive() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["jobs"], queryFn: api.jobs });
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    const seenNow = seen.current;
    return ensureStream((jobs) => {
      queryClient.setQueryData(["jobs"], jobs);
      for (const j of jobs) {
        const was = seenNow.get(j.id);
        seenNow.set(j.id, j.status);
        if (was === undefined || was === j.status || !FINISHED.has(j.status)) continue;
        // First transition into a finished state: the caches this job may
        // have mutated are stale now. (Duplicate invalidations across hook
        // instances are deduped by react-query into one refetch.)
        const keys: unknown[][] = [["models"], ["runs"], ["autotune"]];
        if (j.ref) keys.push(["model", j.ref], ["setup", j.ref]);
        for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
      }
    });
  }, [queryClient]);
  return { jobs: data, isLoading };
}