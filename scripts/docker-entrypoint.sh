#!/usr/bin/env bash
set -euo pipefail

# Ensure directories exist on host mounts before bun tries to write
mkdir -p "${HOME}/.pi" 2>/dev/null || true
mkdir -p "${HOME}/.pi-web" 2>/dev/null || true
mkdir -p "${HOME}/.pi/agent/sessions" 2>/dev/null || true

exec "$@"
