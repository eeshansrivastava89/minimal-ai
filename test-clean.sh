#!/usr/bin/env bash
# test-clean.sh — run offgrid-ai as a brand new user
# Strips Homebrew and llama-server from PATH, isolates data dir
#
# Usage:
#   ./test-clean.sh              # fresh user, nothing installed
#   ./test-clean.sh --with-brew  # has Homebrew but no llama-server
#   ./test-clean.sh --with-llama # has Homebrew + llama-server

set -euo pipefail

CLEAN_HOME="$(mktemp -d /tmp/offgrid-test-home-XXXXXX)"
CLEAN_DATA="$(mktemp -d /tmp/offgrid-test-data-XXXXXX)"

# Clean PATH: just system dirs, no Homebrew, no user bins
# This makes `which brew` and `which llama-server` fail
CLEAN_PATH="/usr/bin:/bin:/usr/sbin:/sbin"

# If --with-brew, add Homebrew back
if [[ "${1:-}" == "--with-brew" || "${1:-}" == "--with-llama" ]]; then
  if [[ -f /opt/homebrew/bin/brew ]]; then
    CLEAN_PATH="/opt/homebrew/bin:$CLEAN_PATH"
  elif [[ -f /usr/local/bin/brew ]]; then
    CLEAN_PATH="/usr/local/bin:$CLEAN_PATH"
  fi
fi

# If --with-llama, add llama-server to PATH
if [[ "${1:-}" == "--with-llama" ]]; then
  LLAMA_DIR="$(dirname "$(find /opt/homebrew /usr/local /Users -name 'llama-server' -type f 2>/dev/null | head -1)" 2>/dev/null || true)"
  if [[ -n "$LLAMA_DIR" && -d "$LLAMA_DIR" ]]; then
    CLEAN_PATH="$LLAMA_DIR:$CLEAN_PATH"
  fi
fi

# Also add Node.js (need it to run offgrid-ai itself)
NODE_BIN="$(dirname "$(which node)")"
CLEAN_PATH="$NODE_BIN:$CLEAN_PATH"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Clean room test environment"
echo "  HOME=$CLEAN_HOME"
echo "  OFFGRID_DIR=$CLEAN_DATA"
echo "  PATH=$CLEAN_PATH"
echo ""
echo "  Simulating: ${1:-brand new user (nothing installed)}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

OFFGRID_DIR="$CLEAN_DATA" \
HOME="$CLEAN_HOME" \
PATH="$CLEAN_PATH" \
LLAMA_SERVER_BINARY="" \
node "$(dirname "$0")/bin/offgrid-ai.mjs" "${@:2}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Test data: $CLEAN_DATA"
echo "  Clean up:  rm -rf $CLEAN_HOME $CLEAN_DATA"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"