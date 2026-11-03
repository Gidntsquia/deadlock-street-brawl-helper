#!/usr/bin/env bash
# npm run win:mouse -- <exe path (Windows)> <label> : three pointer readings (closed / open / overlay) -> logs/win-mouse.json (appended per label)
set -euo pipefail
cd "$(dirname "$0")/../.."
exe="$1"; label="$2"; mkdir -p logs
tmp="$(mktemp --suffix=.json)"
"/mnt/c/Program Files/nodejs/node.exe" "$(wslpath -w scripts/win/mouse-run.mjs)" "$exe" "$(wslpath -w "$tmp")" "$label"
node -e '
const fs=require("fs");const f="logs/win-mouse.json";
const row=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const rows=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")).filter(r=>r.label!==row.label):[];
rows.push(row);fs.writeFileSync(f,JSON.stringify(rows,null,2)+"\n");
' "$tmp"
rm -f "$tmp"
