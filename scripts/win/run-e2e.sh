#!/usr/bin/env bash
# Syncs+builds on the Windows-side copy, runs the harness with real Windows electron.exe, and copies the
# JSON report back to this repo's logs/. Exits non-zero if any check failed (or the process itself failed).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WIN_COPY="/mnt/c/Users/Jaxon/brawl-helper-win"
WIN_COPY_WIN=$(wslpath -w "$WIN_COPY")

"$(dirname "${BASH_SOURCE[0]}")/sync.sh" || exit 1

# "--only a,b" forwarded to e2e-main.cjs unchanged.
EXTRA=""
if [ "${1:-}" = "--only" ]; then
  EXTRA="--only $2"
fi

ELECTRON_BIN="node_modules\\.bin\\electron.cmd"
powershell.exe -NoProfile -Command \
  "\$env:Path = 'C:\Program Files\nodejs;' + \$env:Path; Set-Location '$WIN_COPY_WIN'; & \"$ELECTRON_BIN\" 'scripts\\win\\e2e-main.cjs' $EXTRA; exit \$LASTEXITCODE"
EXIT_CODE=$?

mkdir -p "$REPO_ROOT/logs"
if [ -f "$WIN_COPY/logs/win-e2e.json" ]; then
  cp "$WIN_COPY/logs/win-e2e.json" "$REPO_ROOT/logs/win-e2e.json"
else
  echo "ERROR: no report at $WIN_COPY/logs/win-e2e.json" >&2
  EXIT_CODE=1
fi

exit $EXIT_CODE
