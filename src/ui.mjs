import pc from "picocolors";
import { fitCheck } from "./hardware.mjs";
import { renderList } from "@eeshans/cli-kit";

export { pc };
export * from "@eeshans/cli-kit";

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function formatCtxLabel(ctx) {
  if (ctx == null) return "—";
  if (ctx >= 1048576) return `${(ctx / 1048576).toFixed(0)}M`;
  if (ctx >= 1024) return `${(ctx / 1024).toFixed(0)}k`;
  return String(ctx);
}

export function fitColor(totalBytes, availableBytes) {
  const { status } = fitCheck(totalBytes, availableBytes);
  if (status === "fits") return pc.green;
  if (status === "tight") return pc.yellow;
  return pc.red;
}

export function humanCapabilitySummary(caps = {}) {
  const parts = [];
  if (caps.thinking) parts.push(pc.magenta("Reasoning"));
  if (caps.vision) parts.push(pc.cyan("Vision"));
  if (caps.mtp) parts.push(pc.blue("MTP"));
  if (caps.qat) parts.push(pc.green("QAT"));
  return parts.length > 0 ? parts.join(" · ") : "General chat";
}

export function renderMemoryEstimate(est, flags) {
  try {
    return renderList([
      ["Estimated total", pc.bold(`~${formatBytes(est.totalBytes)}`)],
      ["Model", formatBytes(est.modelBytes)],
      ...(est.mmprojBytes ? [["Vision projector", formatBytes(est.mmprojBytes)]] : []),
      ...(est.draftBytes ? [["Drafter (MTP)", formatBytes(est.draftBytes)]] : []),
      ["KV cache", est.kvBytes ? `~${formatBytes(est.kvBytes)} (${flags.ctxSize.toLocaleString()} ctx, ${flags.cacheTypeK}/${flags.cacheTypeV})` : "unknown"],
      ...(est.note ? [["Note", pc.yellow(est.note)]] : []),
    ]);
  } catch {
    return "Estimate unavailable for this model.";
  }
}

export function parseOptions(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (item.startsWith("--")) {
      const [key, inlineValue] = item.slice(2).split(/=(.*)/u, 2);
      const next = argv[i + 1];
      if (inlineValue !== undefined) options[key] = inlineValue;
      else if (next && !next.startsWith("-")) { options[key] = next; i += 1; }
      else options[key] = true;
    } else if (/^-[A-Za-z]+$/u.test(item)) {
      for (const key of item.slice(1)) options[key] = true;
    } else {
      positional.push(item);
    }
  }
  return { positional, options };
}

export function startInteractive() {
  if (process.stdin.isTTY) console.clear();
}
