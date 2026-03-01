#!/usr/bin/env bash
set -euo pipefail

cd /repo

export IDLEHANDS_STATE_DIR="/tmp/idlehands-test"
export IDLEHANDS_CONFIG_PATH="${IDLEHANDS_STATE_DIR}/idlehands.json"

echo "==> Build"
pnpm build

echo "==> Seed state"
mkdir -p "${IDLEHANDS_STATE_DIR}/credentials"
mkdir -p "${IDLEHANDS_STATE_DIR}/agents/main/sessions"
echo '{}' >"${IDLEHANDS_CONFIG_PATH}"
echo 'creds' >"${IDLEHANDS_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${IDLEHANDS_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm idlehands reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${IDLEHANDS_CONFIG_PATH}"
test ! -d "${IDLEHANDS_STATE_DIR}/credentials"
test ! -d "${IDLEHANDS_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${IDLEHANDS_STATE_DIR}/credentials"
echo '{}' >"${IDLEHANDS_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm idlehands uninstall --state --yes --non-interactive

test ! -d "${IDLEHANDS_STATE_DIR}"

echo "OK"
