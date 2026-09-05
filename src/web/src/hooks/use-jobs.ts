// The live jobs query: initial fetch + the /api/jobs/stream SSE updates.
// Shared by the Jobs page and any view that needs live job state (the
// autotune tab's live sweep matrix).
//
// ONE EventSource for the whole app (the hook is mounted from several
// views), ref-counted across mounts; EventSource's native reconnect covers
// hub restarts — every reconnect re-sends the full list, which replaces
// (never duplicates) the query cache.

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import type { Job } from "@/data/types";

const listeners = new Set<(jobs: Job[]) => void>();
let shared: EventSource | null = null;

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
  useEffect(
    () => ensureStream((jobs) => queryClient.setQueryData(["jobs"], jobs)),
    [queryClient]
  );
  return { jobs: data, isLoading };
}