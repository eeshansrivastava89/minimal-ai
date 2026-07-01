// ── Run benchmark via Pi SDK (no subprocess, no NDJSON parsing) ────────────────

import { readFile } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { createCodingTools } from "@earendil-works/pi-coding-agent";
import { pc, formatBytes } from "../ui.mjs";
import { piApiModelId, modelReasoning, modelCompat } from "../harness-pi.mjs";

const C = {
  thinking: pc.magenta,
  text: pc.green,
  tool: pc.yellow,
  success: pc.green,
  warning: pc.yellow,
  error: pc.red,
  info: pc.cyan,
  dim: pc.dim,
};

export async function runBenchmarkInPi(profile, runDirectory, { signal } = {}) {
  const model = buildModel(profile);
  const tools = createCodingTools(runDirectory);
  const systemPrompt = buildSystemPrompt(runDirectory);
  const promptText = await readFile(join(runDirectory, "prompt.md"), "utf8");

  const runResult = {
    model: `${profile.providerId}/${piApiModelId(profile)}`,
    exitCode: 0,
    wallClockMs: null,
    agentTurns: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCalls: 0,
    toolResults: 0,
    perTurn: [],
    rawResponseLines: [],
    error: null,
  };

  const runStartMs = Date.now();
  let currentTurnStartMs = null;
  let lastTurnEndMs = null;
  let turnToolCalls = 0;
  let responseBuffer = "";
  const verbose = Boolean(process.env.OFFGRID_BENCHMARK_VERBOSE);
  const toolArgsByCallId = new Map();

  // ── Status line state ────────────────────────────────────────────────────
  let statusBytes = 0;
  let streamedText = false;
  let execTimer = null;
  let execStartedAt = null;

  function clearStatusLine() {
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
  }

  function printStatusLine(text) {
    if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${text}`);
  }

  function stopExecTimer() {
    if (execTimer) { clearInterval(execTimer); execTimer = null; }
    clearStatusLine();
  }

  function startExecTimer(toolName) {
    stopExecTimer();
    execStartedAt = Date.now();
    if (!process.stdout.isTTY) return;
    const update = () => {
      const elapsed = Math.floor((Date.now() - execStartedAt) / 1000);
      printStatusLine(C.dim(`running ${toolName}… ${elapsed}s`));
    };
    update();
    execTimer = setInterval(update, 1000);
  }

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: profile.reasoning ? "low" : "off",
      tools,
    },
    streamFn: async (mdl, ctx, opts) =>
      streamSimple(mdl, ctx, { ...opts, apiKey: "none" }),
  });

  // ── Event handler: render + collect metrics ──────────────────────────────

  agent.subscribe((event) => {
    try {
      handleEvent(event);
    } catch (err) {
      console.error(C.error(`[renderer error] ${err.message}`));
    }
  });

  function handleEvent(event) {
    switch (event.type) {
      case "turn_start": {
        stopExecTimer();
        runResult.agentTurns += 1;
        currentTurnStartMs = lastTurnEndMs ?? runStartMs;
        turnToolCalls = 0;
        console.log("");
        console.log(C.info(`Turn ${runResult.agentTurns}`));
        break;
      }

      case "message_update": {
        const evt = event.assistantMessageEvent;
        if (!evt) break;
        const sub = String(evt.type ?? "").replace(/_/gu, "");
        if (sub === "thinkingstart") {
          statusBytes = 0;
        } else if (sub === "thinkingdelta") {
          statusBytes += Buffer.byteLength(evt.delta || "", "utf8");
          const tokens = Math.max(1, Math.ceil(statusBytes / 4));
          printStatusLine(C.dim(`thinking… ${formatBytes(statusBytes)} (~${formatTokens(tokens)} tokens)`));
          if (verbose) process.stdout.write(C.thinking(evt.delta || ""));
        } else if (sub === "textstart") {
          clearStatusLine();
          statusBytes = 0;
        } else if (sub === "textdelta") {
          process.stdout.write(evt.delta || "");
          responseBuffer += evt.delta || "";
          streamedText = true;
        } else if (sub === "toolcallstart") {
          clearStatusLine();
        }
        break;
      }

      case "message_end": {
        if (streamedText) {
          console.log("");
          streamedText = false;
        }
        if (event.message?.role === "assistant") {
          for (const item of event.message.content ?? []) {
            if (item.type === "toolCall") {
              runResult.toolCalls += 1;
              turnToolCalls += 1;
              responseBuffer += `\n[toolCall] ${item.name}\n`;
            }
          }
          if (responseBuffer) {
            runResult.rawResponseLines.push(responseBuffer);
            responseBuffer = "";
          }
        }
        break;
      }

      case "tool_execution_start": {
        clearStatusLine();
        toolArgsByCallId.set(event.toolCallId, event.args);
        console.log(C.tool(formatToolStart(event.toolName, event.args, runDirectory)));
        startExecTimer(event.toolName);
        break;
      }

      case "tool_execution_end": {
        stopExecTimer();
        const { toolName, result, isError, toolCallId } = event;
        const args = toolArgsByCallId.get(toolCallId) ?? {};
        const marker = isError ? C.error("✗") : C.success("✓");
        console.log(`${marker} ${toolSummary(toolName, result, isError, args, runDirectory)}`);
        runResult.toolResults += 1;
        break;
      }

      case "turn_end": {
        stopExecTimer();
        clearStatusLine();
        const msg = event.message;
        const isFailure = msg?.role === "assistant" && (msg.stopReason === "error" || msg.stopReason === "aborted");
        const usage = !isFailure ? msg?.usage : null;
        if (usage) {
          runResult.promptTokens += usage.input ?? 0;
          runResult.completionTokens += usage.output ?? 0;
          runResult.cacheRead += usage.cacheRead ?? 0;
          runResult.cacheWrite += usage.cacheWrite ?? 0;
        }
        const turnEndMs = Date.now();
        const wallClockMs = currentTurnStartMs ? turnEndMs - currentTurnStartMs : null;
        runResult.perTurn.push({
          turn: runResult.agentTurns,
          inputTokens: usage?.input ?? 0,
          outputTokens: usage?.output ?? 0,
          cacheRead: usage?.cacheRead ?? 0,
          cacheWrite: usage?.cacheWrite ?? 0,
          wallClockMs,
          toolCalls: turnToolCalls,
        });
        lastTurnEndMs = turnEndMs;
        const tokStr = usage ? ` · ${formatTokens(usage.output ?? 0)} tokens` : "";
        console.log(C.success(`✓ turn ${runResult.agentTurns}${tokStr}`));
        break;
      }

      case "agent_end": {
        if (responseBuffer) {
          runResult.rawResponseLines.push(responseBuffer);
          responseBuffer = "";
        }
        break;
      }
    }
  }

  // ── Wire abort signal ────────────────────────────────────────────────────

  let cancelled = false;
  const abortListener = () => {
    cancelled = true;
    agent.abort();
  };
  if (signal) signal.addEventListener("abort", abortListener, { once: true });

  // ── Run ───────────────────────────────────────────────────────────────────

  try {
    console.log(C.info("Pi benchmark started"));
    console.log(C.dim(`  Model    ${model.provider}/${model.id}`));
    await agent.prompt(promptText);
  } catch (err) {
    if (!cancelled) {
      runResult.error = { message: err.message };
    }
  } finally {
    if (signal) signal.removeEventListener("abort", abortListener);
  }

  if (cancelled) {
    runResult.error = { message: "Cancelled by user" };
  }

  if (!runResult.error && agent.state.errorMessage) {
    runResult.error = { message: agent.state.errorMessage };
  }

  runResult.wallClockMs = Date.now() - runStartMs;
  runResult.totalTokens = runResult.promptTokens + runResult.completionTokens;

  console.log(C.info("Pi benchmark finished"));
  return runResult;
}

// ── Model construction ──────────────────────────────────────────────────────

function buildModel(profile) {
  const reasoning = modelReasoning(profile) ?? false;
  const compat = modelCompat(profile);

  return {
    id: piApiModelId(profile),
    name: profile.label,
    api: "openai-completions",
    provider: profile.providerId,
    baseUrl: profile.baseUrl,
    reasoning,
    input: profile.mmprojPath || profile.capabilities?.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: profile.flags?.ctxSize ?? 32768,
    maxTokens: 16384,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      ...(compat ?? {}),
    },
  };
}

// ── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(cwd) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents (supports text and images)
- bash: Execute shell commands
- edit: Apply targeted text replacements to files
- write: Write content to files (creates or overwrites)

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
- Use the write tool to create files — do not return file contents as chat text
- Use bash to run commands and verify your work

Current date: ${date}
Current working directory: ${cwd.replace(/\\/gu, "/")}`;
}

// ── Rendering helpers ───────────────────────────────────────────────────────

function formatToolStart(toolName, args, cwd) {
  if (toolName === "read") return `→ read ${relPath(args.path, cwd)}`;
  if (toolName === "write") {
    const size = args.content ? ` · ${formatBytes(Buffer.byteLength(String(args.content), "utf8"))}` : "";
    return `→ write ${relPath(args.path, cwd)}${size}`;
  }
  if (toolName === "edit") {
    const count = Array.isArray(args.edits) ? args.edits.length : 0;
    return `→ edit ${relPath(args.path, cwd)}${count > 0 ? ` · ${count} replacement${count === 1 ? "" : "s"}` : ""}`;
  }
  if (toolName === "bash") return `→ run ${truncateOneLine(args.command ?? "")}`;
  return `→ ${toolName}`;
}

function toolSummary(toolName, result, isError, args, cwd) {
  const text = toolResultText(result);
  if (isError) return `${toolName} failed · ${firstLine(text)}`;
  if (toolName === "write") {
    const m = String(text).match(/Successfully wrote\s+([0-9,]+)\s+bytes/iu);
    const size = m ? ` · ${formatBytes(Number(m[1].replace(/,/gu, "")))}` : "";
    return `wrote ${relPath(args.path, cwd)}${size}`;
  }
  if (toolName === "read") return `read ${relPath(args.path, cwd)}${text ? ` · ${formatBytes(Buffer.byteLength(text, "utf8"))}` : ""}`;
  if (toolName === "edit") return `edited ${relPath(args.path, cwd)}`;
  if (toolName === "bash") return firstLine(text) || "command completed";
  return `${toolName}${text ? ` · ${firstLine(text)}` : ""}`;
}

function toolResultText(result) {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => c?.text ?? "").filter(Boolean).join("\n");
}

function firstLine(text) {
  return String(text ?? "").split(/\r?\n/u).map((s) => s.trim()).find(Boolean) ?? "no details";
}

function relPath(path, cwd) {
  if (!path) return "unknown";
  const r = relative(cwd, String(path));
  if (r && !r.startsWith("..") && r !== ".") return r;
  return basename(String(path)) || String(path);
}

function truncateOneLine(value, max = 80) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}