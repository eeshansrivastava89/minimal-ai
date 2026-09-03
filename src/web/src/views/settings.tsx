import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { HUB_DATA } from "@/data/data";
import { SectionTitle, StatusBadge } from "@/components/shared";

export function Settings() {
  const cfg = HUB_DATA.config as Record<string, unknown>;
  const srv = HUB_DATA.omlxServerSettings;

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Settings</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Data dir <code className="rounded border border-border bg-muted px-1.5 py-0.5 text-primary">{String(cfg.dataDir)}</code> ·
        benchmark repo <code className="rounded border border-border bg-muted px-1.5 py-0.5 text-primary">{String(cfg.benchmarkRepoPath)}</code>
      </p>

      <SectionTitle title="Chat harness" />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              <TableRow>
                <TableCell>
                  <div className="text-foreground">Pi</div>
                  <div className="text-xs text-muted-foreground">The coding agent minimal-ai launches for chatting. Sessions stay in the terminal.</div>
                </TableCell>
                <TableCell className="text-right">
                  <StatusBadge status="ok">active</StatusBadge>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>
                  <div className="text-foreground">omp</div>
                  <div className="text-xs text-muted-foreground">Alternative chat harness.</div>
                </TableCell>
                <TableCell className="text-right">
                  <StatusBadge status="warn">available</StatusBadge>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SectionTitle title="Discovery paths" meta="where models are scanned" />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {["~/.lmstudio/models", "~/.omlx/models", "~/.cache/huggingface/hub"].map((p) => (
                <TableRow key={p}>
                  <TableCell className="text-foreground">{p}</TableCell>
                  <TableCell className="text-right text-muted-foreground">built-in</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SectionTitle title="oMLX server" meta="~/.omlx/settings.json" />
      <Card>
        <CardContent className="p-4">
          <Accordion type="single" collapsible className="w-full">
            {Object.entries(srv).map(([section, entries]) => (
              <AccordionItem key={section} value={section}>
                <AccordionTrigger className="text-sm font-medium">{section}</AccordionTrigger>
                <AccordionContent>
                  <Table>
                    <TableBody>
                      {Object.entries(entries).map(([k, v]) => (
                        <TableRow key={`${section}.${k}`}>
                          <TableCell className="w-72 text-muted-foreground">{k}</TableCell>
                          <TableCell className="tabular-nums text-foreground">{String(v)}</TableCell>
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

      <SectionTitle title="Feature flags" meta="config.json" />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {["enable_benchmarking", "enable_omlx", "enable_ollama", "lastSeenVersion"].map((k) => (
                <TableRow key={k}>
                  <TableCell className="w-72 text-muted-foreground">{k}</TableCell>
                  <TableCell className="tabular-nums text-foreground">{String(cfg[k])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SectionTitle title="Update" />
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <div className="flex-1">
            <div className="text-foreground">
              Installed <strong>v{HUB_DATA.meta.version}</strong>
            </div>
            <div className="text-xs text-muted-foreground">Updates publish via tag-triggered CI — never locally.</div>
          </div>
          <Button variant="outline">Check for updates</Button>
        </CardContent>
      </Card>
    </div>
  );
}
