#!/usr/bin/env bash
# Runs lint, typecheck, format check and tests in parallel; prints each one's output only if it fails.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
names=(lint typecheck format test)
for n in "${names[@]}"; do
  (npm run --silent "$n" >"$tmp/$n.log" 2>&1; echo $? >"$tmp/$n.rc") &
done
wait
fail=0
for n in "${names[@]}"; do
  if [ "$(cat "$tmp/$n.rc")" != 0 ]; then fail=1; echo "== $n FAILED"; cat "$tmp/$n.log"; else echo "ok  $n"; fi
done
exit $fail
