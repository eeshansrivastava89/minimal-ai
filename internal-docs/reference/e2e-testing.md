# End-to-End Testing

This guide covers testing `offgrid-ai` in a clean macOS VM using Tart. Use it for release smoke tests and regression checks.

## Tart VM Setup (one-time)

```bash
brew install cirruslabs/cli/tart
tart clone ghcr.io/cirruslabs/macos-tahoe-base:latest tahoe-base
```

This creates `tahoe-base` — your pristine macOS image. Never modify this one.

## Test Cycle

```bash
tart clone tahoe-base tahoe-test    # fresh clone from base
tart run tahoe-test                 # boot the VM
# ... run tests ...
tart stop tahoe-test                # shut down
tart delete tahoe-test              # clean up
```

## Install offgrid-ai

```bash
# Via curl installer (primary)
curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | bash

# Or via npm (if Node already present)
npm install -g offgrid-ai@latest --prefer-online

# Verify
offgrid-ai version          # e.g., 0.8.10
offgrid-ai --help           # lists commands: start, status, stop, benchmark, uninstall, version
```

## Uninstall offgrid-ai

```bash
offgrid-ai uninstall
# Or manually:
npm uninstall -g offgrid-ai
```

## Full Reset Inside VM

Remove offgrid-ai config and data (keeps backends installed):

```bash
npm uninstall -g offgrid-ai
rm -rf ~/.offgrid-ai
```

Remove Node.js (if installed via nvm by the curl installer):

```bash
rm -rf ~/.nvm
sed -i '' '/NVM_DIR/d; /nvm.sh/d' ~/.zshrc
```

Remove Node.js (if installed via Homebrew):

```bash
brew uninstall node
```

Remove all backends:

```bash
brew uninstall ollama
brew uninstall --cask lm-studio
brew uninstall omlx
brew untap jundot/omlx
brew uninstall llama.cpp
rm -rf ~/.lmstudio          # LM Studio data + models
rm -rf ~/.ollama             # Ollama models
```

Full nuclear reset (everything including Homebrew):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/uninstall.sh)"
rm -rf ~/.offgrid-ai ~/.nvm ~/.lmstudio ~/.ollama
# Edit ~/.zshrc to remove nvm/homebrew PATH lines
```

Nuclear reset is overkill for most testing — just `tart stop tahoe-test && tart delete tahoe-test` and re-clone from base instead.

## Commands to exercise in the VM

After install, run through the main surface area:

```bash
offgrid-ai --help           # help card
offgrid-ai version          # version output
offgrid-ai models           # list / scan for local models (creates profiles on first run)
offgrid-ai benchmark        # prepare or run a visual/data-science benchmark
offgrid-ai status           # show running servers, if any
offgrid-ai stop             # stop a running server
offgrid-ai uninstall        # remove offgrid-ai and data directory
```

For `offgrid-ai benchmark`, you will be prompted to link the `local-llm-visual-benchmark` repo. Automated runs require Pi to be installed and a local model server (llama.cpp, Ollama, or oMLX) to be running.

## Postinstall / CI behavior

`src/postinstall.mjs` intentionally exits early when `CI` or `OFFGRID_SKIP_POSTINSTALL` is set. This protects CI runners and automated installs from shell-config modifications.

When testing the postinstall script directly (for example in `test/regression.mjs`), the environment must explicitly clear those variables:

```js
const env = {
  ...process.env,
  CI: "",
  OFFGRID_SKIP_POSTINSTALL: "",
};
```

GitHub Actions sets `CI=true` by default, so postinstall regression tests that do not unset it will fail with the script exiting before the assertions run.

## VM Quick Reference

```bash
tart list                        # see all VMs
tart run tahoe-test              # start VM (GUI window opens)
tart stop tahoe-test             # stop VM
tart delete tahoe-test           # delete VM
tart clone tahoe-base tahoe-test # fresh clone from base
```

## Copy-Paste in VM

Copy-paste in Tart VMs requires `tart-guest-agent`:

```bash
# Inside the VM:
brew install tart-guest-agent
```

Pre-installed on `tahoe-base` if you used the official Tart images.