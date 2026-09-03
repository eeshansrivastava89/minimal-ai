import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtBytes, fmtDate } from "@/lib/format";
import { StatusBadge } from "@/components/shared";
import type { LogEntry } from "@/data/types";

// Per-model log files from ~/.minimal-ai/logs — a child of the model.
// Phase 2 lists the files; tailing/streaming content lands with SSE in
// Phase 3.
export function ModelLogs({ logs }: { logs: LogEntry[] | undefined }) {
  if (!logs) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (logs.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No logs for this model yet — they appear after the first launch.
        </CardContent>
      </Card>
    );
  }

  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        Log files for this model under ~/.minimal-ai/logs. Live tailing lands with the job runner.
      </p>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Modified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((l) => (
                <TableRow key={l.name}>
                  <TableCell className="font-mono text-xs text-foreground">{l.name}</TableCell>
                  <TableCell>
                    <StatusBadge status={l.kind === "friendly" ? "ok" : "active"}>{l.kind}</StatusBadge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtBytes(l.sizeBytes)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{fmtDate(l.modifiedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
