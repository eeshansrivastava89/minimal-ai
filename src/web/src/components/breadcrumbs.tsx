// Breadcrumbs — the entity spine rendered as the header title. ONE function
// derives the crumb chain from the URL tree; parent links only ever point at
// real routes (never a segment without a page), and labels come from the
// same cached queries the pages use — so a crumb can't drift from its data
// and can never link somewhere that doesn't exist.

import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";

interface Crumb {
  label: string;
  to?: string; // absent = plain text (no page at that depth)
}

// Static first-level segments and fixed child-segment labels. The URL tree
// is the spine — this map is the only place segment names get their titles.
const STATIC: Record<string, string> = {
  dashboard: "Dashboard",
  models: "Models",
  benchmarks: "Benchmarks",
  autotune: "Autotune",
  jobs: "Jobs",
  learn: "Learn",
  settings: "Settings",
  setup: "Setup",
};

function useCrumbs(): Crumb[] {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const segs = pathname.split("/").filter(Boolean).map(decodeURIComponent);

  const { data: modelsData } = useQuery({ queryKey: ["models"], queryFn: api.models, staleTime: 30_000 });
  const { data: benchmarks } = useQuery({ queryKey: ["benchmarks"], queryFn: api.benchmarks, staleTime: 300_000 });
  const { data: runs } = useQuery({ queryKey: ["runs"], queryFn: api.runs, staleTime: 30_000 });

  const modelCrumb = (ref: string): Crumb => {
    const m = modelsData?.models.find((x) => x.ref === ref);
    return { label: m?.title ?? ref, to: `/models/${encodeURIComponent(ref)}` };
  };

  // /models/:id (tabs are search params, not path)
  if (segs[0] === "models" && segs[1]) {
    const crumbs: Crumb[] = [{ label: STATIC.models, to: "/models" }, modelCrumb(segs[1])];
    if (segs[2] === "setup") crumbs.push({ label: STATIC.setup });
    if (segs[2] === "autotune" && segs[3] === "new") {
      crumbs.push({ label: "Autotune" }, { label: "New sweep" });
    }
    if (segs[2] === "benchmark" && segs[3] === "new") {
      crumbs.push({ label: "Benchmark" }, { label: "Prepare run" });
    }
    return crumbs;
  }

  // /benchmarks/:bench/:slug/:runId — the repo's own hierarchy
  if (segs[0] === "benchmarks") {
    const crumbs: Crumb[] = [{ label: STATIC.benchmarks, to: "/benchmarks" }];
    if (segs[1]) {
      const bench = benchmarks?.find((b) => b.id === segs[1]);
      crumbs.push({ label: bench?.title ?? segs[1] });
      if (segs[2]) {
        const run = runs?.find((r) => r.bench === segs[1] && r.slug === segs[2] && r.id === segs[3]);
        const name = run?.modelDisplay ?? run?.model ?? segs[2];
        crumbs.push(run?.ownerRef ? { label: name, to: `/models/${encodeURIComponent(run.ownerRef)}` } : { label: name });
        if (segs[3]) crumbs.push({ label: "Run" });
      }
    }
    return crumbs;
  }

  // Every other route: a single static crumb (the page title).
  return [{ label: STATIC[segs[0] ?? "dashboard"] ?? "Dashboard" }];
}

export function Breadcrumbs() {
  const crumbs = useCrumbs();
  if (crumbs.length === 0) return null;

  return (
    <nav className="flex min-w-0 items-center gap-1.5 text-lg font-semibold">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        const content =
          c.to && !last ? (
            <Link to={c.to} className="truncate text-sm font-normal text-muted-foreground hover:text-foreground">
              {c.label}
            </Link>
          ) : (
            <span className="truncate">{c.label}</span>
          );
        return (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-sm text-muted-foreground/50">/</span>}
            {content}
          </span>
        );
      })}
    </nav>
  );
}