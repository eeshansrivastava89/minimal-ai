import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HUB_DATA } from "@/data/data";
import { fmtBytes, fmtCtx } from "@/lib/format";
import { backendVersion, profileForModel } from "@/lib/lookup";
import { CapabilityBadges, SectionTitle, StatusBadge } from "@/components/shared";
import { DownloadDialog } from "@/components/flows";
import type { Profile } from "@/data/types";
import type { Navigate } from "@/App";

// One row shape for all three backend buckets. A model with a saved profile
// is "ready" and pulls size/context/capabilities from that profile; the rest
// show whatever the backend itself reports and read as "needs setup".
type RowStatus = "ready" | "setup" | "draft" | "helper";

type ModelRow = {
  key: string;
  backend: string;
  title: string;
  subtitle?: string;
  size: string;
  ctx: string;
  caps: Record<string, unknown>;
  status: RowStatus;
  profile?: Profile;
};

function ModelTable({ rows, navigate }: { rows: ModelRow[]; navigate: Navigate }) {
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Context</TableHead>
              <TableHead>Capabilities</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell>
                  <div className="font-medium text-foreground">{r.title}</div>
                  {r.subtitle ? <div className="text-xs text-muted-foreground">{r.subtitle}</div> : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.size}</TableCell>
                <TableCell className="text-right tabular-nums">{r.ctx}</TableCell>
                <TableCell>
                  {r.status === "draft" || r.status === "helper" ? "—" : <CapabilityBadges caps={r.caps} />}
                </TableCell>
                <TableCell>
                  {r.status === "ready" ? (
                    <StatusBadge status="ok">ready</StatusBadge>
                  ) : r.status === "setup" ? (
                    <StatusBadge status="needs-setup">needs setup</StatusBadge>
                  ) : r.status === "draft" ? (
                    <StatusBadge status="active">draft</StatusBadge>
                  ) : (
                    <StatusBadge status="warn">helper</StatusBadge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {r.profile ? (
                    <Button size="sm" variant="outline" onClick={() => navigate("model", { modelId: r.profile!.id })}>
                      Open
                    </Button>
                  ) : r.status === "setup" ? (
                    <Button size="sm" variant="outline" onClick={() => navigate("setupNew", { modelId: r.key, tab: r.backend })}>
                      Set up
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function Models({ navigate }: { navigate: Navigate }) {
  const omlxRows: ModelRow[] = HUB_DATA.omlxModels.map((m) => {
    const profile = profileForModel(m.id);
    const caps = (profile?.capabilities ?? {}) as Record<string, unknown>;
    return {
      key: m.id,
      backend: "omlx",
      title: m.id,
      size: profile ? fmtBytes(profile.modelSizeBytes) : "—",
      ctx: fmtCtx(m.maxModelLen ?? (caps.contextLength as number | undefined)),
      caps,
      status: m.kind === "draft" ? "draft" : m.kind === "helper" ? "helper" : profile ? "ready" : "setup",
      profile,
    };
  });

  const ollamaRows: ModelRow[] = HUB_DATA.ollamaModels.map((m) => {
    const profile = profileForModel(m.id);
    const caps: Record<string, unknown> = Object.fromEntries(m.capabilities.map((c) => [c, true]));
    caps.quant = m.quant;
    return {
      key: m.id,
      backend: "ollama",
      title: m.id,
      size: fmtBytes(m.sizeBytes),
      ctx: profile ? fmtCtx((profile.capabilities.contextLength ?? profile.capabilities.ctxSize) as number | undefined) : "—",
      caps,
      status: profile ? "ready" : "setup",
      profile,
    };
  });

  const ggufRows: ModelRow[] = HUB_DATA.ggufModels.map((g) => {
    const gr = g as Record<string, unknown>;
    const id = String(gr.id);
    const profile = profileForModel(id);
    const caps: Record<string, unknown> = {
      thinking: gr.thinking,
      vision: gr.vision,
      imatrix: gr.imatrix,
      quant: String(gr.quant),
    };
    return {
      key: id,
      backend: "llama-cpp",
      title: String(gr.label),
      subtitle: id,
      size: profile ? fmtBytes(profile.modelSizeBytes) : "—",
      ctx: fmtCtx((gr.ctxSize as number | undefined) ?? (profile?.capabilities.ctxSize as number | undefined)),
      caps,
      status: profile ? "ready" : "setup",
      profile,
    };
  });

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Models</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Every model this machine knows about, bucketed by backend. Models with a saved profile are
        ready to run; the rest need setup.
      </p>

      <SectionTitle
        title="oMLX"
        meta={`${omlxRows.length} model${omlxRows.length === 1 ? "" : "s"} · ${backendVersion("omlx") ?? "not running"}`}
      />
      <ModelTable rows={omlxRows} navigate={navigate} />

      <SectionTitle
        title="Ollama"
        meta={`${ollamaRows.length} model${ollamaRows.length === 1 ? "" : "s"} · ${backendVersion("ollama") ?? "not running"}`}
      />
      <ModelTable rows={ollamaRows} navigate={navigate} />

      <SectionTitle
        title="llama.cpp"
        meta={`${ggufRows.length} model${ggufRows.length === 1 ? "" : "s"} · ${backendVersion("llama-cpp") ?? "not running"}`}
      />
      <ModelTable rows={ggufRows} navigate={navigate} />

      <div className="mt-4 flex gap-2">
        <DownloadDialog />
      </div>
    </div>
  );
}