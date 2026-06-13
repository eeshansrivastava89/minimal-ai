# Benchmark Automation Plan

Last updated: 2026-06-13

---

## 1. Product Vision

offgrid-ai is a privacy-first CLI for running local LLMs — discover, configure, run, benchmark.

The **benchmark** feature exists so users can measure how well a local model executes real-world creative and data-science tasks. Today that workflow is too manual: prepare a run directory, then copy the prompt, launch Pi, paste it in, wait, and read server logs for speed numbers.

The goal of benchmark automation is to reduce that to a single action:

> **User selects a profile and a benchmark → offgrid-ai runs it end-to-end → metrics are displayed immediately and saved for the gallery.**

Longer term, the metrics produced by offgrid-ai feed directly into `local-llm-visual-benchmark` so the web gallery can compare models across runs. That means the data contract — the shape of `metadata.json` and the run directory — is as important as the automation itself. This plan defines both.

### What success looks like

- A non-technical user can run a benchmark with one menu selection.
- The user sees what the model is doing in real time: thinking, text, and tool calls stream by as they happen.
- At the end, the terminal shows a beautiful, well-aligned summary table with all metrics: wall-clock time, turns, tokens, tool calls, output files, and server speed metrics. Per-turn detail is saved in `metadata.json` but not shown in the terminal.
- Every run writes a stable `metadata.json` that the gallery can consume later without rework.
- Failed runs are preserved for debugging, not deleted.

---

## 2. High-Level Architecture

### 2.1 Flow

```
User selects "Run Benchmark"
        │
        ▼
  Prepare run directory
  Write prompt.md, metadata.json
        │
        ▼
  Ensure model server is running
  (start llama.cpp if needed; fail fast on Ollama/oMLX)
        │
        ▼
  Spawn: pi --model <provider/model> --mode json -p @prompt.md
  cwd = run directory
        │
        ▼
  Parse JSON stream in real-time ─────────────────────────────┐
    • Render thinking/text/tool calls (visibility)             │
    • Accumulate per-turn token counts                         │ Pi stream
    • Record per-turn wall-clock durations                     │
    • Detect agent_end (completion)                            │
        │                                                      │
        ▼                                                      │
  After Pi exits:                                               │
    a. Query model server for raw speed metrics                 │
    b. Check for expected output files (success detection)     │
    c. Update metadata.json                                     │
        │                                                      │
        ▼                                                      │
  Display summary                                               │
```

### 2.2 Execution engine: Pi `--mode json -p`

We use Pi in non-interactive JSON mode because it tests the real-world tool-use path. Raw HTTP would only test text generation and would bypass the `write` tool loop that many benchmarks rely on.

Command shape:

```bash
pi --model <provider/model> --mode json -p @prompt.md
```

Requirements:

- `cwd` must be the run directory so the `write` tool creates files there.
- stdout is a JSONL stream; stderr has startup noise and should be captured separately.
- `agent_end` signals completion; a non-zero exit code means failure.

### 2.3 Two complementary data sources

| Metric category | Source |
|---|---|
| Wall-clock time | Pi stream timestamps |
| Agent turns | `turn_start` / `turn_end` count |
| Per-turn input tokens | `turn_end` `usage.input` |
| Per-turn output tokens | `turn_end` `usage.output` |
| Total cache read/write | `turn_end` `usage.cacheRead` / `usage.cacheWrite` |
| Tool calls | `toolCall` objects inside assistant `message_end` |
| Tool results | `toolResult` / `tool_execution_*` events |
| Output files | Disk check after Pi exits |
| Prefill speed (tok/s) | Model server query |
| Generation speed (tok/s) | Model server query |
| Time to first token (TTFT) | Model server query |
| Speculative decode acceptance | Model server query (llama.cpp only) |
| KV cache hit tokens | Model server query |
| Model load time | Model server query (Ollama only) |

The Pi stream provides **agent-level** metrics. The model server provides **raw speed** metrics. Both are needed for a complete picture.

### 2.4 Pi stream event shapes

Pi 0.79.2 emits a JSON object per line. The schema we rely on is:

| Event | What we extract |
|---|---|
| `session` | `id`, `cwd` |
| `agent_start` / `agent_end` | Run boundaries |
| `turn_start` / `turn_end` | Turn count, per-turn `usage` |
| `message_start` / `message_end` | `role`, `provider`, `model`, tool calls in `content` |
| `message_update` | Streaming deltas via `assistantMessageEvent.type` (`thinking_delta`, `text_delta`, `toolcall_delta`) |
| `tool_execution_start` / `tool_execution_end` / `tool_execution_update` | Tool lifecycle and streamed tool output |
| `toolResult` | Final tool result and error status |

Important: Pi uses different event subtype spellings in different runs (`toolcall_*` vs `tool_call_*`). The parser must accept both.

### 2.5 Model-server speed metrics per backend

#### llama.cpp — non-streaming `/v1/chat/completions`

Response contains:

```json
{
  "timings": {
    "prompt_n": 17,
    "prompt_ms": 163.875,
    "prompt_per_second": 103.74,
    "predicted_n": 50,
    "predicted_ms": 1062.091,
    "predicted_per_second": 47.08,
    "draft_n": 57,
    "draft_n_accepted": 33,
    "cache_n": 0
  }
}
```

Extracted metrics:

| Metric | Field / calculation |
|---|---|
| Prefill tok/s | `timings.prompt_per_second` |
| Generation tok/s | `timings.predicted_per_second` |
| TTFT (ms) | `timings.prompt_ms` |
| Speculative decode acceptance | `timings.draft_n_accepted / timings.draft_n` |
| KV cache tokens | `timings.cache_n` |
| Model load time | ❌ not available |

#### oMLX — streaming `/v1/chat/completions`

Non-streaming responses only include `total_time`. Use streaming with `stream_options: { "include_usage": true }` and read the final SSE chunk:

```json
{
  "usage": {
    "prompt_tokens": 19,
    "completion_tokens": 9,
    "prompt_tokens_per_second": 40.9,
    "generation_tokens_per_second": 62.75,
    "time_to_first_token": 0.46,
    "prompt_eval_duration": 0.46,
    "generation_duration": 0.11,
    "total_time": 0.58,
    "prompt_tokens_details": { "cached_tokens": 0 }
  }
}
```

Extracted metrics:

| Metric | Field / calculation |
|---|---|
| Prefill tok/s | `usage.prompt_tokens_per_second` |
| Generation tok/s | `usage.generation_tokens_per_second` |
| TTFT (ms) | `usage.time_to_first_token * 1000` |
| Speculative decode acceptance | ❌ not available |
| KV cache tokens | `usage.prompt_tokens_details.cached_tokens` |
| Model load time | ❌ not available |

#### Ollama — native `/api/generate`

The OpenAI-compatible endpoint does **not** expose speed metrics. Use the native endpoint with `"stream": false`:

```json
{
  "total_duration": 524008875,
  "load_duration": 255851750,
  "prompt_eval_count": 23,
  "prompt_eval_duration": 127919000,
  "eval_count": 9,
  "eval_duration": 139243000
}
```

All durations are nanoseconds.

Extracted metrics:

| Metric | Field / calculation |
|---|---|
| Prefill tok/s | `prompt_eval_count / (prompt_eval_duration / 1e9)` |
| Generation tok/s | `eval_count / (eval_duration / 1e9)` |
| TTFT (ms) | `prompt_eval_duration / 1e6` |
| Speculative decode acceptance | ❌ not available |
| KV cache tokens | ❌ not available |
| Model load time (ms) | `load_duration / 1e6` |

### 2.6 Backend speed metric summary

| Metric | llama.cpp | oMLX | Ollama |
|---|---|---|---|
| Endpoint | `/v1/chat/completions` non-stream | `/v1/chat/completions` streaming + `include_usage` | `/api/generate` non-stream |
| Prefill tok/s | `timings.prompt_per_second` | `usage.prompt_tokens_per_second` | `prompt_eval_count / prompt_eval_duration` |
| Generation tok/s | `timings.predicted_per_second` | `usage.generation_tokens_per_second` | `eval_count / eval_duration` |
| TTFT | `timings.prompt_ms` | `usage.time_to_first_token` | `prompt_eval_duration` |
| Speculative decode | `draft_n_accepted / draft_n` | ❌ | ❌ |
| KV cache tokens | `timings.cache_n` | `usage.prompt_tokens_details.cached_tokens` | ❌ |
| Model load time | ❌ | ❌ | `load_duration` |

### 2.7 Result schema in `metadata.json`

We extend the existing `metadata.json` produced by `prepareBenchmarkRun()` so it remains compatible with `local-llm-visual-benchmark/src/lib/types.ts`. New fields are additive.

Completed run example:

```json
{
  "schemaVersion": 1,
  "kind": "visual",
  "status": "completed",
  "runDirectory": "/.../runs/solar-system/gemma-4-.../2026-...",
  "createdAt": "2026-06-13T...",
  "updatedAt": "2026-06-13T...",
  "preparedAt": "2026-06-13T...",
  "completedAt": "2026-06-13T...",
  "assets": {
    "metadata": "metadata.json",
    "prompt": "prompt.md",
    "html": "index.html",
    "preview": "preview.png",
    "video": "preview.webm",
    "rawResponse": "response.raw.txt",
    "stream": "stream.ndjson",
    "stderr": "stderr.log"
  },
  "runner": {
    "mode": "external",
    "tool": "pi",
    "modelSource": "llama-cpp",
    "backendLabel": "llama.cpp",
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "Qwopus3.6-35B-A3B-v1-Q4_K_S",
    "retries": 0,
    "tokenMetrics": {
      "reported": true,
      "promptTokens": 5820,
      "completionTokens": 134,
      "totalTokens": 5954
    },
    "speedMetrics": {
      "prefillTokensPerSecond": 87.6,
      "generationTokensPerSecond": 54.8,
      "ttftMs": 163.9,
      "modelLoadMs": null,
      "speculativeDecodeAcceptance": 0.58,
      "kvCacheTokens": 0
    },
    "metricSource": "llama.cpp /v1/chat/completions timings"
  },
  "results": {
    "wallClockMs": 11600,
    "agentTurns": 2,
    "toolCalls": 1,
    "toolResults": 1,
    "success": true,
    "outputFiles": ["index.html", "preview.png"],
    "perTurn": [
      {
        "turn": 1,
        "inputTokens": 3353,
        "outputTokens": 51,
        "toolCalls": 1,
        "wallClockMs": 3200
      }
    ]
  }
}
```

Failed run example:

```json
{
  "status": "failed",
  "updatedAt": "2026-06-13T...",
  "failedAt": "2026-06-13T...",
  "runner": {
    "tokenMetrics": { "reported": false }
  },
  "results": {
    "success": false,
    "outputFiles": []
  },
  "error": {
    "message": "pi exited with code 1",
    "stack": "..."
  }
}
```

### 2.8 Success criteria per benchmark kind

| Kind | Required output file | Optional assets |
|---|---|---|
| `visual` | `index.html` exists and non-empty | `preview.png`, `preview.webm`, `preview.mp4` |
| `data-science` | `analysis.ipynb` exists and non-empty | `summary.json`, `chart-*.png` |

`results.success` is `true` if the required file exists; `false` otherwise. `results.outputFiles` lists every file actually found in the run directory.

### 2.9 Terminal summary table

At the end of every run, offgrid-ai prints a beautiful, well-aligned table. It shows totals only — no per-turn breakdown. Per-turn detail is stored in `metadata.json` for the gallery.

Example:

```text
┌─ Benchmark Result ──────────────┬─ Value ───────┐
│ Status                            │ completed     │
│ Duration                          │ 11.6 s        │
│ Agent turns                       │ 2             │
│ Input tokens                      │ 5,820         │
│ Output tokens                     │ 134           │
│ Cache read                        │ 0             │
│ Cache write                       │ 0             │
│ Tool calls                        │ 1             │
│ Tool results                      │ 1             │
│ Output files                      │ index.html    │
├─ Speed Metrics ───────────────────┼───────────────┤
│ Prefill tok/s                     │ 87.6          │
│ Generation tok/s                  │ 54.8          │
│ TTFT                              │ 164 ms        │
│ Speculative decode acceptance     │ 58 %          │
│ KV cache tokens                   │ 0             │
│ Model load time                   │ —             │
│ Metric source                     │ llama.cpp     │
└───────────────────────────────────┴───────────────┘
```

Unavailable fields show `—`. On failure, the table shows `Status: failed` and the `Error:` message instead of speed metrics.

---

### 2.10 Key design considerations

- **Re-use existing code.** Use `src/harness-pi.mjs::hasPi()`, `syncPiConfig()`, and `hasPiModel()` for Pi detection and model registration. Use `src/commands/run.mjs::serverReady()`, `ensureLocalServer()`, and `waitForReady()` for server lifecycle.
- **Keep both menu actions.** The benchmark menu shows **Run Benchmark** and **Prepare Benchmark (manual)**. Run Benchmark is the default; Prepare is for users who want to use a different harness or paste the prompt elsewhere.
- **Keep failed runs.** Do not delete the run directory on failure. Mark `status: "failed"`, write `error`, and keep `stream.ndjson` plus `stderr.log` for debugging. The gallery will decide how to surface failed runs.
- **Save both raw stream assets.** Write `stream.ndjson` as it arrives, and also reconstruct `response.raw.txt` from the streamed text/thinking/tool-call summary. Both are small and give the gallery maximum flexibility.
- **Stream everything live.** During a run, the terminal shows thinking (magenta), text (green), tool calls (yellow), and tool execution updates as they happen. No compact progress mode by default.
- **Server speed query failure fails the run.** If the model server query fails after Pi exits, the whole benchmark is marked `failed`. Speed metrics are not optional.
- **Stop the server by default.** Match `offgrid-ai run`: stop any server offgrid-ai started after the benchmark completes, unless `--keep-server` is passed.
- **Cancellation is failure.** If the user presses `Ctrl+C` during a run, terminate Pi and mark the run `status: "failed"` with `error.message: "Cancelled by user"`.
- **No aggregate-only metrics.** Capture per-turn token counts and wall-clock durations from the Pi stream in addition to the aggregate server speed query.

---

## 3. Implementation Checklist

### Phase 0 — Finalize schema and contract

- [x] Confirm the final summary table is totals-only; per-turn data is saved but not displayed.
- [x] Confirm both `Run Benchmark` and `Prepare Benchmark (manual)` actions remain in the menu.
- [x] Confirm server speed query failure marks the whole run failed.
- [x] Confirm `Ctrl+C` writes `status: "failed"` with "Cancelled by user".
- [x] Remove the old `benchmark-automation-audit.md` file after this document is approved.

### Phase 1 — Prepare run directory with richer metadata

- [x] Extend `prepareBenchmarkRun()` in `src/benchmark.mjs` to include:
  - `runner.tokenMetrics` with `reported: false` and placeholder counts.
  - `runner.speedMetrics` with null/default values.
  - `runner.metricSource` as `null`.
  - Empty `results` object with `success: false`, `outputFiles: []`, `perTurn: []`.
  - `assets.stream` = `"stream.ndjson"` and `assets.stderr` = `"stderr.log"`.

### Phase 2 — Add stream runner

- [x] Add `runBenchmarkInPi(profile, runDirectory)` in `src/benchmark.mjs`:
  - Resolve Pi model string from `profile.harnesses.pi.model`, falling back to `${providerId}/${modelAlias}`.
  - Spawn `pi --model <model> --mode json -p @prompt.md` with `cwd: runDirectory`.
  - Capture stdout line-by-line as JSONL.
  - Pipe stderr to `stderr.log` in the run directory.
  - Write every line to `stream.ndjson`.
  - Accumulate per-turn usage from `turn_end`.
  - Accumulate per-turn wall-clock from session/agent_start and consecutive `turn_end` timestamps.
  - Count tool calls from `message_end` assistant content and `tool_execution_start`.
  - Resolve on `agent_end`; reject on non-zero exit code.
- [x] Add `renderBenchmarkStream()` for real-time terminal output:
  - `thinking_delta` → magenta.
  - `text_delta` → green.
  - `toolcall_start` / tool name → yellow.
  - `tool_execution_update` → yellow/dim.
  - Accept both `toolcall_*` and `tool_call_*` event subtypes.
- [x] Reconstruct and write `response.raw.txt` from the streamed text, thinking, and tool-call summary.

### Phase 3 — Add backend-aware speed metrics

- [x] Add `queryServerMetrics(profile)` in `src/benchmark.mjs`:
  - **llama.cpp:** POST non-streaming `/v1/chat/completions` with a tiny prompt, read `timings`.
  - **oMLX:** POST streaming `/v1/chat/completions` with `stream_options: { include_usage: true }`, parse final SSE chunk.
  - **Ollama:** POST native `/api/generate` with `stream: false`.
  - Return normalized object: `prefillTokensPerSecond`, `generationTokensPerSecond`, `ttftMs`, `modelLoadMs`, `speculativeDecodeAcceptance`, `kvCacheTokens`, `metricSource`.
- [x] Handle query failure by throwing an error so the run is marked `failed`.

### Phase 4 — Finalize run metadata

- [x] Add `finalizeBenchmarkRun(runDirectory, runResult, speedMetrics)` in `src/benchmark.mjs`:
  - Read existing `metadata.json`.
  - Set `status`, `updatedAt`, `completedAt` or `failedAt`.
  - Write `runner.tokenMetrics`, `runner.speedMetrics`, `runner.metricSource`.
  - Write `results.wallClockMs`, `results.agentTurns`, `results.toolCalls`, `results.toolResults`, `results.success`, `results.outputFiles`, `results.perTurn`.
  - On failure, write `error`.
  - Save updated `metadata.json`.

### Phase 5 — Wire into benchmark flows

- [x] Update `benchmarkForProfile()` and `benchmarkFlow()`:
  - Keep the existing menu with both **Run Benchmark** and **Prepare Benchmark (manual)** actions.
  - For **Run Benchmark**: after `prepareBenchmarkRun()`, check `hasPi()` and whether profile is a local-server backend. If yes, run `runBenchmarkInPi()` then `queryServerMetrics()` then `finalizeBenchmarkRun()` and print the final metrics table.
  - If Pi is missing or model is cloud-only, fall back to prepare-only with `printBenchmarkNextSteps()`.
  - For **Prepare Benchmark (manual)**: keep existing behavior exactly as-is.

### Phase 6 — Integrate server lifecycle

- [x] Before spawning Pi, call `serverReady(profile.baseUrl)`.
- [x] For `llama-cpp` / `llama-cpp-mtp`: if not ready, call `ensureLocalServer()` / `waitForReady()` from `src/commands/run.mjs`.
- [x] For `ollama` / `omlx`: if not ready, print a clear error and abort.
- [x] Stop any server offgrid-ai started after the benchmark completes, unless `--keep-server` is passed. Managed servers (Ollama/oMLX) are left alone.

### Phase 7 — Validation

- [x] Run one `visual` benchmark on each backend (llama.cpp, llama.cpp-MTP, oMLX, Ollama).
  - Tested Ollama `gemma4:e4b`, oMLX `Qwen3.5-9B`, and llama.cpp `gemma-4-E4B-it-Q6_K` (via temporary local server on port 8082).
- [ ] Run one `data-science` benchmark on each backend.
- [x] Inspect `metadata.json` after each run for correct `runner.*`, `results.*`, and `assets.*`.
- [x] Verify `local-llm-visual-benchmark/src/lib/runs.ts::listRunMetadata()` can read the new files without errors (schema-compatible, manual verification).
- [x] Interrupt a run with `Ctrl+C` / external abort; verify directory is kept, `status` is `"failed"`, and `error.message` is `"Cancelled by user"`.
- [x] Run lint and tests.

---

## Open questions

1. Should `results.perTurn` also include server speed metrics per turn, or is aggregate sufficient for Phase 1?
   - **Recommendation:** aggregate server query only; per-turn includes token counts and wall-clock from the Pi stream.
2. Should the stream renderer show full `tool_execution_update` content, or only a summary?
   - **Recommendation:** stream tool output but truncate after the first few lines to avoid flooding the terminal.
3. Should the final table use a heavy Unicode box-drawing style or a lighter aligned plain-text style for terminal compatibility?
   - **Recommendation:** start with Unicode box drawing; fall back to plain ASCII if `NO_COLOR` or a narrow terminal is detected.
