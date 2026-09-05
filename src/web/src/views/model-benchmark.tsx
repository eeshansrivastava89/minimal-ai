import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RunCard, SectionTitle } from "@/components/shared";
import { useJobsLive } from "@/hooks/use-jobs";
import type { Navigate } from "@/App";
import type { Profile, Run } from "@/data/types";

export function ModelBenchmark({
  runs,
  profile,
  navigate,
}: {
  runs: Run[] | undefined;
  profile?: Profile;
  navigate: Navigate;
}) {
  const { jobs } = useJobsLive();
  // Same live-job overlay as the benchmarks workbench, scoped to this
  // model's runs.
  const liveFor = (r: Run): string | null => {
    for (const j of jobs ?? []) {
      if (j.status !== "running" && j.status !== "queued") continue;
      const p = j.payload ?? {};
      if (j.type === "capture" && p.runId === r.id && p.bench === r.bench) return "Capturing";
      if (j.type === "score" && p.runId === r.id && p.bench === r.bench) return "Scoring";
      if (j.type === "benchmark" && j.status === "running" && j.ref === r.ownerRef && p.benchmarkId === r.bench && r.status === "prepared")
        return "Preparing";
    }
    return null;
  };
  return (
    <div>
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          Every benchmark run this model has produced — visual builds and data-science scorecards.
        </p>
        {profile && (
          <Button className="ml-auto shrink-0" onClick={() => navigate("benchmarkNew", { modelId: profile.id })}>
            + Prepare run
          </Button>
        )}
      </div>

      {!runs ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : runs.length === 0 ? (
        <Card className="mt-4">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No runs for this model yet{profile ? " — prepare one to see it here" : ""}.
          </CardContent>
        </Card>
      ) : (
        <>
          <SectionTitle title="Runs" meta={`${runs.length} total`} />
          <div className="grid grid-cols-3 gap-3">
            {runs.map((r) => (
              <RunCard
                key={r.id}
                run={r}
                live={liveFor(r)}
                onClick={() => navigate("benchmarkRun", { runId: r.id, bench: r.bench, slug: r.slug ?? "" })}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
