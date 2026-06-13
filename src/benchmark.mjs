import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureDirs, loadConfig, saveConfig } from "./config.mjs";
import { backendFor } from "./backends.mjs";
import { pc, createPrompt, renderRows, renderSection } from "./ui.mjs";

const execFileAsync = promisify(execFile);

// ── Shared utilities (matches local-llm-visual-benchmark) ──────────────────

export function slugModelId(modelId, maxLength = 80) {
  const hash = createHash("sha256").update(modelId).digest("hex").slice(0, 10);
  const normalized = modelId.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").replace(/-{2,}/gu, "-");
  if (slug.length > 0 && slug.length <= maxLength && slug === normalized) return slug;
  const baseMaxLength = Math.max(1, maxLength - 11);
  const base = slug.slice(0, baseMaxLength).replace(/^-+|-+$/gu, "") || "model";
  return `${base}-${hash}`;
}

export function createRunId(date = new Date()) {
  return date.toISOString().replace(/:/gu, "-").replace(/\./gu, "-");
}

export function buildToolPrompt(benchmark) {
  return benchmark.prompt;
}

export async function loadBenchmarks(benchDir) {
  const entries = await readdir(benchDir);
  const markdownFiles = entries.filter((f) => f.endsWith(".md")).sort();
  const benchmarks = [];
  for (const filename of markdownFiles) {
    const raw = await readFile(join(benchDir, filename), "utf8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const frontmatter = match ? match[1] : "";
    const content = match ? match[2].trim() : raw.trim();
    let id = filename.replace(/\.md$/u, "");
    let title = id;
    let description = "";
    for (const line of frontmatter.split("\n")) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) {
        const [, key, val] = kv;
        if (key === "id") id = val.trim();
        if (key === "title") title = val.trim();
        if (key === "description") description = val.trim();
      }
    }
    const kind = id === "ab-test-analysis" ? "data-science" : "visual";
    benchmarks.push({ id, title, description, prompt: content, kind });
  }
  return benchmarks;
}

// ── Benchmark repo linking ────────────────────────────────────────────────

const BENCHMARK_REPO = "https://github.com/eeshansrivastava89/local-llm-visual-benchmark.git";

export async function findBenchmarkRepo() {
  const config = await loadConfig();
  if (config.benchmarkRepoPath && existsSync(join(config.benchmarkRepoPath, "benchmarks"))) {
    return config.benchmarkRepoPath;
  }
  return null;
}

export async function linkBenchmarkRepo(prompt) {
  const existing = await findBenchmarkRepo();
  if (existing) return existing;

  const candidates = [
    join(homedir(), "dev", "local-llm-visual-benchmark"),
    join(homedir(), "projects", "local-llm-visual-benchmark"),
    join(homedir(), "local-llm-visual-benchmark"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "benchmarks"))) {
      const config = await loadConfig();
      config.benchmarkRepoPath = candidate;
      await saveConfig(config);
      return candidate;
    }
  }

  console.log(pc.dim("\nThe benchmark gallery needs to be linked to offgrid-ai."));
  console.log(pc.dim("This is the local-llm-visual-benchmark repo that stores prompts and run results.\n"));

  const choice = await prompt.choice("Link benchmark gallery", [
    { value: "clone", label: "Clone from GitHub", hint: "git clone into ~/dev" },
    { value: "manual", label: "Enter path manually", hint: "If you already have it cloned" },
  ], "clone");

  if (choice === "clone") {
    const targetDir = join(homedir(), "dev", "local-llm-visual-benchmark");
    console.log(pc.dim(`\nCloning ${BENCHMARK_REPO}...`));
    try {
      await execFileAsync("git", ["clone", BENCHMARK_REPO, targetDir], { stdio: "pipe" });
      const config = await loadConfig();
      config.benchmarkRepoPath = targetDir;
      await saveConfig(config);
      console.log(pc.green(`✓ Cloned to ${targetDir}`));
      return targetDir;
    } catch (err) {
      console.log(pc.red(`Clone failed: ${err.message}`));
      return null;
    }
  }

  const path = await prompt.text("Path to local-llm-visual-benchmark", "");
  if (!path) return null;
  const resolved = resolve(path.replace(/^~/, homedir()));
  if (!existsSync(join(resolved, "benchmarks"))) {
    console.log(pc.red(`No benchmarks/ directory found at ${resolved}`));
    return null;
  }
  const config = await loadConfig();
  config.benchmarkRepoPath = resolved;
  await saveConfig(config);
  console.log(pc.green(`✓ Linked to ${resolved}`));
  return resolved;
}

// ── Create a benchmark run directory ──────────────────────────────────────

function harnessDisplayName(id) {
  if (id === "pi") return "Pi";
  return String(id).replace(/[-_]+/gu, " ").replace(/\b\w/gu, (char) => char.toUpperCase());
}

function intendedRunnerForProfile(profile) {
  if (!profile) return "your tool";
  const harnessEntries = Object.entries(profile.harnesses ?? {}).filter(([, config]) => config?.enabled !== false);
  const [id] = harnessEntries.find(([key]) => key === "pi") ?? harnessEntries[0] ?? ["pi"];
  return harnessDisplayName(id);
}

function printBenchmarkNextSteps({ repoPath, runDirectory, profile, modelId, runnerLabel }) {
  const runCommand = profile ? `offgrid-ai run ${profile.id}` : null;
  const runnerCommand = runCommand ?? `Open ${runnerLabel} for ${modelId}`;

  console.log("");
  console.log(pc.bold("Next steps"));
  console.log(`  1. Open the gallery. If it is not running: ${pc.cyan(`cd ${repoPath} && npm run dev`)}`);
  console.log(`  2. ${pc.cyan(`cd ${runDirectory}`)}`);
  console.log(`  3. ${pc.cyan(runnerCommand)}, then copy this run's prompt from the gallery and paste it into ${runnerLabel}`);
}

async function prepareBenchmarkRun({ repoPath, benchmark, kind, modelId, modelSource, backendLabel, profile }) {
  const toolPrompt = buildToolPrompt(benchmark);
  const now = new Date();
  const runId = createRunId(now);
  const modelSlug = slugModelId(modelId);
  const runnerLabel = intendedRunnerForProfile(profile);
  const runsDir = join(repoPath, "runs");
  const benchmarkDirectory = join(runsDir, benchmark.id);
  const modelDirectory = join(benchmarkDirectory, modelSlug);
  const runDirectory = join(modelDirectory, runId);

  await mkdir(runDirectory, { recursive: true });

  const isDs = kind === "data-science";
  const baseAssets = {
    metadata: "metadata.json",
    prompt: "prompt.md",
    rawResponse: "response.raw.txt",
    stream: "stream.ndjson",
    stderr: "stderr.log",
  };
  const metadata = {
    schemaVersion: 1,
    kind,
    runId,
    benchmark: { id: benchmark.id, title: benchmark.title, description: benchmark.description, prompt: benchmark.prompt },
    model: { id: modelId, slug: modelSlug },
    status: "prepared",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    preparedAt: now.toISOString(),
    runDirectory,
    assets: isDs
      ? { ...baseAssets, ds: { notebook: "analysis.ipynb", summary: "summary.json", chartDistribution: "chart-distribution.png", chartTreatmentEffect: "chart-treatment-effect.png", chartCompletionRates: "chart-completion-rates.png" } }
      : { ...baseAssets, html: "index.html", preview: "preview.png", video: "preview.webm" },
    runner: {
      mode: modelSource === "cloud" ? "manual" : "external",
      intendedRunner: profile ? runnerLabel : undefined,
      ...(profile?.harnesses?.pi || runnerLabel === "Pi" ? { tool: "pi" } : {}),
      ...(modelSource ? { modelSource } : {}),
      ...(backendLabel ? { backendLabel } : {}),
      ...(profile?.baseUrl ? { baseUrl: profile.baseUrl } : {}),
      model: modelId,
      retries: 0,
      tokenMetrics: {
        reported: false,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      speedMetrics: {
        prefillTokensPerSecond: null,
        generationTokensPerSecond: null,
        ttftMs: null,
        modelLoadMs: null,
        speculativeDecodeAcceptance: null,
        kvCacheTokens: null,
      },
      metricSource: null,
    },
    results: {
      wallClockMs: null,
      agentTurns: 0,
      toolCalls: 0,
      toolResults: 0,
      success: false,
      outputFiles: [],
      perTurn: [],
    },
  };

  await writeFile(join(runDirectory, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n", "utf8");
  await writeFile(join(runDirectory, "prompt.md"), toolPrompt + "\n", "utf8");

  console.log("");
  console.log(pc.green("✓ Run slot prepared"));
  console.log(renderSection("Run", renderRows([
    ["Directory", pc.cyan(runDirectory)],
    ["Benchmark", benchmark.title],
    ["Kind", kind],
    ["Model", pc.bold(modelId)],
    ["Source", backendLabel || modelSource],
  ])));

  printBenchmarkNextSteps({ repoPath, runDirectory, profile, modelId, runnerLabel });

  return runDirectory;
}

// ── Run benchmark in Pi (non-interactive JSON mode) ───────────────────────

const BENCH_COLORS = {
  thinking: pc.magenta,
  text: pc.green,
  tool: pc.yellow,
  toolOutput: pc.dim,
  error: pc.red,
  info: pc.cyan,
  dim: pc.dim,
};

function formatToolCall(toolCall) {
  const path = toolCall.arguments?.path || toolCall.arguments?.file_path || toolCall.arguments?.filename || "";
  const summary = path ? ` → ${path}` : "";
  return `[toolCall] ${toolCall.name}${summary}`;
}

function renderStreamEvent(parsed, state) {
  const type = parsed.type;

  switch (type) {
    case "session":
      console.log(BENCH_COLORS.dim(`[session] ${parsed.id}`));
      break;
    case "agent_start":
      console.log(BENCH_COLORS.dim("[agent_start]"));
      break;
    case "turn_start": {
      state.turn += 1;
      console.log(BENCH_COLORS.info(`\n[turn ${state.turn}]`));
      break;
    }
    case "message_start": {
      const msg = parsed.message;
      if (msg?.role === "assistant" && msg.provider && msg.model) {
        console.log(BENCH_COLORS.info(`[assistant] ${msg.provider}/${msg.model}`));
      }
      break;
    }
    case "message_update": {
      const evt = parsed.assistantMessageEvent;
      if (!evt) return;
      const subtype = String(evt.type ?? "").replace(/_/gu, "");
      if (subtype === "thinkingstart" || subtype === "thinkingdelta") {
        process.stdout.write(BENCH_COLORS.thinking(evt.delta || ""));
      } else if (subtype === "textstart" || subtype === "textdelta") {
        process.stdout.write(BENCH_COLORS.text(evt.delta || ""));
      } else if (subtype === "toolcallstart") {
        console.log(BENCH_COLORS.tool("\n[tool_call_start]"));
      } else if (subtype === "toolcalldelta") {
        process.stdout.write(BENCH_COLORS.tool(evt.delta || ""));
      } else if (subtype === "toolcallend") {
        console.log(BENCH_COLORS.tool("[tool_call_end]"));
      }
      break;
    }
    case "message_end": {
      const msg = parsed.message;
      if (msg?.role === "assistant" && Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === "toolCall") {
            console.log(BENCH_COLORS.tool(`\n${formatToolCall(item)}`));
          }
        }
      }
      break;
    }
    case "tool_execution_start":
      console.log(BENCH_COLORS.tool(`\n[exec] ${parsed.toolName}`));
      break;
    case "tool_execution_update":
      if (parsed.content) {
        process.stdout.write(BENCH_COLORS.toolOutput(parsed.content));
      }
      break;
    case "tool_execution_end":
      console.log(BENCH_COLORS.tool(`[exec done] ${parsed.toolName}`));
      break;
    case "toolResult": {
      const errorFlag = parsed.isError ? BENCH_COLORS.error(" error") : "";
      console.log(BENCH_COLORS.tool(`\n[result] ${parsed.toolName}${errorFlag}`));
      break;
    }
    case "agent_end":
      console.log(BENCH_COLORS.dim("\n[agent_end]"));
      break;
    default:
      break;
  }
}

export function piModelString(profile) {
  return profile.harnesses?.pi?.model ?? `${profile.providerId}/${profile.modelAlias}`;
}

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

  const renderState = { turn: 0 };

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

    renderStreamEvent(parsed, renderState);

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
      runResult.totalTokens += usage.totalTokens ?? 0;
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

  return new Promise((resolve, reject) => {
    child.on("exit", async (code) => {
      if (signal) signal.removeEventListener("abort", abortListener);
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
        reject(new Error("Cancelled by user"));
        return;
      }

      if (runResult.exitCode !== 0) {
        runResult.error = { message: `Pi exited with code ${runResult.exitCode}` };
        reject(new Error(runResult.error.message));
        return;
      }

      resolve(runResult);
    });

    child.on("error", async (err) => {
      if (signal) signal.removeEventListener("abort", abortListener);
      await streamHandle.close();
      await stderrHandle.close();
      runResult.error = { message: err.message };
      reject(err);
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

// ── Backend-aware server speed metrics ───────────────────────────────────

const BENCH_SPEED_PROMPT = "Write a one-sentence summary of machine learning.";

export async function queryServerMetrics(profile) {
  const backend = backendFor(profile.backend);

  if (backend.id === "llama-cpp" || backend.id === "llama-cpp-mtp") {
    return await queryLlamaCppMetrics(profile);
  }
  if (backend.id === "omlx") {
    return await queryOmlxMetrics(profile);
  }
  if (backend.id === "ollama") {
    return await queryOllamaMetrics(profile);
  }

  throw new Error(`Unsupported backend for benchmark speed metrics: ${backend.id}`);
}

async function queryLlamaCppMetrics(profile) {
  const body = {
    model: profile.modelAlias,
    messages: [{ role: "user", content: BENCH_SPEED_PROMPT }],
    stream: false,
  };

  const response = await fetch(profile.baseUrl.replace(/\/$/u, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    throw new Error(`llama.cpp speed query failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const timings = data.timings ?? {};
  const draftN = timings.draft_n;
  const draftAccepted = timings.draft_n_accepted;

  return {
    prefillTokensPerSecond: timings.prompt_per_second ?? null,
    generationTokensPerSecond: timings.predicted_per_second ?? null,
    ttftMs: timings.prompt_ms ?? null,
    modelLoadMs: null,
    speculativeDecodeAcceptance: (draftN && Number.isFinite(draftAccepted) && Number.isFinite(draftN) && draftN > 0)
      ? draftAccepted / draftN
      : null,
    kvCacheTokens: timings.cache_n ?? null,
    metricSource: "llama.cpp /v1/chat/completions timings",
  };
}

async function queryOmlxMetrics(profile) {
  const body = {
    model: profile.modelAlias,
    messages: [{ role: "user", content: BENCH_SPEED_PROMPT }],
    stream: true,
    stream_options: { include_usage: true },
  };

  const response = await fetch(profile.baseUrl.replace(/\/$/u, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    throw new Error(`oMLX speed query failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  let usage = null;
  for (const line of text.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk.usage) {
        usage = chunk.usage;
        break;
      }
    } catch {
      // Ignore malformed SSE chunks.
    }
  }

  if (!usage) {
    throw new Error("oMLX speed query did not return usage in streaming response");
  }

  return {
    prefillTokensPerSecond: usage.prompt_tokens_per_second ?? null,
    generationTokensPerSecond: usage.generation_tokens_per_second ?? null,
    ttftMs: usage.time_to_first_token != null ? usage.time_to_first_token * 1000 : null,
    modelLoadMs: null,
    speculativeDecodeAcceptance: null,
    kvCacheTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
    metricSource: "oMLX /v1/chat/completions streaming include_usage",
  };
}

async function queryOllamaMetrics(profile) {
  const body = {
    model: profile.modelAlias,
    prompt: BENCH_SPEED_PROMPT,
    stream: false,
  };

  const apiBaseUrl = (profile.baseUrl
    ? profile.baseUrl.replace(/\/v1\/?$/u, "")
    : backendFor(profile.backend).apiBaseUrl).replace(/\/$/u, "");

  const response = await fetch(`${apiBaseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    throw new Error(`Ollama speed query failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const promptEvalNs = data.prompt_eval_duration ?? 0;
  const evalNs = data.eval_duration ?? 0;
  const loadNs = data.load_duration ?? 0;

  const promptEvalCount = data.prompt_eval_count ?? 0;
  const evalCount = data.eval_count ?? 0;

  return {
    prefillTokensPerSecond: promptEvalNs > 0 ? (promptEvalCount / (promptEvalNs / 1e9)) : null,
    generationTokensPerSecond: evalNs > 0 ? (evalCount / (evalNs / 1e9)) : null,
    ttftMs: promptEvalNs / 1e6,
    modelLoadMs: loadNs / 1e6,
    speculativeDecodeAcceptance: null,
    kvCacheTokens: null,
    metricSource: "Ollama /api/generate",
  };
}

// ── Benchmark from a selected profile (from model picker) ────────────────

export async function benchmarkForProfile(profile) {
  await ensureDirs();
  const prompt = createPrompt();
  try {
    const repoPath = await linkBenchmarkRepo(prompt);
    if (!repoPath) return;

    const kind = await prompt.choice("Benchmark category", [
      { value: "visual", label: "Visual Benchmark", hint: "HTML/CSS/JS animation benchmarks" },
      { value: "data-science", label: "Data Science", hint: "Analysis and charting benchmarks" },
    ], "visual");

    const benchDir = join(repoPath, "benchmarks");
    const benchmarks = (await loadBenchmarks(benchDir)).filter((b) => b.kind === kind);
    if (benchmarks.length === 0) {
      console.log(pc.yellow(`No ${kind} benchmarks found in ${benchDir}`));
      return;
    }
    const benchmarkId = await prompt.choice("Prompt", benchmarks.map((b) => ({
      value: b.id, label: b.title, hint: b.description || b.id,
    })), benchmarks[0].id);
    const selectedBenchmark = benchmarks.find((b) => b.id === benchmarkId);
    if (!selectedBenchmark) return;

    const modelId = profile.modelAlias;
    const modelSource = profile.providerId === "llama-cpp-mtp" ? "llama-cpp-mtp" : profile.backend === "ollama" ? "ollama" : profile.backend === "omlx" ? "omlx" : "llama-cpp";
    const backendLabel = backendFor(profile.backend).label;

    return await prepareBenchmarkRun({ repoPath, benchmark: selectedBenchmark, kind, modelId, modelSource, backendLabel, profile });
  } finally {
    prompt.close();
  }
}

// ── Standalone benchmark flow (offgrid-ai benchmark) ──────────────────────

export async function benchmarkFlow() {
  await ensureDirs();

  const prompt = createPrompt();
  try {
    const repoPath = await linkBenchmarkRepo(prompt);
    if (!repoPath) return;

    const kind = await prompt.choice("Benchmark category", [
      { value: "visual", label: "Visual Benchmark", hint: "HTML/CSS/JS animation benchmarks" },
      { value: "data-science", label: "Data Science", hint: "Analysis and charting benchmarks" },
    ], "visual");

    const benchDir = join(repoPath, "benchmarks");
    const benchmarks = (await loadBenchmarks(benchDir)).filter((b) => b.kind === kind);
    if (benchmarks.length === 0) {
      console.log(pc.yellow(`No ${kind} benchmarks found in ${benchDir}`));
      return;
    }
    const benchmarkId = await prompt.choice("Prompt", benchmarks.map((b) => ({
      value: b.id, label: b.title, hint: b.description || b.id,
    })), benchmarks[0].id);
    const selectedBenchmark = benchmarks.find((b) => b.id === benchmarkId);
    if (!selectedBenchmark) return;

    const { loadProfiles } = await import("./profiles.mjs");

    const profiles = await loadProfiles();
    const source = await prompt.choice("Model source", [
      { value: "profile", label: "Use existing profile", hint: "Pick a saved offgrid-ai profile" },
      { value: "cloud", label: "Custom / cloud", hint: "Free-form model label for cloud runs" },
    ], "profile");

    let modelId, modelSource, backendLabel, profile;

    if (source === "profile") {
      if (profiles.length === 0) {
        console.log(pc.yellow("No profiles yet. Run: offgrid-ai models"));
        return;
      }
      const profileId = await prompt.choice("Profile", profiles.map((p) => ({
        value: p.id, label: p.label, hint: `${backendFor(p.backend).label} · ${p.modelAlias}`,
      })), profiles[0].id);
      profile = profiles.find((p) => p.id === profileId);
      if (!profile) return;
      modelId = profile.modelAlias;
      modelSource = profile.providerId === "llama-cpp-mtp" ? "llama-cpp-mtp" : profile.backend === "ollama" ? "ollama" : profile.backend === "omlx" ? "omlx" : "llama-cpp";
      backendLabel = backendFor(profile.backend).label;
    } else {
      backendLabel = await prompt.text("Backend label", "cloud");
      modelId = await prompt.text("Model name", "");
      if (!modelId) { console.log(pc.yellow("Model name is required.")); return; }
      modelSource = "cloud";
    }

    return await prepareBenchmarkRun({ repoPath, benchmark: selectedBenchmark, kind, modelId, modelSource, backendLabel, profile });
  } finally {
    prompt.close();
  }
}