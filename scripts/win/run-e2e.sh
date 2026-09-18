#!/usr/bin/env bash
# Syncs+builds on the Windows-side copy, runs the harness with real Windows electron.exe, and copies the
# JSON report back to this repo's logs/. Exits non-zero if any check failed (or the process itself failed).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WIN_COPY="/mnt/c/Users/Jaxon/brawl-helper-win"
WIN_COPY_WIN=$(wslpath -w "$WIN_COPY")

"$(dirname "${BASH_SOURCE[0]}")/sync.sh" || exit 1

# Recompute each labelled frame's independent engine verdict (in-process, not via the CLI -- see
# scripts/win/compute-verdicts.ts) and stage it into the Windows copy's logs/, since sync.sh's rsync
# excludes logs/ and the Windows-side harness (running as electron.exe over there) has no way to reach
# back into this WSL process to compute it itself.
npx tsx "$REPO_ROOT/scripts/win/compute-verdicts.ts" || exit 1
mkdir -p "$WIN_COPY/logs"
cp "$REPO_ROOT/logs/win-e2e-verdicts.json" "$WIN_COPY/logs/win-e2e-verdicts.json"

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
if [ -f "$WIN_COPY/logs/win-e2e-debug.log" ]; then
  cp "$WIN_COPY/logs/win-e2e-debug.log" "$REPO_ROOT/logs/win-e2e-debug.log"
fi

exit $EXIT_CODE
