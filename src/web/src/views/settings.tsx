// Settings — live: real config.json values, resolved paths, harnesses, and
// the oMLX app's own settings file, all read from GET /api/settings. No
// update button: v3 ships npm releases via tag-triggered CI, and the update
// flow moves to git in v4 — pretending to check would be a fake.

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { api } from "@/api";
import { SectionTitle, StatusBadge } from "@/components/shared";

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded border border-border bg-muted px-1.5 py-0.5 text-primary">{children}</code>
);

export function Settings() {
  const { data: s, error } = useQuery({ queryKey: ["settings"], queryFn: api.settings });

  if (error) {
    return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  }
  if (!s) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Settings</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Installed <strong className="text-foreground">v{s.version}</strong> · data dir <Code>{s.dataDir}</Code> ·
        benchmark repo{" "}
        {s.benchmarkRepoPath ? (
          <Code>{s.benchmarkRepoPath}</Code>
        ) : (
          "not linked"
        )}
        {!s.benchmarkRepoFound && s.benchmarkRepoPath && (
          <StatusBadge status="failed">path has no runs/</StatusBadge>
        )}
      </p>

      <SectionTitle title="Chat harness" meta={`config.json \`harness\` = ${s.harness}`} />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {s.harnesses.map((h) => (
                <TableRow key={h.id}>
                  <TableCell>
                    <div className="text-foreground">{h.label}</div>
                    <div className="text-xs text-muted-foreground">
                      The agent minimal-ai launches for chat sessions.
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {h.active ? <StatusBadge status="ok">active</StatusBadge> : <StatusBadge status="warn">available</StatusBadge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SectionTitle title="Discovery paths" meta="where models are scanned" />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {s.scanDirs.map((p) => (
                <TableRow key={p}>
                  <TableCell className="text-foreground">{p}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SectionTitle title="config.json" meta="read-only — edit the file directly" />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              <TableRow>
                <TableCell className="w-72 text-muted-foreground">modelScanDirs (extra)</TableCell>
                <TableCell className="text-foreground">{s.config.modelScanDirs.join(", ") || "—"}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-muted-foreground">binaryOverrides</TableCell>
                <TableCell className="text-foreground">
                  {Object.keys(s.config.binaryOverrides).join(", ") || "—"}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-muted-foreground">lastSeenVersion</TableCell>
                <TableCell className="text-foreground">{s.config.lastSeenVersion ?? "—"}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-muted-foreground">HF cache</TableCell>
                <TableCell className="text-foreground">{s.hfCacheDir}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-muted-foreground">logs</TableCell>
                <TableCell className="text-foreground">{s.logDir}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {s.omlxServerSettings && (
        <>
          <SectionTitle title="oMLX server" meta="~/.omlx/settings.json (read-only)" />
          <Card>
            <CardContent className="p-4">
              <Accordion type="single" collapsible className="w-full">
                {Object.entries(s.omlxServerSettings)
                  .filter(([, v]) => v && typeof v === "object")
                  .map(([section, entries]) => (
                    <AccordionItem key={section} value={section}>
                      <AccordionTrigger className="text-sm font-medium">{section}</AccordionTrigger>
                      <AccordionContent>
                        <Table>
                          <TableBody>
                            {Object.entries(entries as Record<string, unknown>).map(([k, v]) => (
                              <TableRow key={`${section}.${k}`}>
                                <TableCell className="w-72 text-muted-foreground">{k}</TableCell>
                                <TableCell className="tabular-nums text-foreground">
                                  {typeof v === "object" ? JSON.stringify(v) : String(v)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </AccordionContent>
                    </AccordionItem>
                  ))}
              </Accordion>
            </CardContent>
          </Card>
        </>
      )}

      <SectionTitle title="Update" />
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Releases publish via git tags through CI — never locally. To update a clone: <Code>git pull</Code> and
          check the changelog for the new tag. (The in-app update check moves from the npm registry to git in v4.)
        </CardContent>
      </Card>
    </div>
  );
}