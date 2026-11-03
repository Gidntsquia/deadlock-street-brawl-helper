#!/usr/bin/env bash
# npm run win:release-build : builds the PRODUCTION app (no BRAWL_DEVTOOLS) in the Windows copy and packages the
# installer, portable exe and win-unpacked into C:\Users\Jaxon\brawl-helper-rel\release (outside the copy, so the
# harness builds there keep their dev tooling). Prints the dev-token count of the extracted app.asar (must be 0).
set -euo pipefail
cd "$(dirname "$0")/../.."
bash scripts/win/sync.sh
WIN_COPY="/mnt/c/Users/Jaxon/brawl-helper-win"
WIN_COPY_WIN=$(wslpath -w "$WIN_COPY")
REL_WIN='C:\Users\Jaxon\brawl-helper-rel'
PREFIX="\$env:Path = 'C:\Program Files\nodejs;' + \$env:Path; Set-Location '$WIN_COPY_WIN'; Remove-Item Env:BRAWL_DEVTOOLS -ErrorAction SilentlyContinue;"
powershell.exe -NoProfile -Command "$PREFIX & 'C:\Program Files\nodejs\npm.cmd' exec -- vite build; & 'C:\Program Files\nodejs\npm.cmd' exec -- vite build --mode electron" || exit 1
powershell.exe -NoProfile -Command "$PREFIX & 'C:\Program Files\nodejs\npm.cmd' exec -- electron-builder --win --publish never --config.directories.output=$REL_WIN\\release" || exit 1
# the next harness sync must rebuild with the dev tooling
rm -f "$WIN_COPY/.build.hash"
REL="/mnt/c/Users/Jaxon/brawl-helper-rel/release"
rm -rf "$REL/asar-check"
powershell.exe -NoProfile -Command "$PREFIX & 'C:\Program Files\nodejs\npm.cmd' exec -- asar extract '$REL_WIN\\release\\win-unpacked\\resources\\app.asar' '$REL_WIN\\release\\asar-check'" || exit 1
printf 'dev tokens in app.asar: '
grep -rc 'brawlE2E\|debugToggle\|sessionStore\|testModeVideo' "$REL/asar-check" | awk -F: '{s+=$NF} END {print s}'
ls "$REL"
