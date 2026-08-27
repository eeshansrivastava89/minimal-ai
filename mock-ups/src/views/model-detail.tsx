import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { HUB_DATA } from "@/data/data";
import { fmtBytes, fmtCtx } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BackendBadge, CapabilityBadges, SectionTitle, StatCard } from "@/components/shared";
import { SetupDialog } from "@/components/flows";
import type { Navigate } from "@/App";
import type { Profile } from "@/data/types";

function kvParamsFor(p: Profile) {
  const size = p.modelSizeBytes ?? 0;
  if (p.capabilities.architecture === "gemma4") return { layers: 34, kvHeads: 8, headDim: 256 };
  if (size > 20e9) return { layers: 48, kvHeads: 8, headDim: 128 };
  if (size > 8e9) return { layers: 40, kvHeads: 8, headDim: 128 };
  return { layers: 36, kvHeads: 8, headDim: 128 };
}

// Context × cache heatmap as a shadcn Table with color-intensity cells
// (the "tables heatmap" pattern) — no canvas, no custom component.
function Heatmap({ profile }: { profile: Profile }) {
  const ram = HUB_DATA.hardware.ramBytes;
  const modelBytes = profile.modelSizeBytes ?? 0;
  const { layers, kvHeads, headDim } = kvParamsFor(profile);
  const kvPerTokenF16 = 2 * layers * kvHeads * headDim * 2;

  const ctxs = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
  const precs = [
    { label: "f16", factor: 1 },
    { label: "q8", factor: 0.5 },
    { label: "q4", factor: 0.25 },
  ];

  const currentCtx = (profile.capabilities.contextLength ?? profile.capabilities.ctxSize ?? 131072) as number;
  const currentPrec = profile.flags?.cacheTypeK === "q8_0" ? "q8" : profile.flags?.cacheTypeK === "q4_0" ? "q4" : "f16";

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>KV precision</TableHead>
          {ctxs.map((c) => (
            <TableHead key={c} className="text-right">
              {c >= 1024 ? `${c / 1024}K` : c}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {precs.map((prec) => (
          <TableRow key={prec.label}>
            <TableCell className="font-medium">{prec.label}</TableCell>
            {ctxs.map((c) => {
              const kv = kvPerTokenF16 * c * prec.factor;
              const total = modelBytes + kv;
              const ratio = total / ram;
              const isCurrent = c === currentCtx && prec.label === currentPrec;
              const cls = ratio > 1 ? "bg-destructive/15 text-destructive" : ratio > 0.8 ? "bg-muted" : "bg-muted/40";
              return (
                <TableCell key={c} className={cn("text-right tabular-nums", cls, isCurrent && "ring-2 ring-ring ring-inset")}>
                  {fmtBytes(total)}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ModelDetail({ id, navigate }: { id: string; navigate: Navigate }) {
  const p = HUB_DATA.profiles.find((x) => x.id === id);
  if (!p) {
    return (
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">No profile "{id}".</p>
      </div>
    );
  }

  const caps = p.capabilities;
  const settings = HUB_DATA.omlxModelSettings[p.modelAlias] ?? null;
  const flags = p.flags ?? null;
  const cmd = `minimal-ai run ${p.id}`;

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{p.label}</h1>
        <span className="text-sm text-muted-foreground">{p.modelAlias}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <BackendBadge backend={p.backend} />
        <CapabilityBadges caps={caps} />
      </div>

      <div className="mt-4 grid grid-cols-4 gap-3">
        <StatCard label="Size" value={fmtBytes(p.modelSizeBytes)} />
        <StatCard label="Context" value={fmtCtx((caps.contextLength ?? caps.ctxSize) as number | undefined)} />
        <StatCard label="Architecture" value={String(caps.architecture ?? "—")} />
        <StatCard label="Thinking" value={p.thinkingOff ? "off" : (p.thinkingLevel ?? "default")} />
      </div>

      <SectionTitle title="Context × cache heatmap" meta="estimated memory vs 48 GB" />
      <Card>
        <CardContent className="p-4">
          <Heatmap profile={p} />
          <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
            <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-muted/40 align-[-1px]" />fits</span>
            <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-muted align-[-1px]" />tight</span>
            <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-destructive/15 align-[-1px]" />doesn't fit</span>
            <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm ring-2 ring-ring align-[-1px]" />current config</span>
          </div>
        </CardContent>
      </Card>

      <SectionTitle title="Run in terminal" />
      <Card>
        <CardContent className="flex flex-col gap-2 p-4">
          <p className="text-sm text-muted-foreground">
            Pi sessions stay in the terminal — the hub opens Terminal/iTerm with the command, then hands off.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded border border-border bg-muted px-3 py-1.5 text-sm">{cmd}</code>
            <Button size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(cmd); toast("Copied to clipboard"); }}>
              Copy
            </Button>
            <Button size="sm" onClick={() => toast(`Launching ${p.label} in Terminal — simulated`)}>
              Run
            </Button>
          </div>
        </CardContent>
      </Card>

      {settings && (
        <>
          <SectionTitle title="oMLX settings" meta="applied on the server" />
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableBody>
                  {Object.entries(settings).map(([k, v]) => (
                    <TableRow key={k}>
                      <TableCell className="w-56 text-muted-foreground">{k}</TableCell>
                      <TableCell className="tabular-nums text-foreground">{String(v)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {flags && (
        <>
          <SectionTitle title="llama.cpp flags" />
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableBody>
                  {Object.entries(flags).map(([k, v]) => (
                    <TableRow key={k}>
                      <TableCell className="w-56 text-muted-foreground">{k}</TableCell>
                      <TableCell className="tabular-nums text-foreground">
                        {typeof v === "object" ? JSON.stringify(v) : String(v)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      <div className="mt-4 flex gap-2">
        {p.backend === "omlx" && (
          <Button variant="outline" onClick={() => navigate("autotuneRun", p.modelAlias)}>
            Autotune
          </Button>
        )}
        <Button variant="outline" onClick={() => navigate("benchmark")}>
          Benchmark
        </Button>
        <SetupDialog profile={p} />
        <Button variant="destructive" onClick={() => toast("Remove configuration — simulated")}>
          Remove configuration
        </Button>
      </div>
    </div>
  );
}
