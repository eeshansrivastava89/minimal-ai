import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fmtBytes } from "@/lib/format";
import type { Profile } from "@/data/types";

// Per-model log lines — a child of the model, filtered out of the backend
// server log. Static sample lines for the mock-up.
export function ModelLogs({ profile }: { profile: Profile }) {
  const m = profile.modelAlias;
  const lines: [string, string][] = [
    ["ok", `loaded ${m} (${fmtBytes(profile.modelSizeBytes)})`],
    ["dim", `Chat completion: model=${m}, 142 tokens in 3.7s (38.5 tok/s), prompt: 170, finish_reason=length`],
    ["dim", `Chat completion: model=${m}, 300 tokens in 6.3s (47.9 tok/s), prompt: 24, finish_reason=stop`],
    ["dim", `Chat completion: model=${m}, 1024 tokens in 21.8s (47.0 tok/s), prompt: 612, finish_reason=length`],
    ["ok", `unloaded ${m} (idle timeout)`],
  ];

  return (
    <div>
      <p className="mb-3 text-sm text-muted-foreground">
        Lines for this model from the backend server log. The full stream lives under Jobs.
      </p>
      <Card>
        <CardContent className="p-0">
          <ScrollArea className="h-80">
            <div className="p-4 font-mono text-xs leading-relaxed">
              {lines.map(([kind, msg], i) => (
                <div key={i} className={kind === "ok" ? "text-foreground" : "text-muted-foreground"}>
                  {msg}
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
