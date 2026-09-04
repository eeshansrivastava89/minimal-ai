// The live jobs query: initial fetch + the /api/jobs/stream SSE updates.
// Shared by the Jobs page and any view that needs live job state (the
// autotune tab's live sweep matrix).

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api";
import type { Job } from "@/data/types";

export function useJobsLive() {
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