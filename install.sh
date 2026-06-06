#!/usr/bin/env bash
# offgrid-ai installer — https://github.com/eeshan/offgrid-ai
#
# Install:
#   curl -fsSL https://raw.githubusercontent.com/eeshan/offgrid-ai/main/install.sh | bash
#
# Or review first:
#   curl -fsSL https://raw.githubusercontent.com/eeshan/offgrid-ai/main/install.sh | less
#   curl -fsSL https://raw.githubusercontent.com/eeshan/offgrid-ai/main/install.sh | bash
#
# What this does:
#   1. Checks for Node.js or Bun
#   2. If neither found, installs Node.js (via Homebrew or nvm)
#   3. Installs offgrid-ai globally
#   4. Runs offgrid-ai
#
# This script never uses sudo. Everything installs to user-writable directories.

set -euo pipefail

# ── Flags ───────────────────────────────────────────────────────────────────

DRY_RUN=false
SKIP_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true; echo "[dry-run] No changes will be made." ;;
    --no-run)   SKIP_RUN=true ;;
    --help|-h)   echo "Usage: curl -fsSL URL | bash -s -- [--dry-run] [--no-run]"; exit 0 ;;
  esac
done

dry() { if $DRY_RUN; then printf "${BLUE}[dry-run]${RESET} %s\n" "$*"; return 0; else "$@"; fi; }

# ── Colors ──────────────────────────────────────────────────────────────────

RED=''    GREEN=''  YELLOW=''  BLUE=''  BOLD=''  RESET=''
if [[ -t 1 ]]; then
  RED='\033[31m'    GREEN='\033[32m'  YELLOW='\033[33m'
  BLUE='\033[34m'   BOLD='\033[1m'    RESET='\033[22m\033[0m'
fi

info()  { printf "${BLUE}→${RESET} %s\n" "$*"; }
ok()     { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()   { printf "${YELLOW}!${RESET} %s\n" "$*"; }
fail()   { printf "${RED}✗${RESET} %s\n" "$*"; exit 1; }

# ── Detect OS and arch ─────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *)      fail "Unsupported OS: $OS. offgrid-ai requires macOS or Linux." ;;
esac

case "$ARCH" in
  x86_64|amd64)   ARCH="x64" ;;
  arm64|aarch64)   ARCH="arm64" ;;
  *)               fail "Unsupported architecture: $ARCH" ;;
esac

info "Detected: ${OS}-${ARCH}"

# ── Check for existing runtime ──────────────────────────────────────────────

has_node() { command -v node &>/dev/null; }
has_bun()  { command -v bun &>/dev/null; }
has_brew() { command -v brew &>/dev/null; }

NODE_VERSION=""
BUN_VERSION=""

if has_node; then
  NODE_VERSION="$(node --version 2>/dev/null || echo "unknown")"
  ok "Node.js ${NODE_VERSION} found at $(command -v node)"
fi

if has_bun; then
  BUN_VERSION="$(bun --version 2>/dev/null || echo "unknown")"
  ok "Bun ${BUN_VERSION} found at $(command -v bun)"
fi

# ── Install Node.js if missing ─────────────────────────────────────────────

if ! has_node && ! has_bun; then
  echo ""
  printf "${BOLD}offgrid-ai needs a JavaScript runtime.${RESET}\n"
  printf "Node.js is recommended and will be installed now.\n"
  echo ""

  if has_brew; then
    info "Homebrew found. Installing Node.js via Homebrew..."
    dry brew install node
    if $DRY_RUN || has_node; then
      ok "Node.js $(node --version 2>/dev/null || echo '??') installed."
    else
      fail "Homebrew installed but Node.js is not on PATH. Open a new terminal and try again."
    fi
  else
    # No Homebrew — install via nvm
    info "Installing nvm (Node Version Manager)..."
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    dry curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh -o /tmp/nvm-install.sh
    dry bash /tmp/nvm-install.sh
    # shellcheck disable=SC1090
    if ! $DRY_RUN; then
      source "${NVM_DIR}/nvm.sh" 2>/dev/null || source "$HOME/.nvm/nvm.sh" 2>/dev/null || true
    fi

    if $DRY_RUN || command -v nvm &>/dev/null; then
      info "Installing Node.js LTS via nvm..."
      dry nvm install --lts
      ok "Node.js $(node --version 2>/dev/null || echo '??') installed via nvm."
    else
      # nvm might not be on PATH yet
      if ! $DRY_RUN; then
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
      fi
      if $DRY_RUN || has_node; then
        ok "Node.js $(node --version 2>/dev/null || echo '??') installed via nvm."
      else
        echo ""
        printf "${YELLOW}Could not install Node.js automatically.${RESET}\n"
        echo "Install it manually and re-run this script:"
        echo ""
        echo "  macOS:  brew install node"
        echo "  Linux:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
        echo "  Any:    https://nodejs.org/en/download/"
        echo ""
        echo "Then run: curl -fsSL https://raw.githubusercontent.com/eeshan/offgrid-ai/main/install.sh | bash"
        exit 1
      fi
    fi
  fi
fi

# ── Install offgrid-ai ─────────────────────────────────────────────────────

echo ""
printf "${BOLD}Installing offgrid-ai...${RESET}\n"

if has_node; then
  # Prefer npm if Node.js is available
  if command -v npm &>/dev/null; then
    dry npm install -g offgrid-ai
  elif command -v bun &>/dev/null; then
    dry bun install -g offgrid-ai
  else
    fail "Neither npm nor bun found. This should not happen — please report this bug."
  fi
elif has_bun; then
  # Only Bun available
  dry bun install -g offgrid-ai
else
  # Just installed Node via nvm — it might not be on PATH yet in this shell
  # but it's there. Trust the install.
  info "Node.js was just installed via nvm."
  info "offgrid-ai will be available after restarting your terminal."
  dry npm install -g offgrid-ai
fi

# ── Verify installation ─────────────────────────────────────────────────────

if $DRY_RUN; then
  ok "offgrid-ai installed (dry-run — no actual changes made)"
  echo ""
  printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
  printf "${BOLD}${GREEN}  offgrid-ai is ready! (dry-run)${RESET}\n"
  printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
  echo ""
  echo "  Run: offgrid-ai"
  echo ""
  exit 0
fi

if command -v offgrid-ai &>/dev/null; then
  ok "offgrid-ai installed at $(command -v offgrid-ai)"
else
  # Might not be on PATH yet — check common locations
  NPM_BIN="$(npm config get prefix 2>/dev/null || echo '')/bin"
  if [[ -x "$NPM_BIN/offgrid-ai" ]]; then
    ok "offgrid-ai installed at $NPM_BIN/offgrid-ai"
    echo ""
    warn "offgrid-ai is not on your PATH yet."
    echo "  Add this to your shell profile (~/.zshrc or ~/.bashrc):"
    echo ""
    echo "    export PATH=\"$NPM_BIN:\$PATH\""
    echo ""
    echo "  Then open a new terminal and run: offgrid-ai"
    exit 0
  fi

  echo ""
  warn "offgrid-ai was installed but is not on your PATH."
  echo "  Open a new terminal and run: offgrid-ai"
  echo "  If that doesn't work, run: npm install -g offgrid-ai"
  exit 0
fi

# ── Run it ──────────────────────────────────────────────────────────────────

echo ""
printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}${GREEN}  offgrid-ai is ready!${RESET}\n"
printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
echo ""
echo "  Run: offgrid-ai"
echo ""
echo "  First run will walk you through setting up everything you need."
echo "  (llama-server, model backends, Pi integration)"
echo ""

# Ask if they want to run it now
if [[ -t 0 ]] && ! $SKIP_RUN && ! $DRY_RUN; then
  printf "${BOLD}Run offgrid-ai now? [Y/n]${RESET} "
  read -r response
  response="${response:-Y}"
  if [[ "$response" =~ ^[Yy]$ ]]; then
    exec offgrid-ai
  fi
fi