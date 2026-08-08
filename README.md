<div align="center">

# minimal-ai

**Run local AI models on your machine — pick, configure, and chat.**

[![node](https://img.shields.io/badge/node-20%2B-3c873a)](package.json)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)]()


</div>

## What is minimal-ai?

minimal-ai is a simple utility that stitches together local LLM inference backends (llama.cpp, oMLX, ollama), with one of the best coding harnesses (Pi), and simplifies the complexity of configuring models to run on your personal hardware. 

I built this as a utility for myself since I like exploring local models on my personal laptop (M4 Pro Mac 48 GB). I haven't tested this on Linux or Windows, or for NVIDIA GPUs. Open for contributions. 

Recommended workflow:
1. Download models from **HuggingFace** (or use models you already have from LM Studio, oMLX, etc.)
2. Configure using the `minimal-ai` interactive setup (explains all the settings & flags)
3. Start chatting and coding in **Pi** — minimal-ai handles the server lifecycle

## Core Features

- **Download models** from HuggingFace with a quant picker and RAM fit indicators
- **Auto-detects** models from LM Studio, oMLX, Ollama, and HuggingFace cache
- **Guided model config** — every setting gets a plain-language hint as you configure, with memory and context tradeoffs shown before you save
- **Model management** — delete models from disk, remove configurations, reconfigure settings
- **Auto-detects MTP** (multi-token prediction) and **QAT** (quantization-aware training) models, applies the correct flags
- **Three backends**: llama.cpp (GGUF), oMLX (MLX on Apple Silicon), Ollama (GGUF + MLX)
- **Start / stop servers** automatically for chat sessions

## Quick start

### 1. Install

Open your terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/minimal-ai/main/install.sh | bash
```

This installs minimal-ai and its prerequisite (Node.js via nvm if needed), then launches `minimal-ai` automatically. The first launch walks you through installing all core dependencies — llama.cpp runtime, Pi chat agent, and HuggingFace CLI, then drops you into the model picker to download a model and start chatting. 

If you already have Node.js installed, you can also install with npm:

```bash
npm install -g minimal-ai@latest
```

The curl installer is recommended for first-time setup because it also verifies the global npm bin directory is on your PATH. The npm package itself does not run install scripts or mutate shell config during `npm install`.

### 2. Pick a model

The first time you run minimal-ai, it looks for models already on your machine. If it doesn't find any, you can download one directly from HuggingFace — pick "↓ GGUF from HuggingFace" and enter a repo ID (e.g. `unsloth/Qwen3.5-4B-GGUF`).

<img width="808" height="274" alt="image" src="https://github.com/user-attachments/assets/6e1583ab-65db-423c-b0eb-b627586fbf86" />


### 3. Start chatting

```bash
minimal-ai
```

<img width="786" height="281" alt="image" src="https://github.com/user-attachments/assets/03cb1e06-d461-4bdf-ad82-f0692e5ba5c6" />


Pick a model from the list and press Enter. minimal-ai configures the rest and opens the Pi coding agent.

<img width="786" height="499" alt="image" src="https://github.com/user-attachments/assets/223e1455-c69c-4405-a91c-5bac1b9fc9bd" />


## Everyday commands

```bash
minimal-ai              # model picker — pick, configure, download, or manage models
minimal-ai update       # update minimal-ai to the latest version
minimal-ai status       # see if any model is running
minimal-ai stop         # stop the running model
minimal-ai uninstall    # remove minimal-ai
```

## Recommended models

These are good starting points sorted by minimum RAM. All are available on HuggingFace — paste the repo ID into minimal-ai's GGUF download option.

| Model | Min RAM | GGUF (llama.cpp) | MLX |
|-------|---------|------------------|-----|
| Qwen 3.5 4B (Q4_K_M) | 8 GB | [`unsloth/Qwen3.5-4B-GGUF`](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF) | [`mlx-community/Qwen3.5-4B-4bit`](https://huggingface.co/mlx-community/Qwen3.5-4B-4bit) |
| Qwen 3.5 9B (Q4_K_S) | 16 GB | [`unsloth/Qwen3.5-9B-GGUF`](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF) | [`lmstudio-community/Qwen3.5-9B-MLX-4bit`](https://huggingface.co/lmstudio-community/Qwen3.5-9B-MLX-4bit) |
| Gemma 4 12B (Q4_K_XL) | 24 GB | [`unsloth/gemma-4-12B-it-qat-GGUF`](https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF) | [`mlx-community/gemma-4-12B-it-qat-4bit`](https://huggingface.co/mlx-community/gemma-4-12B-it-qat-4bit) |
| Gemma 4 26B (Q4_K_XL) | 32 GB | [`unsloth/gemma-4-26B-A4B-it-qat-GGUF`](https://huggingface.co/unsloth/gemma-4-26B-A4B-it-qat-GGUF) | [`mlx-community/gemma-4-26b-a4b-4bit`](https://huggingface.co/mlx-community/gemma-4-26b-a4b-4bit) |
| Qwen 3.6 35B (Q4_K_S) | 32 GB | [`unsloth/Qwen3.6-35B-A3B-GGUF`](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) | [`mlx-community/Qwen3.6-35B-A3B-4bit`](https://huggingface.co/mlx-community/Qwen3.6-35B-A3B-4bit) |
| Qwen 3.6 35B (Q4_K_M) | 48 GB | [`unsloth/Qwen3.6-35B-A3B-GGUF`](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF) | — |
| Gemma 4 31B (Q4_K_XL) | 64 GB | [`unsloth/gemma-4-31B-it-qat-GGUF`](https://huggingface.co/unsloth/gemma-4-31B-it-qat-GGUF) | [`mlx-community/gemma-4-31b-4bit`](https://huggingface.co/mlx-community/gemma-4-31b-4bit) |
| Qwen 3.6 27B (Q4_K_M) | 64 GB | [`unsloth/Qwen3.6-27B-MTP-GGUF`](https://huggingface.co/unsloth/Qwen3.6-27B-MTP-GGUF) | [`mlx-community/Qwen3.6-27B-4bit`](https://huggingface.co/mlx-community/Qwen3.6-27B-4bit) |

> **Tip:** When downloading GGUF, minimal-ai shows a quant picker with RAM fit indicators so you can choose the right quantization for your machine.

## Platform support

- **macOS (Apple Silicon)** — full support: llama.cpp (GGUF), oMLX (MLX), Ollama (GGUF + MLX). Requires Metal GPU (all Apple Silicon Macs have this). Virtual machines without GPU passthrough will fail on model load.
- **Linux** — llama.cpp (GGUF) and Ollama. oMLX is Apple Silicon exclusive.
- **Windows** — not supported

## Need help?

Run any command with `--help`:

```bash
minimal-ai --help
```

## Development

```bash
git clone https://github.com/eeshansrivastava89/minimal-ai.git
cd minimal-ai
npm install
node bin/minimal-ai.mjs
```

## License

Personal project by [Eeshan Srivastava](https://eeshans.com).
