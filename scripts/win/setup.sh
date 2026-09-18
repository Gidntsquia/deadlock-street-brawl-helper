#!/usr/bin/env bash
# One-time: install Node LTS on the Windows side via winget, so scripts/win/sync.sh and e2e-main.cjs have
# something to run npm/electron with. Idempotent — safe to re-run.
set -euo pipefail

NODE_EXE="/mnt/c/Program Files/nodejs/node.exe"

if [ -x "$NODE_EXE" ]; then
  echo "node already installed on Windows: $("$NODE_EXE" -v)"
  exit 0
fi

echo "Node not found at C:\\Program Files\\nodejs\\node.exe — installing via winget (may show a UAC prompt)…"
powershell.exe -NoProfile -Command \
  "winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements"

if [ ! -x "$NODE_EXE" ]; then
  echo "ERROR: winget reported success but node.exe is still missing at $NODE_EXE" >&2
  exit 1
fi

echo "installed: $("$NODE_EXE" -v)"
