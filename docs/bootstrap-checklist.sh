#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# IdleHands benchmark bootstrap checklist (sanitized)
# -----------------------------------------------------------------------------

REPO_DIR="${REPO_DIR:-/mnt/user/downloads/idlehands}"
GATEWAY_PORT="${GATEWAY_PORT:-1013}"
GATEWAY_TOKEN="${IDLEHANDS_GATEWAY_TOKEN:-}"
LLAMA_HEALTH_URL="${LLAMA_HEALTH_URL:-http://127.0.0.1:8082/health}"

echo "== IdleHands Bootstrap Checklist =="
echo "Repo: ${REPO_DIR}"
echo "Gateway port: ${GATEWAY_PORT}"
echo "Llama health URL: ${LLAMA_HEALTH_URL}"
echo

if [[ -z "${GATEWAY_TOKEN}" ]]; then
  echo "[ERROR] IDLEHANDS_GATEWAY_TOKEN is not set."
  echo "        export IDLEHANDS_GATEWAY_TOKEN='<your_token>'"
  exit 1
fi

if [[ ! -d "${REPO_DIR}" ]]; then
  echo "[ERROR] Repo dir not found: ${REPO_DIR}"
  exit 1
fi

command -v idlehands >/dev/null || { echo "[ERROR] idlehands CLI not found in PATH"; exit 1; }
command -v git >/dev/null || { echo "[ERROR] git not found"; exit 1; }
command -v curl >/dev/null || { echo "[ERROR] curl not found"; exit 1; }

echo "[1/6] Checking for stray agent/test processes..."
STRAYS="$(ps -eo pid,args | grep -E 'idlehands agent|node --test|npm test' | grep -v grep || true)"
if [[ -n "${STRAYS}" ]]; then
  echo "[WARN] Found possible stray processes:"
  echo "${STRAYS}"
  echo
  echo "Kill suggestion:"
  echo "  pkill -f 'idlehands agent' || true"
  echo "  pkill -f 'node --test' || true"
  echo "  pkill -f 'npm test' || true"
else
  echo "[OK] No obvious stray agent/test processes"
fi

echo

echo "[2/6] Checking gateway health..."
if idlehands gateway health --port "${GATEWAY_PORT}" --token "${GATEWAY_TOKEN}" >/tmp/idlehands-gateway-health.txt 2>&1; then
  echo "[OK] Gateway healthy"
else
  echo "[ERROR] Gateway health check failed"
  cat /tmp/idlehands-gateway-health.txt || true
  exit 1
fi

echo

echo "[3/6] Checking llama-server health..."
LLAMA_HEALTH="$(curl -sS "${LLAMA_HEALTH_URL}" || true)"
if echo "${LLAMA_HEALTH}" | grep -q '"status":"ok"'; then
  echo "[OK] llama-server healthy: ${LLAMA_HEALTH}"
else
  echo "[ERROR] llama-server unhealthy or unreachable"
  echo "Response: ${LLAMA_HEALTH}"
  exit 1
fi

echo

echo "[4/6] Checking git worktree state..."
cd "${REPO_DIR}"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "[WARN] Working tree is dirty:"
  git status --short
  echo "If this should be a clean benchmark run, reset first:"
  echo "  git reset --hard HEAD && git clean -fd"
else
  echo "[OK] Working tree clean"
fi

echo

echo "[5/6] Verifying template expectation reminder..."
echo "[INFO] Ensure llama-server was started with:"
echo "       --jinja --chat-template-file /home/<user>/.idlehands/templates/qwen3.jinja"

echo

echo "[6/6] Quick repo sanity..."
if [[ -f package.json ]]; then
  echo "[OK] package.json found"
else
  echo "[ERROR] package.json not found in repo root"
  exit 1
fi

echo
echo "Bootstrap checklist complete."
