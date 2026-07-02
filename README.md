<div align="center">

# offgrid-ai

**Helper CLI for running local AI models on Mac with llama-server and oMLX.**

[![node](https://img.shields.io/badge/node-20%2B-3c873a)](package.json)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)]()


</div>

## What is offgrid-ai?

offgrid-ai is a command-line tool that lets you run AI models locally. Running local models with llama-server or oMLX have a steep learning curve compared to cloud-based models, so offgrid-ai is designed to abstract away the complexity, while still providing a powerful and flexible way to run local models.

This is the recommended workflow:

1. Download models from **LM Studio** or **oMLX**
2. Do minimal configuration using the `offgrid-ai` command
3. Run the model with `offgrid-ai` with Pi in interactive mode

## Core Features
- Auto-detects available models from LM Studio, oMLX, and HuggingFace
- Auto-detects MTP (multi-token prediction) or QAT (quantization aware training) models, and applies the correct flags for llama.cpp
- Auto-applies the optimal flags for the model type (llama.cpp server flags, oMLX auto-start and cache management)
- Start / stop local servers automatically for chat sessions (llama-server and oMLX)

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
offgrid-ai              # primary entry-point for the CLI
offgrid-ai status       # see if any model is running
offgrid-ai stop         # stop the running model
offgrid-ai benchmark    # run a benchmark paired with my local llm benchmark runner
offgrid-ai uninstall    # remove offgrid-ai
```

## What can I do with it?

- **Chat with local models** — you download the models yourself, and then offgrid-ai helps configure and run then
- **Run benchmarks** — compare how different models perform on creative or data-science tasks. Pairs with my other [local llm benchmark runner](https://github.com/eeshansrivastava89/local-llm-visual-benchmark)
- **Keep data private** — everything runs on your machine without any cloud connections

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
