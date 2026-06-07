# End-to-End Testing

## Tart VM Setup (one-time)

```bash
brew install cirruslabs/cli/tart
tart clone ghcr.io/cirruslabs/macos-tahoe-base:latest tahoe-base
```

This creates `tahoe-base` — your pristine macOS image. Never modify this one.

## Test Cycle

Each time you want to test from a completely clean machine:

```bash
# 1. Clone from the pristine base
tart clone tahoe-base tahoe-test

# 2. Run the VM
tart run tahoe-test

# 3. In the VM, test the curl installer
curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | bash

# 4. Test onboarding
offgrid-ai

# 5. When done, stop and delete the VM
tart stop tahoe-test
tart delete tahoe-test
```

Next test cycle — go back to step 1. You always start from a clean base.

## What to Test

### Fresh install (curl)
- [ ] `curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | bash`
- [ ] Node installs if missing
- [ ] offgrid-ai installs globally
- [ ] `offgrid-ai --version` works
- [ ] `offgrid-ai --help` works

### First-run onboarding
- [ ] `offgrid-ai` launches onboarding
- [ ] Homebrew offer → installs if missing
- [ ] llama-server offer → installs via brew
- [ ] Backend choice → LM Studio (recommended) / Ollama / oMLX / all three / skip
- [ ] Each backend installs via Homebrew
- [ ] LM Studio: `lms` CLI added to PATH after install
- [ ] Next steps show concrete model download command per backend
- [ ] "Setup complete" message at the end

### Uninstall
- [ ] `offgrid-ai uninstall`
- [ ] Asks to keep profiles (yes/no)
- [ ] Removes npm package
- [ ] `~/.offgrid-ai/` kept or removed per choice

### Full clean reset (inside VM)
```bash
rm -rf ~/.offgrid-ai
npm uninstall -g offgrid-ai
# Then stop + delete the VM and re-clone
```

## Useful VM Commands

```bash
tart list              # see all VMs
tart run tahoe-test    # start VM (GUI window opens)
tart stop tahoe-test   # stop VM
tart delete tahoe-test # delete VM
tart clone tahoe-base tahoe-test  # fresh clone from base
```

## Quick Test via Docker (Linux only, no macOS testing)

```bash
# Test npm/npx install on clean Linux
docker run --rm -it node:20-slim bash -c "npx offgrid-ai@latest --version && npx offgrid-ai@latest help"

# Test curl installer on clean Ubuntu
docker run --rm -it ubuntu:latest bash -c "apt update && apt install -y curl && curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | bash"
```