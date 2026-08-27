import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HUB_DATA } from "@/data/data";
import { fmtDate, fmtPct, fmtTps } from "@/lib/format";
import { SectionTitle, StatusBadge } from "@/components/shared";
import { cn } from "@/lib/utils";
import type { AutotuneRun } from "@/data/types";

const SPEC_ROWS: [string, string][] = [
  ["none", "none"],
  ["mtp", "MTP (own heads)"],
  ["dflash", "DFlash (z-lab)"],
];
const COL_AXES: [string, string][] = [
  ["off", "off"],
  ["off", "on"],
  ["on", "off"],
  ["on", "on"],
];
const KV_STATES = ["off", "q4", "q8"];

function coord(s: Record<string, unknown>) {
  return {
    spec: s.dflash_enabled ? "dflash" : s.mtp_enabled ? "mtp" : "none",
    think: s.enable_thinking ? "on" : "off",
    ane: s.qwen35_ane_prefill_enabled ? "on" : "off",
    kv: s.turboquant_kv_enabled ? `q${s.turboquant_kv_bits ?? ""}` : "off",
  };
}

function Matrix({ run }: { run: AutotuneRun }) {
  const base = run.configs.find((c) => c.id === "vanilla");
  const thinkLabel = (() => {
    const t = run.configs.find((c) => c.settings.enable_thinking);
    return t?.settings.thinking_budget_tokens ? `think +${t.settings.thinking_budget_tokens}` : "think on";
  })();

  const headers = COL_AXES.map(([think, ane]) => (
    <TableHead key={`${think}-${ane}`} className="text-center text-[10px] uppercase tracking-wide">
      {think === "on" ? <span className="text-foreground">{thinkLabel}</span> : <span className="text-destructive">think off</span>}
      {" · "}
      {ane === "on" ? <span className="text-foreground">ANE on</span> : <span className="text-destructive">ANE off</span>}
    </TableHead>
  ));

  const cellFor = (spec: string, think: string, ane: string, kv: string) => {
    if (spec === "dflash" && (think === "on" || ane === "on")) {
      return { cls: "bg-muted/40 text-muted-foreground", t: "NA", d: null, star: false };
    }
    const c = run.configs.find((x) => {
      const k = coord(x.settings);
      return k.spec === spec && k.think === think && k.ane === ane && k.kv === kv;
    });
    if (!c) return { cls: "text-muted-foreground", t: "–", d: null, star: false };
    const delta = c.id === "vanilla" || !base ? null : ((c.median - base.median) / base.median) * 100;
    const star = c.id === run.recommended;
    return {
      cls: star ? "bg-primary/10 text-primary" : "",
      t: c.median.toFixed(1),
      d: delta == null ? "baseline" : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(0)}%`,
      star,
    };
  };

  return (
    <div className="flex flex-col gap-4">
      {KV_STATES.map((kv) => (
        <div key={kv}>
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">KV-quant: {kv}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">Speculative</TableHead>
                {headers}
              </TableRow>
            </TableHeader>
            <TableBody>
              {SPEC_ROWS.map(([spec, label]) => (
                <TableRow key={spec}>
                  <TableCell className="text-muted-foreground">{label}</TableCell>
                  {COL_AXES.map(([think, ane]) => {
                    const cell = cellFor(spec, think, ane, kv);
                    return (
                      <TableCell key={`${think}-${ane}`} className={cn("text-center tabular-nums", cell.cls)}>
                        {cell.star && <span className="mr-1 text-primary">★</span>}
                        <span className="font-medium">{cell.t}</span>
                        {cell.d && <div className="text-[10px] text-muted-foreground">{cell.d}</div>}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </div>
  );
}

export function AutotuneDetail({ modelId }: { modelId: string }) {
  const a = HUB_DATA.autotune.find((x) => x.modelId === modelId);
  if (!a) {
    return (
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">No sweep for "{modelId}".</p>
      </div>
    );
  }

  const rec = a.configs.find((c) => c.id === a.recommended);
  const base = a.configs.find((c) => c.id === "vanilla");

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">{a.modelId}</h1>
        <span className="text-sm text-muted-foreground">sweep {fmtDate(a.recommendedAt)}</span>
      </div>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{a.reasoning}</p>

      <SectionTitle title="Result matrix" meta="the full config space" />
      <Card>
        <CardContent className="p-4">
          <Matrix run={a} />
        </CardContent>
      </Card>

      <SectionTitle title="Speed sweep" meta="median tps, thinking off vs on" />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Config</TableHead>
                <TableHead>Path</TableHead>
                <TableHead className="text-right">Median tps</TableHead>
                <TableHead className="text-right">MAD</TableHead>
                <TableHead className="text-right">Accept</TableHead>
                <TableHead className="text-right">vs vanilla</TableHead>
                <TableHead className="text-right">Pick</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.configs.map((c) => {
                const isThink = c.id === "thinking" || c.id === "mtp-thinking";
                const delta = c.id === "vanilla" || !base ? null : ((c.median - base.median) / base.median) * 100;
                return (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium text-foreground">{c.label}</TableCell>
                    <TableCell>
                      <StatusBadge status={isThink ? "warn" : "ok"}>{isThink ? "beauty" : "fast"}</StatusBadge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTps(c.median)}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.mad.toFixed(2)}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.accept ? fmtPct(c.accept) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {delta == null ? (
                        "baseline"
                      ) : (
                        <span className={delta >= 0 ? "text-foreground" : "text-destructive"}>
                          {delta >= 0 ? "+" : ""}
                          {delta.toFixed(0)}%
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{c.id === a.recommended ? <span className="text-primary">★</span> : ""}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="px-4 py-2 text-xs text-muted-foreground">
            ≈ a difference is "real" when it's ≥ 2× the within-config noise (MAD). ★ = recommended.
          </p>
        </CardContent>
      </Card>

      <SectionTitle title="Recommended settings" meta="what gets PUT to the server" />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {rec &&
                Object.entries(rec.settings).map(([k, v]) => (
                  <TableRow key={k}>
                    <TableCell className="w-64 text-muted-foreground">{k}</TableCell>
                    <TableCell className="tabular-nums text-foreground">{String(v)}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="mt-4 flex gap-2">
        <Button>Apply to server</Button>
        <Button variant="outline">Discard (restore snapshot)</Button>
      </div>
    </div>
  );
}
