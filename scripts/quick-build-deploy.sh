#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "Node.js is required to run quick deploy. Install Node.js 20 with nvm install 20 && nvm use 20, or brew install node@20." >&2
  exit 1
fi

exec node "${PROJECT_ROOT}/scripts/quick-build-deploy.mjs" "$@"
