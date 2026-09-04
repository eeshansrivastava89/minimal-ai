import { useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MoonIcon, SunIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Breadcrumbs } from "@/components/breadcrumbs";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
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
import { api } from "@/api";
import { Spinner, StatusBadge } from "@/components/shared";
import { useSidebarActivity } from "@/hooks/use-sidebar-activity";

// Legacy navigation shape the (not yet converted) views speak: view name +
// optional model/tab/run ids. router.tsx's useNav() adapts it to URLs.
export type Navigate = (
  view: string,
  opts?: { modelId?: string; tab?: string; runId?: string; bench?: string; slug?: string }
) => void;

const NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/models", label: "Models" },
  { to: "/benchmarks", label: "Benchmarks" },
  { to: "/autotune", label: "Autotune" },
  { to: "/jobs", label: "Jobs" },
  { to: "/learn", label: "Learn" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const { data: machine } = useQuery({ queryKey: ["machine"], queryFn: api.machine, staleTime: 60_000 });
  const { data: modelsData } = useQuery({ queryKey: ["models"], queryFn: api.models, staleTime: 30_000 });
  const { activity, counts } = useSidebarActivity();
  const backends = modelsData?.backends ?? [];
  const backend = (id: string) => backends.find((b) => b.id === id);
  const omlx = backend("omlx");

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  const activeTop = "/" + (pathname.split("/")[1] ?? "");

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
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV.map((n) => (
                    <SidebarMenuItem key={n.to}>
                      <SidebarMenuButton isActive={activeTop === n.to} asChild>
                        <Link to={n.to}>
                          {activity[n.to] && <Spinner />}
                          {n.label}
                          {n.to === "/models" && modelsData && (
                            <SidebarMenuBadge>{modelsData.models.length}</SidebarMenuBadge>
                          )}
                          {counts[n.to] != null && <SidebarMenuBadge>{counts[n.to]}</SidebarMenuBadge>}
                        </Link>
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
                <span className="text-foreground">
                  {omlx?.up ? `${omlx.modelsLoaded ?? 0}/${omlx.modelsDiscovered ?? "?"} loaded` : "down"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Harness</span>
                <span className="text-foreground">Pi</span>
              </div>
              <div className="flex justify-between">
                <span>v{machine?.version ?? "…"}</span>
                <span>{machine?.devMode ? "dev" : ""}</span>
              </div>
            </div>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset>
          <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background/95 px-6 backdrop-blur">
            <Breadcrumbs />
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              <StatusBadge status={omlx?.up ? "up" : "down"}>oMLX {omlx?.version ?? ""}</StatusBadge>
              <StatusBadge status={backend("ollama")?.up ? "up" : "down"}>Ollama</StatusBadge>
              <StatusBadge status={backend("llama-cpp")?.up ? "up" : "down"}>llama.cpp</StatusBadge>
              <Badge variant="outline">Pi</Badge>
              <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">
                {dark ? <SunIcon /> : <MoonIcon />}
              </Button>
            </div>
          </header>

          <div className="mx-auto w-full max-w-6xl p-6">
            <Outlet />
          </div>
        </SidebarInset>
      </SidebarProvider>
      <Toaster />
    </TooltipProvider>
  );
}
