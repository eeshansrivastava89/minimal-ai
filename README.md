<div align="center">

# offgrid-ai

**Run local AI models on your machine — pick, configure, and chat.**

[![node](https://img.shields.io/badge/node-20%2B-3c873a)](package.json)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)]()


</div>

## What is offgrid-ai?

offgrid-ai is a command-line tool that lets you run AI models locally. Running local models with llama-server or oMLX has a steep learning curve compared to cloud-based models, so offgrid-ai is designed to abstract away the complexity while still providing a powerful and flexible way to run local models.

The recommended workflow:

1. Download models from **HuggingFace** (or use models you already have from LM Studio, oMLX, etc.)
2. Configure using the `offgrid-ai` interactive setup
3. Start chatting in **Pi** — offgrid-ai handles the server lifecycle

## Core Features

- **Download models** from HuggingFace with a quant picker and RAM fit indicators
- **Auto-detects** models from LM Studio, oMLX, and HuggingFace cache
- **Glass-box setup** — every configuration flag gets an explanation card with tradeoffs and memory impact
- **Model management** — delete models from disk, remove configurations, reconfigure settings
- **Auto-detects MTP** (multi-token prediction) and **QAT** (quantization-aware training) models, applies the correct flags
- **Start / stop servers** automatically for chat sessions (llama-server and oMLX)
- **oMLX integration** — auto-start, MTP enable via admin API, restart after download/deletion

## Quick start

### 1. Install

Open your terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | bash
```

This installs offgrid-ai and its prerequisite (Node.js via nvm if needed). The first time you run `offgrid-ai`, it walks you through installing the rest — the llama.cpp runtime, the Pi chat agent, and the HuggingFace CLI. Then open a new terminal window and run:

```bash
offgrid-ai
```

If you already have Node.js installed, you can also install with npm:

```bash
npm install -g offgrid-ai@latest --prefer-online
```

The curl installer is recommended for first-time setup because it also verifies the global npm bin directory is on your PATH. The npm package itself does not run install scripts or mutate shell config during `npm install`.

### 2. Pick a model

The first time you run offgrid-ai, it looks for models already on your machine. If it doesn't find any, you can download one directly from HuggingFace — just pick "↓ Download a model" and enter a repo ID (e.g. `unsloth/Qwen3.5-4B-GGUF`).

<img width="808" height="274" alt="image" src="https://github.com/user-attachments/assets/6e1583ab-65db-423c-b0eb-b627586fbf86" />


### 3. Start chatting

```bash
offgrid-ai
```

<img width="786" height="281" alt="image" src="https://github.com/user-attachments/assets/03cb1e06-d461-4bdf-ad82-f0692e5ba5c6" />


Pick a model from the list and press Enter. offgrid-ai configures the rest and opens the Pi coding agent.

<img width="786" height="499" alt="image" src="https://github.com/user-attachments/assets/223e1455-c69c-4405-a91c-5bac1b9fc9bd" />


## Everyday commands

```bash
offgrid-ai              # model picker — pick, configure, download, or manage models
offgrid-ai status       # see if any model is running
offgrid-ai stop         # stop the running model
offgrid-ai uninstall    # remove offgrid-ai
```

## Platform support

- **macOS (Apple Silicon)** — full support: llama.cpp (GGUF) + oMLX (MLX)
- **Linux** — llama.cpp (GGUF) only. oMLX is Apple Silicon exclusive.
- **Windows** — not supported

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