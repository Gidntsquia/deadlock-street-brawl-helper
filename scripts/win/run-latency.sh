#!/usr/bin/env bash
# Headless advice-latency run on the OBS recording (scripts/win/latency-main.cjs): syncs and builds the Windows copy,
# runs real Windows electron.exe under BRAWL_E2E (nothing shows on the desktop) and copies logs/win-latency.json back.
# Started by hand only (the worker or the user): never part of npm test, npm run check, win:e2e or CI.
# Flags: --only s7[,s3]  --runs N  --video "<Windows path>"
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WIN_COPY="/mnt/c/Users/Jaxon/brawl-helper-win"
WIN_COPY_WIN=$(wslpath -w "$WIN_COPY")

"$(dirname "${BASH_SOURCE[0]}")/sync.sh" || exit 1

COMMIT=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- src electron scripts)" ]; then COMMIT="$COMMIT+dirty"; fi
EXTRA="--commit '$COMMIT'"
while [ $# -gt 0 ]; do
  case "$1" in
    --only) EXTRA="$EXTRA --only '$2'"; shift 2 ;;
    --runs) EXTRA="$EXTRA --runs '$2'"; shift 2 ;;
    --video) EXTRA="$EXTRA --video '$2'"; shift 2 ;;
    *) shift ;;
  esac
done

rm -f "$WIN_COPY/logs/win-latency.json"
ELECTRON_BIN="node_modules\\.bin\\electron.cmd"
powershell.exe -NoProfile -Command \
  "\$env:Path = 'C:\Program Files\nodejs;' + \$env:Path; Set-Location '$WIN_COPY_WIN'; & \"$ELECTRON_BIN\" 'scripts\\win\\latency-main.cjs' $EXTRA; exit \$LASTEXITCODE"
EXIT_CODE=$?

mkdir -p "$REPO_ROOT/logs"
if [ -f "$WIN_COPY/logs/win-latency.json" ]; then
  cp "$WIN_COPY/logs/win-latency.json" "$REPO_ROOT/logs/win-latency.json"
else
  echo "ERROR: no report at $WIN_COPY/logs/win-latency.json" >&2
  EXIT_CODE=1
fi
[ -f "$WIN_COPY/logs/win-latency-debug.log" ] && cp "$WIN_COPY/logs/win-latency-debug.log" "$REPO_ROOT/logs/win-latency-debug.log"
exit $EXIT_CODE
