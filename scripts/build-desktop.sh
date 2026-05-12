#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ARCH="$(uname -m)"

case "${ARCH}" in
  arm64|aarch64) TARGET_ARCH="arm64" ;;
  x86_64|amd64) TARGET_ARCH="x64" ;;
  *)
    printf 'Unsupported macOS architecture: %s\n' "${ARCH}" >&2
    exit 1
    ;;
esac

cd "${PROJECT_ROOT}"
npm run desktop:target -- --platform darwin --arch "${TARGET_ARCH}"
