import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SectionTitle, StatusBadge } from "@/components/shared";

const SEED_LOG: [string, string][] = [
  ["info", "oMLX 0.6.3rc3 starting on 127.0.0.1:8000"],
  ["info", "custom kernels: bonsai ✓ glm_moe_dsa ✓ minimax_m3 ✓ qwen35_prefill ✓"],
  ["info", "ANE prefill patch available (configured_models: 0)"],
  ["dim", "discovered 7 models · default Qwen3.5-9B-MTPLX-Optimized-Speed"],
  ["ok", "server ready — 0 loaded, 32.55 GB max model memory"],
];

export function Jobs() {
  const [lines, setLines] = useState(SEED_LOG);
  const [job, setJob] = useState<{ pct: number; done: boolean } | null>(null);

  const log = (kind: string, msg: string) => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLines((prev) => [...prev, [kind, `${ts}  ${msg}`]]);
  };

  const simulateJob = () => {
    setJob({ pct: 0, done: false });
    let pct = 0;
    const iv = setInterval(() => {
      pct += 7;
      if (pct >= 100) {
        clearInterval(iv);
        setJob({ pct: 100, done: true });
        log("ok", "sweep complete — recommendation ready");
      } else {
        setJob({ pct, done: false });
      }
    }, 400);
  };

  const simulateLog = () => {
    const extra: [string, string][] = [
      ["dim", "Chat completion: model=Qwen3.5-9B-MTPLX-Optimized-Speed, 142 tokens in 3.7s (38.5 tok/s), prompt: 170, finish_reason=length"],
      ["dim", "MTP[0] finish=length tokens=142 cycles=77 tok/cycle=1.84 accept=63/112 (56.2%)"],
      ["ok", "Chat completion: model=Qwen3.5-9B-MTPLX-Optimized-Speed, 300 tokens in 6.3s (47.9 tok/s)"],
    ];
    extra.forEach(([k, m], i) => setTimeout(() => log(k, m), i * 500));
  };

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Logs &amp; jobs</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        One runner for everything long-running — downloads, sweeps, captures, agent launches. Progress streams over SSE.
      </p>

      <SectionTitle title="Active jobs" />
      <Card>
        <CardContent className="p-4">
          {job ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-foreground">Autotune sweep — Qwen3.5-9B-MTPLX-Optimized-Speed</span>
                <span className="ml-auto">
                  <StatusBadge status={job.done ? "ok" : "running"}>{job.done ? "done" : "running"}</StatusBadge>
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {job.done ? "sweep complete — recommendation ready" : `config 3/8 · MTP on · measuring warm runs`}
              </div>
              <Progress value={job.pct} />
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No active jobs. Start a sweep, download, or capture to see it here.
            </div>
          )}
        </CardContent>
      </Card>

      <SectionTitle title="Server log" meta="~/.omlx/logs/server.log" />
      <Card>
        <CardContent className="p-0">
          <ScrollArea className="h-80">
            <div className="p-4 font-mono text-xs leading-relaxed">
              {lines.map(([kind, msg], i) => (
                <div
                  key={i}
                  className={
                    kind === "ok"
                      ? "text-foreground"
                      : kind === "warn"
                        ? "text-muted-foreground"
                        : kind === "err"
                          ? "text-destructive"
                          : "text-muted-foreground"
                  }
                >
                  {msg}
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <div className="mt-4 flex gap-2">
        <Button variant="outline" onClick={simulateJob}>
          Simulate a job
        </Button>
        <Button variant="outline" onClick={simulateLog}>
          Simulate log activity
        </Button>
      </div>
    </div>
  );
}
