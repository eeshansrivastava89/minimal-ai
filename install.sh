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
#   4. Adds npm global bin to PATH if needed
#   5. Runs offgrid-ai
#
# Flags:
#   --dry-run    Show what would happen without making changes
#   --no-run     Install but don't launch offgrid-ai after
#   --help       Show this help
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

  # Source nvm
  if ! $DRY_RUN; then
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
  fi

  # Install Node.js LTS
  info "Installing Node.js LTS..."
  dry nvm install --lts

  # Verify
  if $DRY_RUN || command -v node &>/dev/null; then
    ok "Node.js $(node --version 2>/dev/null || echo 'installed') installed via nvm."
  else
    # nvm added to shell profile but not active in this session
    ok "Node.js installed via nvm."
    echo ""
    warn "Node.js was installed but your shell doesn't see it yet."
    echo "  Restart your terminal, or run: source ~/.nvm/nvm.sh"
    echo "  Then re-run this installer."
    exit 0
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

# ── Determine npm global bin directory ──────────────────────────────────────
# npm bin -g was removed in npm v10+. Fall back to $(npm prefix -g)/bin.

NPM_BIN=""
if command -v npm &>/dev/null; then
  # Try the modern way first, then legacy
  NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
  if [[ -n "$NPM_PREFIX" ]]; then
    NPM_BIN="${NPM_PREFIX%/}/bin"
  fi
  # Validate: the binary should exist there
  if [[ ! -x "$NPM_BIN/offgrid-ai" ]]; then
    NPM_BIN=""
  fi
fi

# ── Add npm global bin to PATH if needed ────────────────────────────────────

INSTALLED_VERSION=""

if [[ -n "$NPM_BIN" && -x "$NPM_BIN/offgrid-ai" ]]; then
  # Get plain version from `offgrid-ai version` output (`offgrid-ai vX.Y.Z`).
  INSTALLED_VERSION="$(OFFGRID_NO_UPDATE_CHECK=1 "$NPM_BIN/offgrid-ai" version 2>/dev/null | sed -E 's/^offgrid-ai v//' || echo "")"

  if command -v offgrid-ai &>/dev/null; then
    # Already on PATH — nothing to do
    ok "offgrid-ai ${INSTALLED_VERSION:+v${INSTALLED_VERSION} }installed at $(command -v offgrid-ai)"
  else
    # Not on PATH — add it
    export PATH="$NPM_BIN:$PATH"
    ok "Added $NPM_BIN to PATH for this session"
    ok "offgrid-ai ${INSTALLED_VERSION:+v${INSTALLED_VERSION} }installed"

    # Add to shell config for future sessions (pick first existing or .zshrc)
    ADDED_TO_RC=false
    # Respect user's shell preference; default to .zshrc on macOS
    [[ "$OSTYPE" == darwin* ]] && [[ -z "$DEFAULT_RC" ]] && DEFAULT_RC="$HOME/.zshrc"
    RC_CANDIDATES=("${DEFAULT_RC:-}" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile")
    for RC_FILE in "${RC_CANDIDATES[@]}"; do
      [[ -z "$RC_FILE" ]] && continue
      if [[ -f "$RC_FILE" || "$RC_FILE" == "$HOME/.zshrc" ]]; then
        if ! grep -qF "$NPM_BIN" "$RC_FILE" 2>/dev/null; then
          { echo ''; echo '# Added by offgrid-ai installer'; echo "export PATH=\"$NPM_BIN:\$PATH\""; } >> "$RC_FILE"
          ok "Added $NPM_BIN to $RC_FILE"
          ADDED_TO_RC=true
          # Only add to one rc file to avoid duplicates
          break
        fi
      fi
    done

    if ! $ADDED_TO_RC; then
      warn "$NPM_BIN is already in a shell config file — restart your terminal to use offgrid-ai"
    fi
  fi
else
  # Fallback: try to find it anywhere on PATH after install
  if command -v offgrid-ai &>/dev/null; then
    INSTALLED_VERSION="$(OFFGRID_NO_UPDATE_CHECK=1 offgrid-ai version 2>/dev/null | sed -E 's/^offgrid-ai v//' || echo "")"
    ok "offgrid-ai ${INSTALLED_VERSION:+v${INSTALLED_VERSION} }installed at $(command -v offgrid-ai)"
  else
    echo ""
    warn "offgrid-ai was installed but could not be found."
    echo "  Restart your terminal and run: offgrid-ai"
    echo "  Or run: npx offgrid-ai"
    echo ""
    printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
    printf "${BOLD}${GREEN}  offgrid-ai is installed!${RESET}\n"
    printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
    echo ""
    echo "  Run: offgrid-ai"
    echo ""
    exit 0
  fi
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
if command -v offgrid-ai &>/dev/null; then
  echo "  Run: offgrid-ai"
else
  echo "  Run: source ~/.zshrc && offgrid-ai"
  echo "  (or open a new terminal)"
fi
echo ""

if [[ -t 0 ]] && ! $SKIP_RUN; then
  printf "${BOLD}Run offgrid-ai now? [Y/n]${RESET} "
  read -r response
  response="${response:-Y}"
  if [[ "$response" =~ ^[Yy]$ ]]; then
    exec offgrid-ai
  fi
fi