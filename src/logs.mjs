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

const LOG_LINE_PATTERNS = [
  { test: (l) => l.includes("ctx_other") || l.includes("failed to measure draft model memory"), tag: "[mtp]", color: pc.dim },
  { test: (l) => l.includes("error") || l.includes("failed"), tag: "[error]", color: pc.red },
  { test: (l) => l.includes("listening") || l.includes("http server"), tag: "[server]", color: pc.green },
  { test: (l) => l.includes("llm_load") || l.includes("load_model") || l.includes("loading model"), tag: "[load]", color: pc.cyan },
  { test: (l) => l.includes("mmproj"), tag: "[vision]", color: pc.cyan },
  { test: (l) => l.includes("prompt eval") || l.includes("prompt eval time"), tag: "[timing]", color: pc.green },
  { test: (l) => l.includes("eval time") || l.includes("generation"), tag: "[timing]", color: pc.green },
  { test: (l) => l.includes("slot") && l.includes("launch_slot"), tag: "[request]", color: pc.cyan },
];

function friendlyLine(line) {
  const lower = line.toLowerCase();
  const trimmed = line.trim();
  for (const { test, tag, color } of LOG_LINE_PATTERNS) {
    if (test(lower)) return color(`${tag} ${trimmed}`);
  }
  return null;
}