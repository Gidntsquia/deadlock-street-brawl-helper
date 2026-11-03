#!/usr/bin/env bash
# npm run win:perf -- <exe path (Windows)> <label> : idle cost of one build, appended to logs/win-perf.json.
set -euo pipefail
cd "$(dirname "$0")/../.."
exe="$1"; label="$2"
mkdir -p logs
tmp="$(mktemp)"
load="$(cut -d' ' -f1-3 /proc/loadavg)"
winps="$(wslpath -w "$PWD/scripts/win/perf.ps1")"
winout="$(wslpath -w "$tmp")"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$winps" -Exe "$exe" -Label "$label" -Out "$winout" >/dev/null
node -e '
const fs=require("fs");const f="logs/win-perf.json";
const row=JSON.parse(fs.readFileSync(process.argv[1],"utf8").replace(/^﻿/,""));
row.load_average_wsl=process.argv[2];
const rows=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];
rows.push(row);fs.writeFileSync(f,JSON.stringify(rows,null,2)+"\n");console.log(JSON.stringify(row));
' "$tmp" "$load"
rm -f "$tmp"
