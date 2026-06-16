#!/usr/bin/env bash
set -euo pipefail

# Ensure directories exist on host mounts before bun tries to write
mkdir -p "${HOME}/.pi" 2>/dev/null || true
mkdir -p "${HOME}/.pi-web" 2>/dev/null || true
mkdir -p "${HOME}/.pi/agent/sessions" 2>/dev/null || true

# Work around Git's safe.directory check when bind-mounted repos are owned by
# a different UID/GID inside the container.
git config --global --add safe.directory "*" 2>/dev/null || true

exec "$@"
