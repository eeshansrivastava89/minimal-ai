import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HUB_DATA } from "@/data/data";
import { fmtDate, fmtTps } from "@/lib/format";
import { SectionTitle, StatusBadge } from "@/components/shared";
import type { Navigate } from "@/App";

export function Autotune({ navigate }: { navigate: Navigate }) {
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Autotune</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Find the fastest oMLX settings for a model. A sweep measures each config against the live server, then
        recommends the winner — with the numbers to back it.
      </p>

      <div className="mt-4">
        <Button onClick={() => navigate("autotuneNew")}>◉ New sweep</Button>
      </div>

      <SectionTitle title="Completed sweeps" meta={`${HUB_DATA.autotune.length} runs`} />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Recommended</TableHead>
                <TableHead className="text-right">Median tps</TableHead>
                <TableHead className="text-right">vs vanilla</TableHead>
                <TableHead className="text-right">Beauty path</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {HUB_DATA.autotune.map((a) => {
                const rec = a.configs.find((c) => c.id === a.recommended);
                const base = a.configs.find((c) => c.id === "vanilla");
                const beauty = a.configs.find((c) => c.id === "mtp-thinking") ?? a.configs.find((c) => c.id === "thinking");
                const delta = rec && base && rec.id !== "vanilla" ? ((rec.median - base.median) / base.median) * 100 : null;
                return (
                  <TableRow key={a.modelId}>
                    <TableCell>
                      <div className="font-medium text-foreground">{a.modelId}</div>
                      <div className="text-xs text-muted-foreground">{fmtDate(a.recommendedAt)}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status="ok">{rec?.label}</StatusBadge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtTps(rec?.median)}</TableCell>
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
                    <TableCell className="text-right tabular-nums">
                      {beauty ? (
                        <>
                          {fmtTps(beauty.median)} <span className="text-muted-foreground">({beauty.label})</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" onClick={() => navigate("autotuneRun", a.modelId)}>
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
