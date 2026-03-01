#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="idlehands-sandbox-browser:bookworm-slim"

docker build -t "${IMAGE_NAME}" -f Dockerfile.sandbox-browser .
echo "Built ${IMAGE_NAME}"
