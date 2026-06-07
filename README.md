<div align="center">

# offgrid-ai

**Privacy-first CLI for running local LLMs. Your AI, your machine, nothing leaves.**

[![node](https://img.shields.io/badge/node-20%2B-3c873a)](package.json)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)]()

Install • Run • Done.

```bash
curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | bash
```

</div>

## What it does

You run `offgrid-ai`. It finds your local models, auto-configures everything, starts the server, and launches Pi. Zero configuration. No parameter tuning. No presets.

**First run** walks you through installing anything missing (Homebrew, llama-server). After that, just run it.

```bash
offgrid-ai          # pick a model and run it
offgrid-ai status   # show running servers (from another terminal)
offgrid-ai stop     # stop a running server
```

## Install

One command. Installs Node.js if you don't have it, then installs offgrid-ai.

```bash
curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | bash
```

Or if you already have Node.js:

```bash
npm install -g offgrid-ai
```

Or review the install script first:

```bash
curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | less
```

## How it works

1. **Auto-detect everything.** Scans for GGUF models in LM Studio, HuggingFace, and Ollama directories. Reads model metadata (quantization, context size, vision, thinking mode) directly from the GGUF file. No presets, no manual configuration.

2. **One command to run.** `offgrid-ai` → pick a model → confirm context/KV memory settings on first setup → it starts llama-server, syncs Pi config, and launches Pi.

3. **One model at a time.** Laptops have limited RAM. One server, one model, no confusion.

## Supported backends

| Backend | Type | Auto-detected |
|---|---|---|
| **LM Studio** | Visual model browser + CLI (`lms`) | ✓ models in `~/.lmstudio/models/` |
| **llama.cpp** | Local server | ✓ GGUF models in `~/.lmstudio/models/` |
| **llama.cpp MTP** | Local server (speculative decoding) | ✓ MTP detected from model metadata |
| **Ollama** | Managed server | ✓ via `localhost:11434` |
| **oMLX** | Managed server | ✓ via `127.0.0.1:8000` |

## First run onboarding

When you run `offgrid-ai` for the first time on a fresh machine:

1. **Homebrew** — Required. Offered to install if missing.
2. **llama-server** — Required for GGUF models. Offered to install via Homebrew.
3. **Model backend** — At least one is needed (LM Studio recommended):
   - **LM Studio** — visual model browser + `lms` CLI, download models with `lms get qwen/qwen3.5-9b`
   - **Ollama** — models download on demand with `ollama pull`
   - **oMLX** — Apple Silicon optimized
4. **Models** — If no models found, tells you where to get them.

Subsequent runs skip everything that's already installed. When a GGUF model is set up for the first time, offgrid-ai asks only for the memory-impacting choices: context window and KV cache precision. Sampling defaults are shown but not forced into a tuning wizard.

## Data directory

```
~/.offgrid-ai/
  config.json          # auto-detected paths, editable for overrides
  profiles/            # one per model, auto-created on first run
    <id>/
      profile.json     # model metadata + auto-detected settings
      command.json     # llama-server flags (auto-generated, hand-editable)
      notes.md         # scratch notes
  logs/
  run/                 # PID state files
```

## Benchmark (coming soon)

"Benchmark" is always shown as an option in the CLI. If the [local-llm-visual-benchmark](https://github.com/eeshansrivastava89/local-llm-visual-benchmark) repo is found locally, it works. If not, it offers to clone it. Model management works standalone; benchmarking is the upsell.

## Development

```bash
git clone https://github.com/eeshansrivastava89/offgrid-ai.git
cd offgrid-ai
npm install
node bin/offgrid-ai.mjs
```

## License

Personal project by [Eeshan Srivastava](https://eeshans.com).