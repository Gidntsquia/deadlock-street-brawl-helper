#!/usr/bin/env bash
# Syncs to the Windows-side copy and starts the app in dev mode there — this is the user's normal launch
# command, run from WSL. `dev:electron` run directly inside WSL boots Linux Electron under WSLg instead
# (findGameWindow always returns null off win32); this script is what actually runs Windows Electron.
set -euo pipefail

WIN_COPY="/mnt/c/Users/Jaxon/brawl-helper-win"
WIN_COPY_WIN=$(wslpath -w "$WIN_COPY")

"$(dirname "${BASH_SOURCE[0]}")/sync.sh"

powershell.exe -NoProfile -Command \
  "\$env:Path = 'C:\Program Files\nodejs;' + \$env:Path; Set-Location '$WIN_COPY_WIN'; & 'C:\Program Files\nodejs\npm.cmd' run dev:electron"
