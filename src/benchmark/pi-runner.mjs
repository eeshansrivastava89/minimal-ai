// ── Run benchmark in Pi (non-interactive JSON mode) ───────────────────────────

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  BENCH_COLORS, renderStreamEvent,
  formatToolCall, printFinalLine, stopExecTimer,
} from "./stream-renderer.mjs";
import { piModelString } from "./shared.mjs";

export async function runBenchmarkInPi(profile, runDirectory, { signal } = {}) {
  const model = piModelString(profile);
  const args = ["--model", model, "--mode", "json", "-p", "@prompt.md"];

  const child = spawn("pi", args, {
    cwd: runDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const runResult = {
    model,
    exitCode: null,
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

  let streamBuffer = "";
  let responseBuffer = "";
  let currentTurnStartMs = null;
  let lastTurnEndMs = null;
  let runStartMs = null;
  let firstEventMs = null;
  let lastEventMs = null;
  let cancelled = false;

  const streamPath = join(runDirectory, "stream.ndjson");
  const stderrPath = join(runDirectory, "stderr.log");
  const responsePath = join(runDirectory, "response.raw.txt");

  const streamHandle = await openFileHandle(streamPath, "w");
  const stderrHandle = await openFileHandle(stderrPath, "w");

  const verbose = Boolean(process.env.OFFGRID_BENCHMARK_VERBOSE);
  const renderState = {
    cwd: runDirectory,
    turn: 0,
    turnHadToolError: false,
    modelPrinted: false,
    activeTool: null,
    execTimer: null,
    status: { mode: "idle", toolName: null, bytes: 0, tokens: 0, execStartedAt: null },
  };

  function appendResponse(text) {
    responseBuffer += text;
  }

  function flushResponse() {
    if (responseBuffer) {
      runResult.rawResponseLines.push(responseBuffer);
      responseBuffer = "";
    }
  }

  function updateTimeBounds(timestamp) {
    if (!timestamp) return;
    if (firstEventMs === null) firstEventMs = timestamp;
    lastEventMs = timestamp;
  }

  function beginTurn() {
    runResult.agentTurns += 1;
    currentTurnStartMs = lastTurnEndMs ?? runStartMs ?? null;
  }

  function endTurn(usage, timestamp) {
    const turnEndMs = timestamp ?? null;
    const wallClockMs = currentTurnStartMs && turnEndMs ? turnEndMs - currentTurnStartMs : null;
    runResult.perTurn.push({
      turn: runResult.agentTurns,
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      wallClockMs,
      toolCalls: 0,
    });
    if (turnEndMs) lastTurnEndMs = turnEndMs;
    currentTurnStartMs = null;
  }

  function processLine(line) {
    if (!line.trim()) return;
    streamHandle.write(line + "\n");
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      console.log(BENCH_COLORS.error(`[parse error] ${err.message}`));
      return;
    }

    const timestamp = extractTimestamp(parsed);
    updateTimeBounds(timestamp);

    renderStreamEvent(parsed, renderState, { verbose });

    if (parsed.type === "session" || parsed.type === "agent_start") {
      if (timestamp && runStartMs === null) runStartMs = timestamp;
    }

    if (parsed.type === "turn_start") {
      beginTurn();
    }

    if (parsed.type === "turn_end" && parsed.message?.usage) {
      const usage = parsed.message.usage;
      runResult.promptTokens += usage.input ?? 0;
      runResult.completionTokens += usage.output ?? 0;
      runResult.cacheRead += usage.cacheRead ?? 0;
      runResult.cacheWrite += usage.cacheWrite ?? 0;
      endTurn(usage, timestamp);
    }

    if (parsed.type === "message_update" && parsed.assistantMessageEvent) {
      const evt = parsed.assistantMessageEvent;
      const subtype = String(evt.type ?? "").replace(/_/gu, "");
      if (subtype === "thinkingdelta" || subtype === "textdelta") {
        appendResponse(evt.delta || "");
      }
    }

    if (parsed.type === "message_end" && parsed.message?.role === "assistant") {
      flushResponse();
      const content = parsed.message.content ?? [];
      for (const item of content) {
        if (item.type === "toolCall") {
          runResult.toolCalls += 1;
          appendResponse(`\n${formatToolCall(item)}\n`);
          const currentTurn = runResult.perTurn[runResult.perTurn.length - 1];
          if (currentTurn) currentTurn.toolCalls += 1;
        }
      }
    }

    if (parsed.type === "toolResult") {
      runResult.toolResults += 1;
      const status = parsed.isError ? "error" : "ok";
      appendResponse(`\n[toolResult] ${parsed.toolName} (${status})\n`);
    }

    if (parsed.type === "agent_end") {
      flushResponse();
    }
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    streamBuffer += chunk;
    const lines = streamBuffer.split("\n");
    streamBuffer = lines.pop();
    for (const line of lines) {
      processLine(line);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrHandle.write(chunk);
  });

  const abortListener = () => {
    if (cancelled) return;
    cancelled = true;
    console.log(BENCH_COLORS.error("\n\n[Cancelled by user]"));
    child.kill("SIGTERM");
  };

  if (signal) {
    signal.addEventListener("abort", abortListener);
  }

  return new Promise((resolve) => {
    child.on("exit", async (code) => {
      if (signal) signal.removeEventListener("abort", abortListener);
      stopExecTimer(renderState);
      if (streamBuffer.trim()) {
        processLine(streamBuffer);
      }
      flushResponse();
      await streamHandle.close();
      await stderrHandle.close();
      await writeFile(responsePath, runResult.rawResponseLines.join(""), "utf8");

      runResult.exitCode = code ?? 0;
      if (firstEventMs !== null && lastEventMs !== null) {
        runResult.wallClockMs = lastEventMs - firstEventMs;
      }

      if (cancelled) {
        runResult.error = { message: "Cancelled by user" };
        resolve(runResult);
        return;
      }

      printFinalLine(BENCH_COLORS.info("Pi benchmark finished"));

      if (runResult.exitCode !== 0) {
        runResult.error = { message: `Pi exited with code ${runResult.exitCode}` };
        resolve(runResult);
        return;
      }

      resolve(runResult);
    });

    child.on("error", async (err) => {
      if (signal) signal.removeEventListener("abort", abortListener);
      stopExecTimer(renderState);
      await streamHandle.close();
      await stderrHandle.close();
      runResult.error = { message: err.message };
      resolve(runResult);
    });
  });
}

function extractTimestamp(event) {
  const raw = event?.message?.timestamp ?? event?.timestamp ?? event?.assistantMessageEvent?.partial?.timestamp;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  const iso = event?.message?.createdAt ?? event?.createdAt ?? event?.created_at;
  if (typeof iso === "string") {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function openFileHandle(path, flags) {
  const { open } = await import("node:fs/promises");
  return open(path, flags);
}