import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HUB_DATA } from "@/data/data";

export function Learn() {
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Learn</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        The glass-box concepts behind the knobs. Every setting in this app maps to one of these.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        {HUB_DATA.learn.map((l) => (
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
