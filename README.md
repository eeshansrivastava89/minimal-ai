<div align="center">

# offgrid-ai

**Helper CLI for running local AI models on Mac with llama.cpp, ollama, and oMLX.**

[![node](https://img.shields.io/badge/node-20%2B-3c873a)](package.json)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)]()


</div>

## What is offgrid-ai?

offgrid-ai is a command-line tool that lets you run AI models locally. Running local models with llama.cpp, ollama, or oMLX have a steep learning curve compared to cloud-based models, so offgrid-ai is designed to abstract away the complexity, while still providing a powerful and flexible way to run local models.

This is the recommended workflow:

1. Download models from **LM Studio**, **Ollama**, or **oMLX**
2. Do minimal configuration using the `offgrid-ai` command
3. Run the model with `offgrid-ai` with Pi in interactive mode

## Core Features
- Auto-detects available models from LM Studio, Ollama, and oMLX
- Auto-detects MTP (multi-token prediction) or QAT (quantization aware training) models, and applies the correct flags for llama.cpp
- Auto-applies the optimal flags for the model type in llama.cpp
- Start / stop llama.cpp server automatically for chat sessions

## Quick start

### 1. Install

Open your terminal and run:

```bash
curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | bash
```

This installs offgrid-ai and dependencies (node, npm, and llama.cpp). Then open a new terminal window and run:

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
