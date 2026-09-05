// URL routing (TanStack Router, code-based). The entity spine is the URL
// tree: models are the top entity, backend is an attribute — every model
// URL is /models/<backend:id>, never /backends/.... Tabs are a search
// param; flows are child pages.

import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import App, { type Navigate } from "./App";
import { api } from "./api";
import { Dashboard } from "./views/dashboard";
import { Models } from "./views/models";
import { ModelDetail } from "./views/model-detail";
import { SetupNew } from "./views/setup-new";
import { AutotuneNew } from "./views/autotune-new";
import { BenchmarkNew } from "./views/benchmark-new";
import { BenchmarkDetail } from "./views/benchmark-detail";
import { Benchmarks } from "./views/benchmarks";
import { Autotune } from "./views/autotune";
import { Jobs } from "./views/jobs";
import { Learn } from "./views/learn";
import { Settings } from "./views/settings";

// Legacy view-name navigation, kept for the mock pages (Phases 3–5 convert
// them). Resolves profile ids to ModelRefs via the live catalog.
export function useNav(): Navigate {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ["models"], queryFn: api.models, staleTime: 30_000 });
  const refFor = (modelId?: string): string => {
    if (!modelId) return "";
    if (modelId.includes(":")) return modelId; // already a ref
    const byProfile = data?.models.find((m) => m.profileId === modelId);
    if (byProfile) return byProfile.ref;
    const byId = data?.models.find((m) => m.id === modelId);
    return byId?.ref ?? modelId;
  };
  return (view, opts) => {
    const ref = refFor(opts?.modelId);
    switch (view) {
      case "model":
        return navigate({ to: "/models/$id", params: { id: ref }, search: { tab: opts?.tab } });
      case "setupNew":
        return navigate({
          to: "/models/$id/setup",
          params: { id: ref },
          search: { backend: opts?.tab },
        });
      case "autotuneNew":
        return navigate({ to: "/models/$id/autotune/new", params: { id: ref } });
      case "benchmarkNew":
        return navigate({ to: "/models/$id/benchmark/new", params: { id: ref } });
      case "benchmarkRun":
        // Run detail lives under /benchmarks (the cross-model record) —
        // reachable from both the model page (live) and the benchmarks
        // browser (historical). bench/slug/runId are the run's filesystem
        // identity.
        return navigate({
          to: "/benchmarks/$bench/$slug/$runId",
          params: { bench: opts?.bench ?? "", slug: opts?.slug ?? "", runId: opts?.runId ?? "" },
        });
      default:
        return navigate({ to: `/${view}`, search: view === "jobs" ? { job: opts?.jobId } : undefined });
    }
  };
}

const rootRoute = createRootRoute({ component: App });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/dashboard" });
  },
});

function DashboardPage() {
  return <Dashboard navigate={useNav()} />;
}

function ModelsPage() {
  return <Models navigate={useNav()} />;
}

function ModelPage() {
  const { id } = useParams({ from: modelRoute.id });
  const { tab } = useSearch({ from: modelRoute.id });
  return <ModelDetail id={id} tab={tab ?? "overview"} navigate={useNav()} />;
}

function SetupPage() {
  const { id } = useParams({ from: setupRoute.id });
  return <SetupNew modelRef={id} navigate={useNav()} />;
}

function AutotuneNewPage() {
  const { id } = useParams({ from: autotuneNewRoute.id });
  return <AutotuneNew modelRef={id} navigate={useNav()} />;
}

function BenchmarkNewPage() {
  const { id } = useParams({ from: benchmarkNewRoute.id });
  return <BenchmarkNew modelRef={id} navigate={useNav()} />;
}

function BenchmarkRunPage() {
  const { bench, slug, runId } = useParams({ from: runRoute.id });
  return <BenchmarkDetail run={{ bench, slug, runId }} navigate={useNav()} />;
}

function BenchmarksPage() {
  return <Benchmarks navigate={useNav()} />;
}

function AutotunePage() {
  return <Autotune navigate={useNav()} />;
}

function JobsPage() {
  const { job } = useSearch({ from: jobsRoute.id });
  return <Jobs initialJobId={job} />;
}

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dashboard",
  component: DashboardPage,
});
const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/models",
  component: ModelsPage,
});
const modelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/models/$id",
  validateSearch: (s: Record<string, unknown>): { tab?: string } => ({
    tab: typeof s.tab === "string" ? s.tab : undefined,
  }),
  component: ModelPage,
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/models/$id/setup",
  component: SetupPage,
});
const autotuneNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/models/$id/autotune/new",
  component: AutotuneNewPage,
});
const benchmarkNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/models/$id/benchmark/new",
  component: BenchmarkNewPage,
});
const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/benchmarks/$bench/$slug/$runId",
  component: BenchmarkRunPage,
});
const benchmarksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/benchmarks",
  component: BenchmarksPage,
});
const autotuneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/autotune",
  component: AutotunePage,
});
const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs",
  validateSearch: (s: Record<string, unknown>): { job?: string } => ({
    job: typeof s.job === "string" ? s.job : undefined,
  }),
  component: JobsPage,
});
const learnRoute = createRoute({ getParentRoute: () => rootRoute, path: "/learn", component: Learn });
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: Settings,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  dashboardRoute,
  modelsRoute,
  modelRoute,
  setupRoute,
  autotuneNewRoute,
  benchmarkNewRoute,
  benchmarksRoute,
  runRoute,
  autotuneRoute,
  jobsRoute,
  learnRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
