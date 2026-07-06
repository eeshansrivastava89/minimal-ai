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
#   4. Puts offgrid-ai on PATH (symlink or shell config)
#   5. Runs offgrid-ai
#
# Flags:
#   --dry-run    Show what would happen without making changes
#   --no-run     Install but don't launch offgrid-ai after
#   --help       Show this help
#
# This script never uses sudo. Everything installs to user-writable directories.

set -euo pipefail

# Track if we installed Node via nvm (affects PATH setup)
NVM_INSTALLED=false

# ── Flags ───────────────────────────────────────────────────────────────────

DRY_RUN=false
SKIP_RUN=false
DEFAULT_RC="${DEFAULT_RC:-}"

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

NPM_BIN=""
if command -v npm &>/dev/null; then
  NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
  if [[ -n "$NPM_PREFIX" ]]; then
    NPM_BIN="${NPM_PREFIX%/}/bin"
  fi
  if [[ ! -x "$NPM_BIN/offgrid-ai" ]]; then
    NPM_BIN=""
  fi
fi

# ── Put offgrid-ai on PATH ──────────────────────────────────────────────────
#
# When nvm is used, offgrid-ai is on PATH within this script (nvm is sourced
# here), but NOT in the user's current shell. We try, in order:
#   1. Symlink into a writable dir already on the user's PATH (/usr/local/bin,
#      /opt/homebrew/bin) — works immediately, no sourcing needed
#   2. Add the bin dir to .zshrc/.bashrc — works after source or new terminal
#
# When nvm is NOT used (user already had Node), the npm global bin is usually
# already on PATH. If not, we add it to .zshrc/.bashrc.

INSTALLED_VERSION=""

if [[ -n "$NPM_BIN" && -x "$NPM_BIN/offgrid-ai" ]]; then
  INSTALLED_VERSION="$(OFFGRID_NO_UPDATE_CHECK=1 "$NPM_BIN/offgrid-ai" version 2>/dev/null | sed -E 's/^offgrid-ai v//' || echo "")"
  ok "offgrid-ai ${INSTALLED_VERSION:+v${INSTALLED_VERSION} }installed"

  if $NVM_INSTALLED; then
    # nvm case: try symlink first (makes offgrid-ai work in the current shell)
    LINKED=false
    for BIN_DIR in /usr/local/bin /opt/homebrew/bin; do
      if [[ -d "$BIN_DIR" && -w "$BIN_DIR" ]]; then
        ln -sf "$NPM_BIN/offgrid-ai" "$BIN_DIR/offgrid-ai"
        ok "Linked offgrid-ai → $BIN_DIR/offgrid-ai"
        LINKED=true
        break
      fi
    done
    # Fallback: add to shell config for future sessions
    if ! $LINKED; then
      [[ "$OSTYPE" == darwin* ]] && [[ -z "${DEFAULT_RC}" ]] && DEFAULT_RC="$HOME/.zshrc"
      RC_CANDIDATES=("${DEFAULT_RC:-}" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile")
      for RC_FILE in "${RC_CANDIDATES[@]}"; do
        [[ -z "$RC_FILE" ]] && continue
        if [[ -f "$RC_FILE" || "$RC_FILE" == "$HOME/.zshrc" ]]; then
          if ! grep -qF "$NPM_BIN" "$RC_FILE" 2>/dev/null; then
            { echo ''; echo '# Added by offgrid-ai installer'; echo "export PATH=\"$NPM_BIN:\$PATH\""; } >> "$RC_FILE"
            ok "Added $NPM_BIN to $RC_FILE (run: source $RC_FILE)"
          fi
          break
        fi
      done
    fi

  elif ! command -v offgrid-ai &>/dev/null; then
    # Non-nvm case: offgrid-ai not on PATH — add it
    export PATH="$NPM_BIN:$PATH"
    ADDED_TO_RC=false
    [[ "$OSTYPE" == darwin* ]] && [[ -z "${DEFAULT_RC}" ]] && DEFAULT_RC="$HOME/.zshrc"
    RC_CANDIDATES=("${DEFAULT_RC:-}" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile")
    for RC_FILE in "${RC_CANDIDATES[@]}"; do
      [[ -z "$RC_FILE" ]] && continue
      if [[ -f "$RC_FILE" || "$RC_FILE" == "$HOME/.zshrc" ]]; then
        if ! grep -qF "$NPM_BIN" "$RC_FILE" 2>/dev/null; then
          { echo ''; echo '# Added by offgrid-ai installer'; echo "export PATH=\"$NPM_BIN:\$PATH\""; } >> "$RC_FILE"
          ok "Added $NPM_BIN to $RC_FILE"
          ADDED_TO_RC=true
          break
        fi
      fi
    done
    if $ADDED_TO_RC; then
      echo ""
      echo "To use it right now, run:"
      echo "  source ${RC_FILE}"
      echo ""
      echo "Or open a new terminal window/tab."
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

# If the symlink worked, offgrid-ai is on PATH right now.
# If not (nvm + no writable PATH dir), user needs to source .zshrc or new terminal.
if command -v offgrid-ai &>/dev/null; then
  RUN_CMD="offgrid-ai"
  RUN_HINT=""
elif $NVM_INSTALLED; then
  RUN_CMD="source ~/.zshrc && offgrid-ai"
  RUN_HINT="(or open a new terminal window)"
else
  RUN_CMD="offgrid-ai"
  RUN_HINT=""
fi

echo ""
printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
printf "${BOLD}${GREEN}  offgrid-ai ${INSTALLED_VERSION:+v${INSTALLED_VERSION} }is ready!${RESET}\n"
printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
echo ""
echo "  First run will walk you through setting up everything you need"
echo "  (managed llama.cpp runtime for GGUF models, model backends, Pi)."
echo ""
echo "  Run: ${RUN_CMD}"
[[ -n "$RUN_HINT" ]] && echo "  ${RUN_HINT}"
echo ""

# Auto-launch — use /dev/tty so the prompt works even when piped from curl|bash
if ! $SKIP_RUN && [[ -c /dev/tty ]]; then
  printf "${BOLD}Run offgrid-ai now? [Y/n]${RESET} "
  read -r response < /dev/tty
  response="${response:-Y}"
  if [[ "$response" =~ ^[Yy]$ ]]; then
    # Redirect stdin from /dev/tty so offgrid-ai sees a TTY (not the curl pipe)
    exec offgrid-ai < /dev/tty
  fi
fi