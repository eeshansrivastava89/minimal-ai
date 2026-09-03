import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RunCard, SectionTitle } from "@/components/shared";
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
                onClick={() => navigate("benchmarkRun", { modelId: r.ownerRef ?? undefined, runId: r.id })}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
