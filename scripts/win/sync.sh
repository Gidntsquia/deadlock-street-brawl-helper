#!/usr/bin/env bash
# Rsyncs this repo to a Windows-side working copy (Electron/koffi only run for real on win32; `\\wsl$\`
# paths are unreliable for `npm ci`/native modules), then npm ci (only when package-lock.json changed) and
# builds the Electron bundle there.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WIN_COPY="/mnt/c/Users/Jaxon/brawl-helper-win"
NODE="/mnt/c/Program Files/nodejs/node.exe"

if [ ! -x "$NODE" ]; then
  echo "ERROR: Node not installed on Windows. Run: npm run win:setup" >&2
  exit 1
fi

mkdir -p "$WIN_COPY"
rsync -a --delete \
  --exclude node_modules --exclude .git --exclude dist --exclude electron-dist \
  --exclude release --exclude plans --exclude screenshots --exclude logs \
  --exclude .package-lock.hash --exclude .public.hash --exclude .build.hash --exclude /public \
  "$REPO_ROOT"/ "$WIN_COPY"/

# public/ is ~50 MB of data and images that rarely change; scanning it over /mnt/c costs seconds, so only sync it
# when a fingerprint of the WSL-side tree (path, size, mtime) changed.
PUB_HASH=$(cd "$REPO_ROOT" && find public -type f -printf '%p %s %T@\n' | sort | sha256sum | awk '{print $1}')
if [ "$PUB_HASH" != "$(cat "$WIN_COPY/.public.hash" 2>/dev/null || echo)" ] || [ ! -d "$WIN_COPY/public" ]; then
  rsync -a --delete "$REPO_ROOT"/public/ "$WIN_COPY"/public/
  echo "$PUB_HASH" > "$WIN_COPY/.public.hash"
fi

WIN_COPY_WIN=$(wslpath -w "$WIN_COPY")
LOCK_HASH_FILE="$WIN_COPY/.package-lock.hash"
NEW_HASH=$(sha256sum "$REPO_ROOT/package-lock.json" | awk '{print $1}')
OLD_HASH=$(cat "$LOCK_HASH_FILE" 2>/dev/null || echo "")

# npm ci's own child processes (koffi's prebuild step, etc.) call `node` by bare name, so PATH must
# have the Windows node dir — the existing session PATH is stale/doesn't have it (this is a fresh install).
PREFIX="\$env:Path = 'C:\Program Files\nodejs;' + \$env:Path; Set-Location '$WIN_COPY_WIN';"

if [ "$NEW_HASH" != "$OLD_HASH" ] || [ ! -d "$WIN_COPY/node_modules" ]; then
  echo "package-lock.json changed (or no node_modules yet) — running npm ci on Windows…"
  powershell.exe -NoProfile -Command "$PREFIX & 'C:\Program Files\nodejs\npm.cmd' ci"
  echo "$NEW_HASH" > "$LOCK_HASH_FILE"
else
  echo "package-lock.json unchanged — skipping npm ci"
fi

# The Windows-side vite build takes ~5 s; skip it when nothing it reads has changed since the last build.
BUILD_HASH=$(cd "$REPO_ROOT" && { find src electron -type f -printf '%p %s %T@\n'; ls -l --time-style=+%s.%N index.html vite.config.ts tsconfig*.json package.json package-lock.json; echo "$PUB_HASH"; } | sort | sha256sum | awk '{print $1}')
if [ "$BUILD_HASH" = "$(cat "$WIN_COPY/.build.hash" 2>/dev/null || echo)" ] && [ -f "$WIN_COPY/electron-dist/main.js" ]; then
  echo "sources unchanged — skipping electron build"
else
  echo "building electron bundle on Windows…"
  powershell.exe -NoProfile -Command "$PREFIX & 'C:\Program Files\nodejs\npm.cmd' exec -- vite build --mode electron" || exit 1
  echo "$BUILD_HASH" > "$WIN_COPY/.build.hash"
fi

echo "synced and built at $WIN_COPY ($WIN_COPY_WIN)"
