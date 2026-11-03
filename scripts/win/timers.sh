#!/usr/bin/env bash
# npm run win:timers -- <exe path (Windows)> <label> : timers armed during a 60 s idle stretch -> logs/win-timers.json
set -euo pipefail
cd "$(dirname "$0")/../.."
exe="$1"; label="$2"; mkdir -p logs
tmp="$(mktemp --suffix=.json)"
"/mnt/c/Program Files/nodejs/node.exe" "$(wslpath -w scripts/win/timers-run.mjs)" "$exe" "$(wslpath -w "$tmp")" "$label"
node -e '
const fs=require("fs");const f="logs/win-timers.json";
const row=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const rows=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")).filter(r=>r.label!==row.label):[];
rows.push(row);fs.writeFileSync(f,JSON.stringify(rows,null,2)+"\n");
' "$tmp"
rm -f "$tmp"
