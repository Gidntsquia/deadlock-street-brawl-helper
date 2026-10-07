// Builds the release read report: every draft of the given session folders replayed on the current code, with the card crops
// beside what was read and a verdict from a hand-written verdicts.json. Usage:
//   npx tsx scripts/release-report.ts <out dir> <verdicts.json> <session folder>...
// Not part of the app or the test suite.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { replaySession, replayDraft, type ReplayDraft } from './replay';
import type { Item, Hero } from '../src/types';

const [out, verdictFile, ...folders] = process.argv.slice(2);
if (!out || !verdictFile || !folders.length) {
  console.error('usage: release-report.ts <out dir> <verdicts.json> <session folder>...');
  process.exit(2);
}
const items: Item[] = JSON.parse(readFileSync('public/data/items.json', 'utf8'));
const heroes: Hero[] = JSON.parse(readFileSync('public/data/heroes.json', 'utf8'));
const iname = (id: number) => (id ? (items.find((i) => i.id === id)?.name ?? `#${id}`) : '?');
const hname = (id: number) => (id ? (heroes.find((h) => h.id === id)?.name ?? `#${id}`) : 'not read');
const verdicts: Record<string, string> = existsSync(verdictFile) ? JSON.parse(readFileSync(verdictFile, 'utf8')) : {};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

mkdirSync(path.join(out, 'crops'), { recursive: true });
interface Row {
  key: string;
  session: string;
  d: ReplayDraft;
  crops: string[];
  verdict: string;
  held: number;
}
const rows: Row[] = [];
const owned: { session: string; ids: number[] | null }[] = [];
for (const folder of folders) {
  const session = path.basename(folder);
  const drafts = await replaySession(folder, { waitNames: true });
  for (let d of drafts) {
    // a recording that ends before the settle time (the player picked at once): read the clearest frame as a screen that stays up
    let held = -1;
    if (!d.stats.items.length) {
      const last = JSON.parse(readFileSync(path.join(folder, d.name, 'frames.json'), 'utf8')).length - 1;
      for (const at of new Set([d.lastFull, last])) {
        if (at < 0 || held >= 0) continue;
        const h = await replayDraft(path.join(folder, d.name), { waitNames: true, hold: at });
        if (!h.stats.items.length) continue;
        held = at;
        d = { ...h, name: d.name, live: d.live, diff: d.diff, lastFull: d.lastFull, acceptFrame: held };
      }
    }
    const dir = path.join(folder, d.name);
    const frames: { regions: { index: number; file: string }[] }[] = JSON.parse(
      readFileSync(path.join(dir, 'frames.json'), 'utf8'),
    );
    // the frame the set was accepted on; when nothing was, the last frame that still has the three card crops
    let fi = d.acceptFrame;
    if (fi < 0)
      fi = Math.max(
        0,
        frames.findLastIndex((f) => [0, 1, 2].every((k) => f.regions.some((r) => r.index === k))),
      );
    const crops: string[] = [];
    for (const k of [0, 1, 2]) {
      const r = frames[fi]?.regions.find((x) => x.index === k);
      const name = `${session}-${d.name}-c${k}.png`;
      if (r && existsSync(path.join(dir, r.file)))
        await sharp(path.join(dir, r.file))
          .resize({ width: 190 })
          .png()
          .toFile(path.join(out, 'crops', name));
      crops.push(`crops/${name}`);
    }
    const key = `${session}/${d.name}`;
    rows.push({ key, session, d, crops, verdict: verdicts[key] ?? '', held });
  }
  owned.push({ session, ids: drafts.findLast((x) => x.inventory)?.inventory ?? null });
}

const kind = (v: string) =>
  v.startsWith('Right') ? 'right' : v.startsWith('Wrong') ? 'wrong' : v.startsWith('Unsure') ? 'unsure' : 'none';
const count = (k: string) => rows.filter((r) => kind(r.verdict) === k).length;
const qs = rows.reduce((a, r) => a + r.d.stats.unsure, 0);
const body = rows
  .map(({ key, d, crops, verdict, held }) => {
    const s = d.stats;
    const take = d.live.shown.takeId;
    return `<tr class="${kind(verdict)}"><td>${esc(key)}<br>R${d.round} C${d.choice}</td>
<td class="crops">${crops.map((c) => `<img src="${c}" alt="">`).join('')}</td>
<td>${s.items.length ? s.items.map((id) => esc(iname(id))).join('<br>') + (held >= 0 ? `<br><small>recording too short to settle: frame ${held} held on screen</small>` : '') : 'nothing accepted'}</td>
<td>${esc(hname(d.hero || d.live.hero.id))}<br><small>live: ${d.live.hero.source}</small></td>
<td>${d.rerolls ?? 'n/a'}</td><td>${s.unsure}</td>
<td>${take ? esc(iname(take)) : 'none'}</td>
<td>${s.adviceMs === null ? 'none' : Math.round(s.adviceMs) + ' ms'}</td>
<td>${d.diff.length ? 'differs from live<br><small>' + esc(d.diff.join('; ')) + '</small>' : 'same as live'}</td>
<td>${esc(verdict || 'MISSING')}</td></tr>`;
  })
  .join('\n');
const ownedHtml = owned
  .map(
    (o) =>
      `<li>${esc(o.session)}: ${o.ids ? o.ids.map((i) => esc(iname(i))).join(', ') || 'empty' : 'no inventory read'}</li>`,
  )
  .join('');
writeFileSync(
  path.join(out, 'read-report.html'),
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Read report 0.4.0-rc.1</title>
<style>body{font:14px system-ui;background:#1b1d20;color:#f0e9dc;margin:16px}table{border-collapse:collapse}td,th{border:1px solid #444;padding:4px 8px;vertical-align:top;text-align:left}
.crops img{display:inline-block;margin-right:3px}tr.wrong td:last-child{background:#6b2020}tr.unsure td:last-child{background:#6b5a20}tr.right td:last-child{background:#1d4d46}tr.none td:last-child{background:#a00}small{color:#aaa}</style>
<h1>Read report for 0.4.0-rc.1</h1>
<p><b>${rows.length} drafts: ${count('right')} Right, ${count('wrong')} Wrong, ${count('unsure')} Unsure, ${count('none')} without a verdict. ? plates in the replay: ${qs}.</b></p>
<p>Replayed on the current code from the recorded crops. Crops are the card pictures from the frame the set was accepted on (the last frame with all three when none was).</p>
<table><tr><th>Draft</th><th>Cards</th><th>Read as</th><th>Hero</th><th>Re-rolls</th><th>?</th><th>Advised (live)</th><th>Advice</th><th>Live</th><th>Verdict</th></tr>
${body}</table>
<h2>Owned list after the last draft (replay)</h2><ul>${ownedHtml}</ul></html>`,
);
writeFileSync(
  path.join(out, 'replay.json'),
  JSON.stringify(
    rows.map((r) => ({
      key: r.key,
      items: r.d.stats.items.map(iname),
      unsure: r.d.stats.unsure,
      live: r.d.live.items.map(iname),
    })),
    null,
    1,
  ),
);
console.log(
  `${rows.length} drafts: Right ${count('right')} Wrong ${count('wrong')} Unsure ${count('unsure')} none ${count('none')}; ? ${qs}`,
);
process.exit(0);
