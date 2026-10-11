// Resolves scripts/winocr.ps1's out.json with the app's matcher; same rules and summary line as name-compare.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { matchItemName, nameList } from '../src/brawl/names';
const dir = process.argv[2]!;
const idx = JSON.parse(readFileSync(`${dir}/index.json`, 'utf8')) as any[];
const out = JSON.parse(readFileSync(`${dir}/out.json`, 'utf8').replace(/^﻿/, '')) as {
  file: string;
  text: string;
  ms: number;
}[];
const items = JSON.parse(readFileSync('public/data/items.json', 'utf8')) as { id: number; name: string }[];
const ids =
  (JSON.parse(readFileSync('public/data/brawl-icons.json', 'utf8')) as { ids?: number[] }).ids ??
  items.map((i) => i.id);
const names = Object.fromEntries(items.map((i) => [i.id, i.name]));
const list = nameList(ids, names);
const rows = idx.map((i) => {
  const o = out.find((x) => x.file === i.file)!;
  const m = matchItemName(o.text, list);
  return {
    frame: i.frame,
    slot: i.slot,
    label: i.label,
    covered: i.covered,
    raw: o.text,
    resolved: m ? names[m.itemId] : null,
    sure: !!m,
    wrong: !!m && (i.covered || names[m.itemId] !== i.label),
    ms: +o.ms.toFixed(1),
  } as any;
});
const g = new Map<string, any[]>();
for (const r of rows) g.set(r.frame, [...(g.get(r.frame) ?? []), r]);
for (const a of g.values())
  for (const r of a)
    if (r.sure && a.some((o) => o !== r && o.sure && o.resolved === r.resolved)) {
      r.sure = false;
      r.wrong = false;
      r.reason = 'duplicate-in-frame';
    }
const lab = rows.filter((r) => !r.covered);
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const summary = {
  engine: 'winocr',
  wrong: rows.filter((r) => r.wrong).length,
  sureRate: +((lab.filter((r) => r.sure && !r.wrong).length / lab.length) * 100).toFixed(1),
  p50: ms[Math.floor(ms.length / 2)],
  p95: ms[Math.floor(ms.length * 0.95)],
};
writeFileSync('logs/name-compare-winocr.json', JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary));
for (const r of rows.filter((r) => r.wrong || (!r.covered && !r.sure)).slice(0, 12))
  console.log(r.wrong ? 'WRONG' : 'unsure', r.label, JSON.stringify(r.raw), r.resolved);
