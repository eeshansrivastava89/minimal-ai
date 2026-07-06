#!/usr/bin/env bash
# offgrid-ai installer
#
# Install:
#   curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | bash
#
# Or review first:
#   curl -fsSL https://raw.githubusercontent.com/eeshansrivastava89/offgrid-ai/main/install.sh | less
#
# What this does:
#   1. Checks for Node.js
#   2. If not found, installs it via nvm (no sudo needed)
#   3. Installs offgrid-ai globally via npm
#   4. Ensures everything is on PATH (nvm + ~/.local/bin in .zprofile)
#   5. Runs offgrid-ai
#
# Flags:
#   --dry-run    Show what would happen without making changes
#   --no-run     Install but don't launch offgrid-ai after
#   --help       Show this help
#
# This script never uses sudo. Everything installs to user-writable directories.

set -euo pipefail

NVM_INSTALLED=false

# ── Flags ───────────────────────────────────────────────────────────────────

DRY_RUN=false
SKIP_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true; echo "[dry-run] No changes will be made." ;;
    --no-run)   SKIP_RUN=true ;;
    --help|-h)   echo "Usage: curl -fsSL <url> | bash -s -- [--dry-run] [--no-run]"; exit 0 ;;
  esac
done

dry() { if $DRY_RUN; then printf "[dry-run] %s\n" "$*"; return 0; else "$@"; fi; }

# ── Output helpers ──────────────────────────────────────────────────────────

BOLD='\033[1m' RESET='\033[0m' GREEN='\033[32m' YELLOW='\033[33m' BLUE='\033[34m' RED='\033[31m'
info()  { printf "${BLUE}→${RESET} %s\n" "$*"; }
ok()     { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()   { printf "${YELLOW}!${RESET} %s\n" "$*"; }
fail()   { printf "${RED}✗${RESET} %s\n" "$*"; exit 1; }

# ── Detect OS ───────────────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *)      fail "Unsupported OS: $OS. offgrid-ai requires macOS or Linux." ;;
esac
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)             fail "Unsupported architecture: $ARCH" ;;
esac
info "Detected: ${OS}-${ARCH}"

# ── Check for Node.js ───────────────────────────────────────────────────────

if command -v node &>/dev/null; then
  NODE_VERSION="$(node --version 2>/dev/null || echo "unknown")"
  ok "Node.js ${NODE_VERSION} found at $(command -v node)"
else
  echo ""
  printf "${BOLD}offgrid-ai needs Node.js.${RESET}\n"
  printf "It will be installed now via nvm (Node Version Manager).\n"
  printf "This installs to your home directory — no sudo needed.\n"
  echo ""

  # Install nvm
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  info "Installing nvm..."
  dry curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh -o /tmp/nvm-install.sh
  dry bash /tmp/nvm-install.sh

  # Source nvm in this script
  if ! $DRY_RUN; then
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  fi

  # Install Node.js LTS
  info "Installing Node.js LTS..."
  dry nvm install --lts

  # Verify
  if $DRY_RUN || command -v node &>/dev/null; then
    ok "Node.js $(node --version 2>/dev/null || echo 'installed') installed via nvm."
    NVM_INSTALLED=true
  else
    ok "Node.js installed via nvm."
    echo ""
    warn "Node.js was installed but your shell doesn't see it yet."
    echo "  Restart your terminal, or run: source ~/.nvm/nvm.sh"
    echo "  Then re-run this installer."
    exit 0
  fi
fi

# ── Ensure ~/.local/bin is on PATH (for HuggingFace CLI) ────────────────────
# The HF CLI standalone installer puts hf in ~/.local/bin. Add it to .zprofile
# (or .bashrc on Linux) so it's available in future shells. Also add it to the
# current script's PATH so it's available immediately.

LOCAL_BIN="$HOME/.local/bin"
if ! $DRY_RUN; then
  # Add to current process PATH
  [[ -d "$LOCAL_BIN" ]] && export PATH="$LOCAL_BIN:$PATH"

  # Persist to shell profile (same file nvm uses)
  PROFILE_FILE="$HOME/.zprofile"
  [[ "$OSTYPE" != darwin* ]] && PROFILE_FILE="$HOME/.bashrc"
  if ! grep -qF '.local/bin' "$PROFILE_FILE" 2>/dev/null; then
    echo '' >> "$PROFILE_FILE"
    echo '# Added by offgrid-ai installer (HuggingFace CLI)' >> "$PROFILE_FILE"
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$PROFILE_FILE"
  fi
fi

# ── Install offgrid-ai ──────────────────────────────────────────────────────

echo ""
printf "${BOLD}Installing offgrid-ai...${RESET}\n"
dry npm install -g offgrid-ai@latest --prefer-online

# ── Dry-run early exit ──────────────────────────────────────────────────────

if $DRY_RUN; then
  ok "offgrid-ai installed (dry-run)"
  echo ""
  printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
  printf "${BOLD}${GREEN}  offgrid-ai is ready! (dry-run)${RESET}\n"
  printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
  echo ""
  echo "  Run: offgrid-ai"
  echo ""
  exit 0
fi

# ── Get installed version ───────────────────────────────────────────────────

INSTALLED_VERSION=""
NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
NPM_BIN="${NPM_PREFIX%/}/bin"
if [[ -x "$NPM_BIN/offgrid-ai" ]]; then
  INSTALLED_VERSION="$(OFFGRID_NO_UPDATE_CHECK=1 "$NPM_BIN/offgrid-ai" version 2>/dev/null | sed -E 's/^offgrid-ai v//' || echo "")"
  ok "offgrid-ai ${INSTALLED_VERSION:+v${INSTALLED_VERSION} }installed"
else
  warn "offgrid-ai was installed but could not be found at $NPM_BIN"
  echo "  Restart your terminal and run: offgrid-ai"
  echo "  Or run: npx offgrid-ai"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}${GREEN}  offgrid-ai ${INSTALLED_VERSION:+v${INSTALLED_VERSION} }is ready!${RESET}\n"
printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
echo ""
echo "  First run will walk you through setting up everything you need"
echo "  (managed llama.cpp runtime for GGUF models, model backends, Pi)."
echo ""

# ── Auto-launch offgrid-ai ──────────────────────────────────────────────────
# Use /dev/tty for both the prompt and the process stdin, since this script
# is piped from curl (stdin is the pipe, not a terminal).

if ! $SKIP_RUN && [[ -c /dev/tty ]]; then
  printf "${BOLD}Run offgrid-ai now? [Y/n]${RESET} "
  read -r response < /dev/tty
  response="${response:-Y}"
  if [[ "$response" =~ ^[Yy]$ ]]; then
    # Run offgrid-ai (not exec — we need to continue after it exits)
    "$NPM_BIN/offgrid-ai" < /dev/tty
  fi
fi

# ── Start a fresh shell with everything on PATH ─────────────────────────────
#
# When nvm was used, node/npm/pi/offgrid-ai are in nvm's bin directory, which
# is only on PATH when nvm is sourced (.zprofile). The user's current shell
# doesn't have nvm sourced. Instead of telling them to "source" something,
# we start a new login shell that sources .zprofile automatically.
#
# This is the root-cause fix — no symlinks, no PATH hacks, no instructions.

if $NVM_INSTALLED && [[ -c /dev/tty ]]; then
  echo ""
  printf "${BOLD}Starting a new shell with everything on PATH...${RESET}\n"
  echo ""
  SHELL="${SHELL:-/bin/zsh}"
  exec "$SHELL" -l < /dev/tty
fi