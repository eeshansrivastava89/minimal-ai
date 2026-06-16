// ── Semantic stream renderer for Pi benchmark output ─────────────────────────

import { relative, basename } from "node:path";
import { pc } from "../ui.mjs";

export const BENCH_COLORS = {
  thinking: pc.magenta,
  text: pc.green,
  tool: pc.yellow,
  success: pc.green,
  warning: pc.yellow,
  toolOutput: pc.dim,
  error: pc.red,
  info: pc.cyan,
  dim: pc.dim,
};

export function formatToolCall(toolCall) {
  const path = toolCall.arguments?.path || toolCall.arguments?.file_path || toolCall.arguments?.filename || "";
  const summary = path ? ` → ${path}` : "";
  return `[toolCall] ${toolCall.name}${summary}`;
}

export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

export function estimatedTokensFromBytes(bytes) {
  return Math.max(1, Math.ceil(bytes / 4));
}

export function clearStatusLine() {
  if (process.stdout.isTTY) {
    process.stdout.write("\r\x1b[K");
  }
}

export function printStatusLine(text) {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r\x1b[K${text}`);
  }
}

export function printFinalLine(text) {
  clearStatusLine();
  console.log(text);
}

export function renderStreamEvent(parsed, state, opts = {}) {
  const verbose = Boolean(opts.verbose);
  const type = parsed.type;

  switch (type) {
    case "session":
      printFinalLine(BENCH_COLORS.info("Pi benchmark started"));
      if (parsed.id) printFinalLine(BENCH_COLORS.dim(`  Session  ${parsed.id}`));
      break;
    case "agent_start":
      break;
    case "turn_start": {
      state.turn += 1;
      state.turnHadToolError = false;
      resetStatus(state, "thinking");
      printFinalLine("");
      printFinalLine(BENCH_COLORS.info(`Turn ${state.turn}`));
      break;
    }
    case "message_start": {
      const msg = parsed.message;
      if (!state.modelPrinted && msg?.role === "assistant" && msg.provider && msg.model) {
        state.modelPrinted = true;
        printFinalLine(BENCH_COLORS.dim(`  Model    ${msg.provider}/${msg.model}`));
      }
      break;
    }
    case "message_update": {
      const evt = parsed.assistantMessageEvent;
      if (!evt) return;
      const subtype = String(evt.type ?? "").replace(/_/gu, "");
      if (subtype === "thinkingstart") {
        resetStatus(state, "thinking");
      } else if (subtype === "thinkingdelta") {
        if (verbose) process.stdout.write(BENCH_COLORS.thinking(evt.delta || ""));
        updateStatusFromDelta(state, evt.delta, "thinking");
      } else if (subtype === "textstart") {
        resetStatus(state, "text");
      } else if (subtype === "textdelta") {
        if (verbose) process.stdout.write(BENCH_COLORS.text(evt.delta || ""));
        updateStatusFromDelta(state, evt.delta, "text");
      } else if (subtype === "toolcallstart") {
        resetStatus(state, "tool");
      } else if (subtype === "toolcalldelta") {
        if (verbose) process.stdout.write(BENCH_COLORS.tool(evt.delta || ""));
        updateStatusFromDelta(state, evt.delta, "tool");
      }
      break;
    }
    case "message_end":
      break;
    case "tool_execution_start": {
      state.activeTool = {
        name: parsed.toolName,
        args: parsed.args ?? {},
        outputText: "",
      };
      resetStatus(state, "exec", parsed.toolName);
      printFinalLine(BENCH_COLORS.tool(formatToolStart(parsed.toolName, parsed.args ?? {}, state)));
      break;
    }
    case "tool_execution_update": {
      const text = toolResultText(parsed.partialResult ?? parsed.result ?? parsed);
      if (text) {
        if (verbose) process.stdout.write(BENCH_COLORS.toolOutput(text));
        if (state.activeTool) state.activeTool.outputText = text;
        updateStatusFromDelta(state, text, "exec");
      }
      break;
    }
    case "tool_execution_end": {
      const lines = formatToolEnd(parsed, state);
      if (parsed.isError) state.turnHadToolError = true;
      for (const line of lines) printFinalLine(line);
      state.activeTool = null;
      resetStatus(state, "idle");
      break;
    }
    case "toolResult": {
      if (parsed.isError) state.turnHadToolError = true;
      const status = parsed.isError ? BENCH_COLORS.error("✗") : BENCH_COLORS.success("✓");
      printFinalLine(`${status} ${parsed.toolName ?? "tool"}`);
      break;
    }
    case "turn_end": {
      const usage = parsed.message?.usage;
      const tokenPart = usage ? ` · ${formatTokens(usage.output ?? usage.totalTokens ?? 0)} tokens` : "";
      const marker = state.turnHadToolError ? BENCH_COLORS.warning("⚠") : BENCH_COLORS.success("✓");
      const suffix = state.turnHadToolError ? " · tool issue" : "";
      printFinalLine(`${marker} turn ${state.turn}${tokenPart}${suffix}`);
      break;
    }
    case "agent_end":
      clearStatusLine();
      break;
    default:
      break;
  }
}

export function resetStatus(state, mode, toolName = null) {
  state.status.mode = mode;
  state.status.toolName = toolName;
  state.status.bytes = 0;
  state.status.tokens = 0;
}

export function updateStatusFromDelta(state, delta, mode = state.status.mode) {
  if (!delta) return;
  state.status.mode = mode;
  state.status.bytes += Buffer.byteLength(delta, "utf8");
  state.status.tokens = estimatedTokensFromBytes(state.status.bytes);
  const label = state.status.toolName ? ` · ${state.status.toolName}` : "";
  const modeLabel = {
    thinking: "thinking…",
    text: "drafting response…",
    tool: "preparing tool…",
    exec: "running tool…",
  }[state.status.mode] ?? "working…";
  const bytes = formatBytes(state.status.bytes);
  const tokens = formatTokens(state.status.tokens);
  printStatusLine(BENCH_COLORS.dim(`Turn ${state.turn} ${modeLabel}${label} · ${bytes} (~${tokens} tokens)`));
}

export function formatToolStart(toolName, args, state) {
  if (toolName === "read") return `→ read ${displayPath(args.path, state)}`;
  if (toolName === "write") {
    const size = args.content ? ` · ${formatBytes(Buffer.byteLength(String(args.content), "utf8"))}` : "";
    return `→ write ${displayPath(args.path, state)}${size}`;
  }
  if (toolName === "edit") {
    const count = Array.isArray(args.edits) ? args.edits.length : 0;
    const suffix = count > 0 ? ` · ${count} replacement${count === 1 ? "" : "s"}` : "";
    return `→ edit ${displayPath(args.path, state)}${suffix}`;
  }
  if (toolName === "bash") return `→ run ${truncateOneLine(args.command ?? "")}`;
  return `→ ${toolName}${compactArgs(args)}`;
}

export function formatToolEnd(parsed, state) {
  const toolName = parsed.toolName ?? state.activeTool?.name ?? "tool";
  const args = parsed.args ?? state.activeTool?.args ?? {};
  const text = toolResultText(parsed.result) || state.activeTool?.outputText || "";
  const marker = parsed.isError ? BENCH_COLORS.error("✗") : BENCH_COLORS.success("✓");

  if (parsed.isError) {
    return [`${marker} ${toolName} failed · ${firstUsefulLine(text)}`];
  }

  if (toolName === "write") return [`${marker} wrote ${displayPath(args.path, state)}${parsedWriteSize(text)}`];
  if (toolName === "read") return [`${marker} read ${displayPath(args.path, state)}${text ? ` · ${formatBytes(Buffer.byteLength(text, "utf8"))}` : ""}`];
  if (toolName === "edit") return [`${marker} edited ${displayPath(args.path, state)}`];
  if (toolName === "bash") return formatBashResult(marker, text);

  const summary = firstUsefulLine(text);
  return [`${marker} ${toolName}${summary ? ` · ${summary}` : ""}`];
}

export function formatBashResult(marker, text) {
  const lines = meaningfulLines(text).slice(0, 2);
  if (lines.length === 0) return [`${marker} command completed`];
  return [`${marker} ${lines[0]}`, ...lines.slice(1).map((line) => BENCH_COLORS.dim(`  ${line}`))];
}

export function parsedWriteSize(text) {
  const match = String(text).match(/Successfully wrote\s+([0-9,]+)\s+bytes/iu);
  if (!match) return "";
  const bytes = Number(match[1].replace(/,/gu, ""));
  return Number.isFinite(bytes) ? ` · ${formatBytes(bytes)}` : "";
}

export function toolResultText(result) {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => typeof item?.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n");
}

export function firstUsefulLine(text) {
  return meaningfulLines(text)[0] ?? "no details";
}

export function meaningfulLines(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\^+$/u.test(line));
  const errorLine = lines.find((line) => /(?:error|exception|failed|not found|command exited with code|validation failed)/iu.test(line));
  if (errorLine) return [errorLine, ...lines.filter((line) => line !== errorLine)];
  return lines;
}

export function displayPath(value, state) {
  if (!value) return "unknown";
  const path = String(value);
  const rel = state.cwd ? relative(state.cwd, path) : path;
  if (rel && !rel.startsWith("..") && rel !== ".") return rel;
  return basename(path) || path;
}

export function compactArgs(args) {
  const entries = Object.entries(args ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) return "";
  return ` · ${truncateOneLine(entries.map(([key, value]) => `${key}=${String(value)}`).join(" "))}`;
}

export function truncateOneLine(value, max = Math.max(60, Math.min(process.stdout.columns ?? 100, 140) - 12)) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}