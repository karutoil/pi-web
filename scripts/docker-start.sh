#!/usr/bin/env bash
set -euo pipefail

PI_BINARY_PATH=$(command -v pi || true)
if [[ -z "${PI_BINARY_PATH}" ]]; then
  echo "Warning: pi binary not found on host. Agents and pi commands may not work inside the container." >&2
  PI_BINARY_DIR=""
else
  PI_BINARY_DIR=$(dirname "${PI_BINARY_PATH}")
fi

export DOCKER_UID="${UID:-$(id -u)}"
export DOCKER_GID="${GID:-$(id -g)}"
export HOME="${HOME:-$(echo ~)}"
export PI_BINARY_DIR

cd "$(dirname "$0")/.."

# Ensure host directories exist for Docker volume mounts
mkdir -p "${HOME}/.pi"
mkdir -p "${HOME}/.pi-web"

docker compose up --build -d

RANDOM_PORT=$(docker compose port pi-web 3069 | cut -d: -f2)
echo "PI Web running at http://localhost:${RANDOM_PORT}"
