# End-to-End Testing

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
npm install -g offgrid-ai

# Verify
offgrid-ai version
offgrid-ai --help
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
nvm uninstall node
rm -rf ~/.nvm
# Then remove these lines from ~/.zshrc:
# export NVM_DIR="$HOME/.nvm"
# [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
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