// Settings-type flows as shadcn Dialogs. Main flows (autotune sweep,
// benchmark prepare) are pages, not modals — see views/autotune-new.tsx and
// views/benchmark-new.tsx.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { HUB_DATA } from "@/data/data";
import type { Profile } from "@/data/types";

export function SetupDialog({ profile }: { profile?: Profile }) {
  const [backend, setBackend] = useState(profile?.backend ?? "omlx");
  const [model, setModel] = useState(profile?.modelAlias ?? HUB_DATA.omlxModels[0].id);
  const [ctx, setCtx] = useState("262144");
  const [thinking, setThinking] = useState("high");
  const [mtp, setMtp] = useState(true);
  const [vision, setVision] = useState(true);

  const models = [
    ...HUB_DATA.omlxModels.filter((m) => m.kind === "chat").map((m) => m.id),
    ...HUB_DATA.ollamaModels.map((m) => m.id),
    ...HUB_DATA.ggufModels.map((m) => String(m.id)),
  ];

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant={profile ? "outline" : "default"}>{profile ? "Reconfigure" : "+ Set up a model"}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{profile ? `Reconfigure ${profile.label}` : "Set up a model"}</DialogTitle>
          <DialogDescription>
            Configure and save a profile. The real hub persists to ~/.minimal-ai/profiles and syncs the harness.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Backend</Label>
            <Select value={backend} onValueChange={setBackend}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="omlx">oMLX (managed, :8000)</SelectItem>
                <SelectItem value="ollama">Ollama (managed, :11434)</SelectItem>
                <SelectItem value="llama-cpp">llama.cpp (local GGUF)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Context window</Label>
            <Select value={ctx} onValueChange={setCtx}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["4096", "8192", "16384", "32768", "65536", "131072", "262144"].map((c) => (
                  <SelectItem key={c} value={c}>{Number(c).toLocaleString()}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Thinking level</Label>
            <Select value={thinking} onValueChange={setThinking}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["off", "minimal", "low", "medium", "high", "xhigh"].map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-foreground">MTP (multi-token prediction)</div>
              <div className="text-xs text-muted-foreground">Use the model's own draft heads when compatible.</div>
            </div>
            <Switch checked={mtp} onCheckedChange={setMtp} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-foreground">Vision</div>
              <div className="text-xs text-muted-foreground">Load the multimodal projector for image input.</div>
            </div>
            <Switch checked={vision} onCheckedChange={setVision} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => toast(`Saved profile for ${model} — simulated`)}>Save profile</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
