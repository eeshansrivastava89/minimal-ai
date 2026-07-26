#!/usr/bin/env bash
# minimal-ai clean-room test environment
#
# Usage:
#   source test-clean.sh        # Enter the clean room
#   minimal-ai                  # Run commands as a new user
#   exit-clean                  # Leave the clean room
#
# Simulates: brand-new Mac (no Homebrew, no llama-server, no models, no Pi)
# Your real system is untouched.

# If already in a clean room, exit first
if [[ -n "$MINIMAL_CLEAN_ROOM" ]]; then
  echo "Already in a clean room. Run exit-clean first."
  return 2>/dev/null || exit 0
fi

# Create clean directories
TEST_HOME="/tmp/minimal-test-home"
TEST_DATA="/tmp/minimal-test-data"
rm -rf "$TEST_HOME" "$TEST_DATA"
mkdir -p "$TEST_HOME" "$TEST_DATA"

# Find the project directory
MINIMAL_DIR_ORIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Build a clean PATH: system dirs + node
NODE_BIN="$(dirname "$(which node)")"
CLEAN_PATH="$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"

# Create a 'minimal-ai' wrapper so the command works naturally
mkdir -p "$TEST_HOME/bin"
cat > "$TEST_HOME/bin/minimal-ai" << EOF
#!/usr/bin/env bash
exec node "$MINIMAL_DIR_ORIG/bin/minimal-ai.mjs" "\$@"
EOF
chmod +x "$TEST_HOME/bin/minimal-ai"

# Save original environment
OLD_HOME="$HOME"
OLD_MINIMAL_DIR="${MINIMAL_DIR:-}"
OLD_PATH="$PATH"
OLD_LLAMA="$LLAMA_SERVER_BINARY"
OLD_PS1="$PS1"

# Set clean environment
export HOME="$TEST_HOME"
export MINIMAL_DIR="$TEST_DATA"
export PATH="$TEST_HOME/bin:$CLEAN_PATH"
export LLAMA_SERVER_BINARY=""
export MINIMAL_CLEAN_ROOM=1
export PS1='\[\033[1;34m\]🧪 clean\[\033[0m\] \$ '

# Create exit-clean function
exit-clean() {
  export HOME="$OLD_HOME"
  export MINIMAL_DIR="$OLD_MINIMAL_DIR"
  export PATH="$OLD_PATH"
  export LLAMA_SERVER_BINARY="$OLD_LLAMA"
  export PS1="$OLD_PS1"
  unset MINIMAL_CLEAN_ROOM
  unset -f exit-clean
  echo ""
  echo "  🧹  Clean room exited. Your real environment is restored."
  echo "  Test data: $TEST_DATA"
  echo "  Clean up:  rm -rf $TEST_HOME $TEST_DATA"
}

echo ""
echo "  ┌──────────────────────────────────────────────────────────────┐"
echo "  │                                                              │"
echo "  │   🧪  minimal-ai clean-room test environment                │"
echo "  │                                                              │"
echo "  │   Simulating: brand-new Mac with nothing installed            │"
echo "  │   No Homebrew · No llama-server · No models · No Pi config   │"
echo "  │                                                              │"
echo "  │   Your real system is untouched.                            │"
echo "  │                                                              │"
echo "  │   Try these commands:                                        │"
echo "  │     minimal-ai          # main interactive flow              │"
echo "  │     minimal-ai status   # show running servers              │"
echo "  │     minimal-ai stop     # stop a server                    │"
echo "  │     minimal-ai help     # show help                         │"
echo "  │                                                              │"
echo "  │   Type exit-clean to leave the clean room.                  │"
echo "  │                                                              │"
echo "  └──────────────────────────────────────────────────────────────┘"
echo ""