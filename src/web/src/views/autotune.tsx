// The autotune section — the cross-model record of tuning results, sibling
// of /benchmarks. Each row's parent is its model; rows link back to the
// model page's autotune tab (the parent-child link never breaks).

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { AutotuneTable, SectionTitle } from "@/components/shared";
import { Card, CardContent } from "@/components/ui/card";
import type { Navigate } from "@/App";

export function Autotune({ navigate }: { navigate: Navigate }) {
  const { data: autotune } = useQuery({ queryKey: ["autotune"], queryFn: api.allAutotune, staleTime: 60_000 });

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">Autotune</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Every model's latest tuning recommendation — the config the sweep picked, and how it compares to vanilla.
      </p>

      <SectionTitle title="Recommendations" meta={`${autotune?.length ?? 0} models`} />
      {(autotune ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No sweeps yet — run an autotune from a model page.
          </CardContent>
        </Card>
      ) : (
        <AutotuneTable autotune={autotune} navigate={navigate} />
      )}
    </div>
  );
}