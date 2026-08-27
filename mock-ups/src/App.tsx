import { useState } from "react";
import { MoonIcon, SunIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { HUB_DATA } from "@/data/data";
import { StatusBadge } from "@/components/shared";
import { profileById } from "@/lib/lookup";
import { Dashboard } from "@/views/dashboard";
import { Models } from "@/views/models";
import { ModelDetail } from "@/views/model-detail";
import { AutotuneNew } from "@/views/autotune-new";
import { BenchmarkNew } from "@/views/benchmark-new";
import { BenchmarkDetail } from "@/views/benchmark-detail";
import { Jobs } from "@/views/jobs";
import { Learn } from "@/views/learn";
import { Settings } from "@/views/settings";

// Entity-centric routing: the model is the entity. Configuration, logs,
// autotune sweeps and benchmark runs are children of a model — they live
// under /models/:id/*, never as standalone top-level features.
//
// Mock-up routes (state router, mirrors the real URL scheme):
//   dashboard            /dashboard
//   models               /models
//   model + tab          /models/:id[/configuration|logs|autotune|benchmark]
//   autotuneNew          /models/:id/autotune/new
//   benchmarkNew         /models/:id/benchmark/new
//   benchmarkRun         /models/:id/benchmark/:runId
//   jobs / learn / settings
export type Route = { view: string; modelId?: string; tab?: string; runId?: string };
export type Navigate = (view: string, opts?: { modelId?: string; tab?: string; runId?: string }) => void;

const NAV = [
  { view: "dashboard", label: "Dashboard" },
  { view: "models", label: "Models", count: HUB_DATA.profiles.length },
  { view: "jobs", label: "Jobs" },
  { view: "learn", label: "Learn" },
  { view: "settings", label: "Settings" },
];

const TITLES: Record<string, string> = {
  dashboard: "Dashboard",
  models: "Models",
  jobs: "Jobs",
  learn: "Learn",
  settings: "Settings",
};

// Views that live under a model (highlight "Models" in the sidebar).
const MODEL_VIEWS = new Set(["model", "autotuneNew", "benchmarkNew", "benchmarkRun"]);

export default function App() {
  const [route, setRoute] = useState<Route>({ view: "dashboard" });
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const navigate: Navigate = (view, opts) => setRoute({ view, ...opts });

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  const model = profileById(route.modelId);
  const activeTop = MODEL_VIEWS.has(route.view) ? "models" : route.view;
  const title = model ? model.label : (TITLES[route.view] ?? "Dashboard");

  const o = HUB_DATA.omlxStatus as Record<string, unknown>;
  const omlxUp = o.status === "ok";

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <div className="px-2 py-1">
              <div className="text-base font-semibold">Minimal Intelligence</div>
              <div className="text-xs text-muted-foreground">Local AI · Control surface</div>
            </div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV.map((n) => (
                    <SidebarMenuItem key={n.view}>
                      <SidebarMenuButton isActive={activeTop === n.view} onClick={() => navigate(n.view)}>
                        {n.label}
                        {n.count != null && <SidebarMenuBadge>{n.count}</SidebarMenuBadge>}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <div className="flex flex-col gap-1 px-2 text-xs text-muted-foreground">
              <div className="flex justify-between">
                <span>oMLX</span>
                <span className="text-foreground">{omlxUp ? `${o.modelsLoaded}/${o.modelsDiscovered} loaded` : "down"}</span>
              </div>
              <div className="flex justify-between">
                <span>Harness</span>
                <span className="text-foreground">Pi</span>
              </div>
              <div className="flex justify-between">
                <span>v{HUB_DATA.meta.version}</span>
                <span>mock-up</span>
              </div>
            </div>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset>
          <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background/95 px-6 backdrop-blur">
            <div className="flex items-baseline gap-2">
              {model && (
                <button
                  className="text-lg font-semibold text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => navigate("models")}
                >
                  Models
                </button>
              )}
              {model && <span className="text-muted-foreground">/</span>}
              <div className="text-lg font-semibold">{title}</div>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              <StatusBadge status={omlxUp ? "up" : "down"}>oMLX {String(o.version ?? "")}</StatusBadge>
              <StatusBadge status={HUB_DATA.ollamaModels.length ? "up" : "down"}>Ollama</StatusBadge>
              <StatusBadge status={HUB_DATA.ggufModels.length ? "up" : "down"}>llama.cpp</StatusBadge>
              <Badge variant="outline">Pi</Badge>
              <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">
                {dark ? <SunIcon /> : <MoonIcon />}
              </Button>
            </div>
          </header>

          <div className="mx-auto w-full max-w-6xl p-6">
            {route.view === "dashboard" && <Dashboard navigate={navigate} />}
            {route.view === "models" && <Models navigate={navigate} />}
            {route.view === "model" && (
              <ModelDetail id={route.modelId ?? ""} tab={route.tab ?? "overview"} navigate={navigate} />
            )}
            {route.view === "autotuneNew" && <AutotuneNew modelId={route.modelId ?? ""} navigate={navigate} />}
            {route.view === "benchmarkNew" && <BenchmarkNew modelId={route.modelId ?? ""} navigate={navigate} />}
            {route.view === "benchmarkRun" && (
              <BenchmarkDetail runId={route.runId ?? ""} modelId={route.modelId} navigate={navigate} />
            )}
            {route.view === "jobs" && <Jobs />}
            {route.view === "learn" && <Learn />}
            {route.view === "settings" && <Settings />}
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster />
    </TooltipProvider>
  );
}
