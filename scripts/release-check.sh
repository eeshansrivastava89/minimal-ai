#!/usr/bin/env bash
set -euo pipefail

# offgrid-ai release check
# Validates the package is ready for npm publish.
# Usage: scripts/release-check.sh [--skip-install] [--skip-manual]

SKIP_INSTALL=0
SKIP_MANUAL=0
start_ts="$(date +%s)"

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_RED=""; C_YELLOW=""; C_BLUE=""
fi

SUMMARY=()
FAILED_STEP=""

for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-manual|--no-manual) SKIP_MANUAL=1 ;;
    --help|-h)
      cat <<'EOF'
Usage: scripts/release-check.sh [--skip-install] [--skip-manual]

Options:
  --skip-install   Skip `npm ci`
  --skip-manual    Skip interactive manual checklist
  --help, -h       Show this help
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      echo "Run with --help for usage."
      exit 1
      ;;
  esac
done

export PAGER=cat GIT_PAGER=cat GH_PAGER=cat

add_summary() {
  local name="$1"; local status="$2"; local detail="$3"
  SUMMARY+=("${name}|${status}|${detail}")
}

print_header() {
  printf '\n%s%s%s\n' "$C_BOLD" "offgrid-ai Release Check" "$C_RESET"
  printf '%s\n' "------------------------------------------------------------------"
}

print_step() { printf '\n%s[%s]%s %s\n' "$C_BLUE" "STEP" "$C_RESET" "$1"; }
print_cmd()  { printf '$ %s\n' "$*"; }
print_ok()   { printf '%s[PASS]%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
print_warn() { printf '%s[WARN]%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
print_fail() { printf '%s[FAIL]%s %s\n' "$C_RED" "$C_RESET" "$1"; }

run_check() {
  local name="$1"; shift
  local t0; t0="$(date +%s)"
  print_cmd "$@"
  if "$@"; then
    local dt=$(( $(date +%s) - t0 ))
    add_summary "$name" "PASS" "${dt}s"
    print_ok "$name (${dt}s)"
  else
    local rc=$?
    local dt=$(( $(date +%s) - t0 ))
    FAILED_STEP="$name"
    add_summary "$name" "FAIL" "exit ${rc}, ${dt}s"
    print_fail "$name (exit ${rc}, ${dt}s)"
    exit "$rc"
  fi
}

print_summary() {
  local exit_code="$1"
  local total_dt=$(( $(date +%s) - start_ts ))
  printf '\n%s%s%s\n' "$C_BOLD" "Release Check Summary" "$C_RESET"
  printf '%s\n' "------------------------------------------------------------------"
  printf '%-42s %-8s %s\n' "Check" "Result" "Details"
  printf '%s\n' "------------------------------------------------------------------"
  for row in "${SUMMARY[@]}"; do
    local name status detail
    IFS='|' read -r name status detail <<< "$row"
    printf '%-42s %-8s %s\n' "$name" "$status" "$detail"
  done
  printf '%s\n' "------------------------------------------------------------------"
  if [[ "$exit_code" -eq 0 ]]; then
    printf '%s[PASS]%s All checks passed in %ss\n' "$C_GREEN" "$C_RESET" "$total_dt"
    echo "Ready to commit, push, tag, and publish."
  else
    printf '%s[FAIL]%s Failed at: %s (after %ss)\n' "$C_RED" "$C_RESET" "${FAILED_STEP:-unknown}" "$total_dt"
  fi
}

on_exit() {
  local exit_code="$?"
  print_summary "$exit_code"
}

trap 'on_exit' EXIT

if [[ ! -f "package.json" ]]; then
  print_fail "Run this script from the repository root."
  exit 1
fi

print_header

# ── 1. Repo status ──────────────────────────────────────────────────

print_step "Repo diff review"
run_check "Git status" git --no-pager status --short
run_check "Git diff stat" git --no-pager diff --stat

# ── 2. Install ───────────────────────────────────────────────────────

print_step "Dependencies"
if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  run_check "npm ci" npm ci
else
  add_summary "npm ci" "SKIP" "--skip-install"
  print_warn "Skipping npm ci (--skip-install)"
fi

# ── 3. Privacy gate ──────────────────────────────────────────────────

print_step "Privacy & artifact gate"
run_check "Privacy gate" npm run check:privacy

# ── 4. Package contents ─────────────────────────────────────────────

print_step "Package contents check"
run_check "npm pack --dry-run" npm pack --dry-run

pack_file="$(npm pack 2>/dev/null | tail -n 1)"
echo "Pack file: $pack_file"
add_summary "npm pack" "PASS" "$pack_file"
print_ok "Pack file created: $pack_file"

print_cmd tar -tf "$pack_file"
tar -tf "$pack_file"
if tar -tf "$pack_file" | grep -E -q '(^|/)\.env($|\.|/)|(^|/)PLAN\.md($|/)|(^|/)Dockerfile($|/)|(^|/)test-clean\.sh($|/)|(^|/)\.pi(/|$)'; then
  add_summary "Package file audit" "FAIL" "dev-only files found"
  FAILED_STEP="Package file audit"
  print_fail "Dev-only files detected in package."
  exit 1
fi
add_summary "Package file audit" "PASS" "no dev-only files"
print_ok "Package file audit passed"

# ── 5. Smoke test ────────────────────────────────────────────────────

print_step "CLI smoke test"

run_check "offgrid-ai --help" node bin/offgrid-ai.mjs --help
run_check "offgrid-ai --version" node bin/offgrid-ai.mjs --version

# ── 6. Auth & version checks ─────────────────────────────────────────

print_step "Release auth/version checks"

if command -v gh >/dev/null 2>&1; then
  run_check "GitHub auth" gh auth status
else
  add_summary "GitHub auth" "SKIP" "gh not installed"
  print_warn "gh not found; skipping GitHub auth check."
fi

run_check "npm whoami" npm whoami

current_version="$(node -p "require('./package.json').version")"
add_summary "package.json version" "INFO" "v${current_version}"
print_ok "Package version: v${current_version}"

# Check if this version already exists on npm
if npm view "offgrid-ai@$current_version" version 2>/dev/null; then
  add_summary "Version collision" "FAIL" "v${current_version} already published"
  FAILED_STEP="Version collision"
  print_fail "Version v${current_version} already exists on npm. Bump the version first."
  exit 1
else
  add_summary "Version available" "PASS" "v${current_version} not yet published"
  print_ok "Version v${current_version} is available on npm"
fi

# ── 7. Manual checklist (optional) ───────────────────────────────────

if [[ "$SKIP_MANUAL" -eq 0 ]] && [[ -t 0 ]]; then
  print_step "Manual checklist (interactive)"
  cat <<'EOF'

Manual checks:
  [ ] Run `node bin/offgrid-ai.mjs` — launches onboarding
  [ ] Run `node bin/offgrid-ai.mjs status` — shows status
  [ ] Run `node bin/offgrid-ai.mjs --help` — shows help
  [ ] Verify README.md matches package.json description
  [ ] Verify install.sh raw URL matches current GitHub commit

Type 'yes' to confirm manual checks:
EOF
  read -r manual_answer
  if [[ "$manual_answer" != "yes" ]]; then
    add_summary "Manual checklist" "FAIL" "user did not confirm"
    FAILED_STEP="Manual checklist"
    print_fail "Manual checks not confirmed. Aborting."
    exit 1
  fi
  add_summary "Manual checklist" "PASS" "confirmed by user"
  print_ok "Manual checklist confirmed"
else
  add_summary "Manual checklist" "SKIP" "--skip-manual or non-interactive"
  print_warn "Skipping manual checklist (--skip-manual or non-interactive shell)."
fi

# ── 8. Tag readiness ─────────────────────────────────────────────────

print_step "Git tag check"

latest_tag="$(git describe --tags --abbrev=0 2>/dev/null || echo "none")"
add_summary "Latest tag" "INFO" "$latest_tag"
print_ok "Latest git tag: ${latest_tag}"

echo ""
echo "To publish:"
echo "  1. git tag v${current_version}"
echo "  2. git push origin v${current_version}"
echo "  3. GitHub Actions will publish to npm (or run: npm publish --access public)"
echo ""

# Clean up pack file
rm -f "$pack_file"