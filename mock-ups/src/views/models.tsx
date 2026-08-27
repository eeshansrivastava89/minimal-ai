import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HUB_DATA } from "@/data/data";
import { fmtBytes, fmtCtx } from "@/lib/format";
import { BackendBadge, CapabilityBadges, SectionTitle, StatusBadge } from "@/components/shared";
import { SetupDialog } from "@/components/flows";
import type { Navigate } from "@/App";

export function Models({ navigate }: { navigate: Navigate }) {
  const profiles = HUB_DATA.profiles;
  const hasProfileFor = (modelId: string) =>
    profiles.some((p) => p.modelAlias === modelId || p.omlxModel === modelId);

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Models</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Every model this machine knows about — saved profiles, plus what each backend currently serves.
      </p>

      <SectionTitle title="Saved profiles" meta={`${profiles.length} setups`} />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Backend</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Context</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="font-medium text-foreground">{p.label}</div>
                    <div className="text-xs text-muted-foreground">{p.modelAlias}</div>
                  </TableCell>
                  <TableCell>
                    <BackendBadge backend={p.backend} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtBytes(p.modelSizeBytes)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtCtx((p.capabilities.contextLength ?? p.capabilities.ctxSize) as number | undefined)}
                  </TableCell>
                  <TableCell>
                    <CapabilityBadges caps={p.capabilities} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => navigate("model", { modelId: p.id })}>
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SectionTitle title="oMLX — discovered" meta={`${HUB_DATA.omlxModels.length} models on :8000`} />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Max context</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {HUB_DATA.omlxModels.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium text-foreground">{m.id}</TableCell>
                  <TableCell className="text-right tabular-nums">{m.maxModelLen ? m.maxModelLen.toLocaleString() : "—"}</TableCell>
                  <TableCell>
                    {m.kind === "draft" ? (
                      <StatusBadge status="active">draft</StatusBadge>
                    ) : m.kind === "helper" ? (
                      <StatusBadge status="warn">helper</StatusBadge>
                    ) : (
                      <StatusBadge status="ok">chat</StatusBadge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {hasProfileFor(m.id) ? (
                      <StatusBadge status="ok">saved</StatusBadge>
                    ) : (
                      <Button size="sm" variant="outline">
                        Set up
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SectionTitle title="Ollama — served" meta={`${HUB_DATA.ollamaModels.length} model on :11434`} />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Quant</TableHead>
                <TableHead>Capabilities</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {HUB_DATA.ollamaModels.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium text-foreground">{m.id}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtBytes(m.sizeBytes)}</TableCell>
                  <TableCell>
                    <StatusBadge status="active">{m.quant}</StatusBadge>
                  </TableCell>
                  <TableCell>
                    <CapabilityBadges caps={Object.fromEntries(m.capabilities.map((c) => [c, true]))} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SectionTitle title="llama.cpp — GGUF on disk" />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Quant</TableHead>
                <TableHead className="text-right">Context</TableHead>
                <TableHead>Capabilities</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {HUB_DATA.ggufModels.map((m) => {
                const g = m as Record<string, unknown>;
                return (
                  <TableRow key={String(g.id)}>
                    <TableCell>
                      <div className="font-medium text-foreground">{String(g.label)}</div>
                      <div className="text-xs text-muted-foreground">{String(g.id)}</div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status="active">{String(g.quant)}</StatusBadge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{Number(g.ctxSize).toLocaleString()}</TableCell>
                    <TableCell>
                      <CapabilityBadges caps={{ thinking: g.thinking, vision: g.vision, imatrix: g.imatrix }} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="mt-4 flex gap-2">
        <SetupDialog />
        <Button variant="outline">↓ Download from HuggingFace</Button>
      </div>
    </div>
  );
}
