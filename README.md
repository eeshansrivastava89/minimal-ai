<div align="center">

# offgrid-ai

**Privacy-first CLI for running local AI models on your own machine.**

[![node](https://img.shields.io/badge/node-20%2B-3c873a)](package.json)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)]()

Install • Pick a model • Start chatting
```bash
curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | bash
```

</div>

## What is offgrid-ai?

offgrid-ai is a command-line tool that lets you run AI models locally. Everything stays on your computer. No API keys, no remote servers, no data leaving your machine.

It works with:

- Models from **LM Studio**
- **Ollama** models
- **oMLX** models on Apple Silicon
- GGUF models from **Hugging Face** or other sources

## Quick start

### 1. Install

Open your terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | bash
```

This installs offgrid-ai and anything else it needs. Then open a new terminal window and run:

```bash
offgrid-ai
```

If you already have Node.js installed, you can also install with npm:

```bash
npm install -g offgrid-ai@latest --prefer-online
```

The curl installer is recommended for first-time setup because it also verifies the global npm bin directory is on your PATH. The npm package itself does not run install scripts or mutate shell config during `npm install`.

### 2. Pick a model

The first time you run offgrid-ai, it looks for models already on your machine. If it does not find any, it tells you how to get one.

Supported ways to get models:

| Source | Example command |
|---|---|
| LM Studio | `lms get qwen/qwen3.5-9b` |
| Ollama | `ollama pull gemma3:4b` |
| oMLX | Use `omlx start` |
| Hugging Face | Download a GGUF file |

### 3. Start chatting

```bash
offgrid-ai
```

Pick a model from the list and press Enter. offgrid-ai configures the rest and opens the Pi coding agent.

## Everyday commands

```bash
offgrid-ai              # start a model
offgrid-ai status       # see what's running
offgrid-ai stop         # stop the running model
offgrid-ai benchmark    # run a benchmark
offgrid-ai uninstall    # remove offgrid-ai
```

## What can I do with it?

- **Chat with local models** — no internet required after setup.
- **Run benchmarks** — compare how different models perform on creative or data-science tasks.
- **Keep data private** — everything happens on your machine.

## Need help?

Run any command with `--help`:

```bash
offgrid-ai --help
```

## Development

```bash
git clone https://github.com/eeshansrivastava89/offgrid-ai.git
cd offgrid-ai
npm install
node bin/offgrid-ai.mjs
```

## License

Personal project by [Eeshan Srivastava](https://eeshans.com).
