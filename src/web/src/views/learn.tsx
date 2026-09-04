// Learn — the glass-box concepts behind the knobs. Real prose, static by
// design (the content framework itself is deferred to v4 per the plan).

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// Same entries the old mock-up carried; they document real behavior, and
// every setting in the app maps to one of them.
const ENTRIES = [
  {
    id: "mtp",
    title: "MTP — multi-token prediction",
    tag: "Speculative decoding",
    body: "The model predicts several tokens at once using its own draft heads, then verifies them in one pass. When the guesses are right, you get more tokens per cycle for the same compute. Acceptance rate is the share of guessed tokens that were correct — higher is better, but a low rate wastes work.",
  },
  {
    id: "dflash",
    title: "DFlash — a separate draft model",
    tag: "Speculative decoding",
    body: "A small, fast 'draft' model proposes tokens and the big model checks them. DFlash is oMLX's engine for this. It only helps when the draft is trained on the same distribution as the target — a base draft paired with a personality fine-tune can actually slow things down.",
  },
  {
    id: "thinking-budget",
    title: "Thinking budget",
    tag: "Reasoning",
    body: "Reasoning models emit hidden 'thinking' tokens before answering. A budget caps how many, so a model can't burn minutes reasoning when a quick answer would do. The budget is only enforced with DFlash off — the DFlash path ignores it.",
  },
  {
    id: "kv-quant",
    title: "KV-cache quantization (TurboQuant)",
    tag: "Memory",
    body: "The KV cache stores every token's keys and values so the model doesn't recompute them. Quantizing it (q4/q8) shrinks memory so longer contexts fit — at a small quality cost. Speed/memory win now; long-context quality is the open question.",
  },
  {
    id: "ane-prefill",
    title: "ANE prefill",
    tag: "Apple Silicon",
    body: "Offloads part of prompt prefill to the Neural Engine (ANE) on Apple Silicon. It's a Qwen3.5/3.6/3.8-only feature (the server keys are literally qwen35_*). On other families the row would measure a no-op.",
  },
  {
    id: "context-window",
    title: "Context window",
    tag: "Memory",
    body: "How many tokens the model can 'see' at once. Bigger means longer documents and conversations, but the KV cache grows with it — a 262K window on a 27B model is a real memory commitment. The heatmap shows the trade-off.",
  },
  {
    id: "quantization",
    title: "Quantization",
    tag: "Memory",
    body: "Weights stored at lower precision (4-bit, 8-bit) so a model fits in less RAM. Q4_K_M, nvfp4, OptiQ are all quantization schemes. Lower bits = smaller + faster, with a small quality trade-off.",
  },
];

export function Learn() {
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">Learn</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        The glass-box concepts behind the knobs. Every setting in this app maps to one of these.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        {ENTRIES.map((l) => (
          <Card key={l.id}>
            <CardHeader className="pb-2">
              <Badge variant="secondary" className="w-fit">
                {l.tag}
              </Badge>
              <CardTitle>{l.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <CardDescription className="text-[13px] leading-relaxed">{l.body}</CardDescription>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}