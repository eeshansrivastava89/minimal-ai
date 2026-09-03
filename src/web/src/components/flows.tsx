// Settings-type flows as shadcn Dialogs. Main flows (setup, autotune sweep,
// benchmark prepare) are pages, not modals — see views/setup-new.tsx,
// views/autotune-new.tsx and views/benchmark-new.tsx.

import { useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { api } from "@/api";
import { fmtBytes } from "@/lib/format";

export function DownloadDialog() {
  const [repo, setRepo] = useState("");
  const [files, setFiles] = useState<{ path: string; sizeBytes: number }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState("");

  const loadQuants = async () => {
    if (!repo.trim()) return;
    setLoading(true);
    setFiles(null);
    try {
      const { files: quants } = await api.hfQuants(repo.trim());
      setFiles(quants);
      if (quants.length === 1) setFile(quants[0].path);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const download = async () => {
    try {
      await api.enqueueDownload(repo.trim(), file || null);
      toast(`Queued ${repo.trim()} — track it in Jobs`);
      setRepo("");
      setFiles(null);
      setFile("");
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <DownloadIcon className="size-4" />
          Download from HuggingFace
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Download a GGUF from HuggingFace</DialogTitle>
          <DialogDescription>
            Paste a HuggingFace repo, load its quants, pick one. The download runs as a job —
            the model lands in the llama.cpp bucket when it finishes.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Repo</Label>
            <div className="flex gap-2">
              <Input
                className="flex-1"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="e.g. unsloth/gemma-4-E2B-it-GGUF"
              />
              <Button variant="outline" disabled={!repo.trim() || loading} onClick={loadQuants}>
                {loading ? "Loading…" : "Load quants"}
              </Button>
            </div>
          </div>
          {files && (
            <div className="flex flex-col gap-1.5">
              <Label>Quantization</Label>
              {files.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No GGUF files found — the download continues without one only for MLX-style repos.
                </div>
              ) : (
                <Select value={file} onValueChange={setFile}>
                  <SelectTrigger><SelectValue placeholder="Pick a quant" /></SelectTrigger>
                  <SelectContent>
                    {files.map((f) => (
                      <SelectItem key={f.path} value={f.path}>
                        {f.path} · {fmtBytes(f.sizeBytes)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button disabled={!repo.trim()} onClick={download}>
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}