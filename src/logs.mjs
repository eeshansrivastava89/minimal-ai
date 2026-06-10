import { existsSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import pc from "picocolors";
import { stripVTControlCharacters } from "node:util";

export function tailFriendly(rawLogPath, friendlyLogPath) {
  let offset = existsSync(rawLogPath) ? statSync(rawLogPath).size : 0;
  let stopped = false;
  const seen = new Set();
  const timer = setInterval(async () => {
    try {
      if (stopped || !existsSync(rawLogPath)) return;
      const size = statSync(rawLogPath).size;
      if (size <= offset) return;
      const stream = createReadStream(rawLogPath, { start: offset, end: size - 1, encoding: "utf8" });
      offset = size;
      let text = "";
      for await (const chunk of stream) text += chunk;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        const friendly = friendlyLine(line);
        if (!friendly || seen.has(friendly)) continue;
        seen.add(friendly);
        console.log(friendly);
        await appendFile(friendlyLogPath, stripVTControlCharacters(friendly) + "\n", "utf8");
      }
    } catch { /* friendly logging must never crash */ }
  }, 300);
  return { stop() { stopped = true; clearInterval(timer); } };
}

function friendlyLine(line) {
  const lower = line.toLowerCase();
  const trimmed = line.trim();
  // Known-harmless errors during MTP memory estimation — llama.cpp tries to measure
  // the draft model's memory usage before allocating the shared KV cache, which
  // fails because the assistant architecture needs the trunk context. This is
  // expected and the server proceeds to load the draft model correctly afterward.
  if (lower.includes("ctx_other") || lower.includes("failed to measure draft model memory")) {
    return pc.dim(`[mtp] ${trimmed}`);
  }
  if (lower.includes("error") || lower.includes("failed")) return pc.red(`[error] ${trimmed}`);
  if (lower.includes("listening") || lower.includes("http server")) return pc.green(`[server] ${trimmed}`);
  if (lower.includes("llm_load") || lower.includes("load_model") || lower.includes("loading model")) return pc.cyan(`[load] ${trimmed}`);
  if (lower.includes("mmproj")) return pc.cyan(`[vision] ${trimmed}`);
  if (lower.includes("prompt eval") || lower.includes("prompt eval time")) return pc.green(`[timing] ${trimmed}`);
  if (lower.includes("eval time") || lower.includes("generation")) return pc.green(`[timing] ${trimmed}`);
  if (lower.includes("slot") && lower.includes("launch_slot")) return pc.cyan(`[request] ${trimmed}`);
  return null;
}