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

export function DownloadDialog() {
  const [repo, setRepo] = useState("");
  const [quant, setQuant] = useState("Q4_K_M");
  const quants = ["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "BF16"];

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
            Paste a HuggingFace repo. The real hub pulls the GGUF, scans it into the llama.cpp
            bucket, and tracks progress as a job.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Repo</Label>
            <Input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="e.g. unsloth/gemma-4-E2B-it-GGUF"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Quant</Label>
            <Select value={quant} onValueChange={setQuant}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {quants.map((q) => (
                  <SelectItem key={q} value={q}>{q}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            disabled={!repo.trim()}
            onClick={() => {
              toast(`Queued ${repo.trim()} (${quant}) — track it in Jobs`);
              setRepo("");
            }}
          >
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
