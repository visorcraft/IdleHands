#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Ensure gitleaks exists in CI image step that runs this script.
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "[ERROR] gitleaks not found in PATH"
  exit 1
fi

echo "[1/3] Running gitleaks secret scan..."
gitleaks detect --source . --no-git --verbose

echo "[2/3] Running hard banned-term scan..."
# Disallow concrete secret/key leakage patterns.
# NOTE: generic example paths (e.g. /home/user/...) are allowed in docs/tests.
BANNED='(BEGIN [A-Z ]*PRIVATE KEY|ssh-rsa [A-Za-z0-9+/]|ssh-ed25519 [A-Za-z0-9+/]|/root/\.ssh/|/home/[A-Za-z0-9._-]+/\.ssh/id_(rsa|ed25519)(\.pub)?\b|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})'

mapfile -t FILES < <(git ls-files | grep -v '^scripts/security-sweep\.sh$')
FINDINGS=$(grep -nE "$BANNED" "${FILES[@]}" || true)
if [[ -n "$FINDINGS" ]]; then
  echo "[FAIL] banned-term findings:"
  printf '%s\n' "$FINDINGS"
  exit 1
fi

echo "[3/3] Running npm package hygiene check..."
npm pack --dry-run >/dev/null

echo "Security sweep passed."
