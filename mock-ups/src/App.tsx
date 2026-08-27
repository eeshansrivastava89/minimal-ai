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
import { Dashboard } from "@/views/dashboard";
import { Models } from "@/views/models";
import { ModelDetail } from "@/views/model-detail";
import { Autotune } from "@/views/autotune";
import { AutotuneNew } from "@/views/autotune-new";
import { AutotuneDetail } from "@/views/autotune-detail";
import { Benchmark } from "@/views/benchmark";
import { BenchmarkNew } from "@/views/benchmark-new";
import { BenchmarkDetail } from "@/views/benchmark-detail";
import { Jobs } from "@/views/jobs";
import { Learn } from "@/views/learn";
import { Settings } from "@/views/settings";

export type Route = { view: string; param?: string };
export type Navigate = (view: string, param?: string) => void;

const NAV = [
  { view: "dashboard", label: "Dashboard" },
  { view: "models", label: "Models", count: HUB_DATA.profiles.length },
  { view: "autotune", label: "Autotune", count: HUB_DATA.autotune.length },
  { view: "benchmark", label: "Benchmark", count: 157 },
  { view: "jobs", label: "Logs & jobs" },
  { view: "learn", label: "Learn" },
  { view: "settings", label: "Settings" },
];

const CRUMBS: Record<string, string> = {
  dashboard: "Dashboard",
  models: "Models",
  model: "Models",
  autotune: "Autotune",
  autotuneNew: "Autotune",
  autotuneRun: "Autotune",
  benchmark: "Benchmark",
  benchmarkNew: "Benchmark",
  benchmarkRun: "Benchmark",
  jobs: "Logs & jobs",
  learn: "Learn",
  settings: "Settings",
};

export default function App() {
  const [route, setRoute] = useState<Route>({ view: "dashboard" });
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const navigate: Navigate = (view, param) => setRoute({ view, param });

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  const activeTop =
    route.view === "model"
      ? "models"
      : route.view === "autotuneNew" || route.view === "autotuneRun"
        ? "autotune"
        : route.view === "benchmarkNew" || route.view === "benchmarkRun"
          ? "benchmark"
          : route.view;

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
            <div className="text-lg font-semibold">{CRUMBS[route.view] ?? "Dashboard"}</div>
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
            {route.view === "model" && <ModelDetail id={route.param ?? ""} navigate={navigate} />}
            {route.view === "autotune" && <Autotune navigate={navigate} />}
            {route.view === "autotuneNew" && <AutotuneNew navigate={navigate} />}
            {route.view === "autotuneRun" && <AutotuneDetail modelId={route.param ?? ""} />}
            {route.view === "benchmark" && <Benchmark navigate={navigate} />}
            {route.view === "benchmarkNew" && <BenchmarkNew navigate={navigate} />}
            {route.view === "benchmarkRun" && <BenchmarkDetail runId={route.param ?? ""} />}
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
