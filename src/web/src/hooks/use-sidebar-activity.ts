// Sidebar activity + totals — one derivation, no hardcoding: which nav
// section has a live job (green spinner) and what its total is, both
// computed from the same live queries the pages use.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import type { JobType } from "@/data/types";
import { useJobsLive } from "@/hooks/use-jobs";

// Which job types make a section "active" — the spine mapping: a model is
// in use while a launch/benchmark runs; the benchmarks pipeline is its own
// family; autotune and the queue itself.
const SECTION_TYPES: Record<string, JobType[]> = {
  "/models": ["launch", "benchmark"],
  "/benchmarks": ["benchmark", "capture", "comparison-video", "export"],
  "/autotune": ["autotune"],
};

export function useSidebarActivity(): {
  activity: Record<string, boolean>;
  counts: Record<string, number | undefined>;
} {
  const { jobs } = useJobsLive();
  const { data: runs } = useQuery({ queryKey: ["runs"], queryFn: api.runs, staleTime: 30_000 });
  const { data: autotune } = useQuery({ queryKey: ["autotune"], queryFn: api.allAutotune, staleTime: 60_000 });

  const activeTypes = new Set(
    (jobs ?? []).filter((j) => j.status === "running" || j.status === "queued").map((j) => j.type)
  );
  const activity: Record<string, boolean> = {};
  for (const [section, types] of Object.entries(SECTION_TYPES)) {
    activity[section] = types.some((t) => activeTypes.has(t));
  }
  activity["/jobs"] = activeTypes.size > 0;

  return {
    activity,
    counts: {
      "/benchmarks": runs?.length,
      "/autotune": autotune?.length,
    },
  };
}