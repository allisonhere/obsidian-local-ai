#!/usr/bin/env bash
# Builds Loom if needed, then starts the installer. Extra arguments go to the installer,
# e.g. ./install.sh --vault ~/Notes --link
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f main.js ]]; then
  echo "Building Loom…"
  npm install --no-audit --no-fund
  npm run build
fi

if ! command -v go >/dev/null; then
  echo "Go is required to run the installer (https://go.dev/dl/)." >&2
  echo "Or install by hand: copy main.js, manifest.json and styles.css into <vault>/.obsidian/plugins/loom/" >&2
  exit 1
fi

cd installer
exec go run . --src "$(cd .. && pwd)" "$@"
