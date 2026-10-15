// Explains one draft of a recorded stretch: replays its crops through the real worker and prints, per slot, every
// name read (OCR text, item, match score), then the hero the bar gave, the accepted set's engine scores and the
// re-roll gain. Used to find out why a set was advised the way it was (wrong read, covered line, wrong hero, scoring).
//
//   BRAWL_OCR=live npx tsx scripts/explain-draft.ts scripts/fixtures/video-truth/s7 --round 2 --choice 3
//
// Without BRAWL_OCR the recorded answers are used (a crop never recorded reads as a down reader).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { adviseDraft, enemiesFrom, type BrawlInput, type Offer } from '../src/brawl';
import type { BrawlAnalytics, BrawlConfig } from '../src/brawl/types';
import type { WorkerOut } from '../src/brawl/worker';
import type { Ability, Hero, Item } from '../src/types';
import { replayDraft } from './replay';

type Result = Extract<WorkerOut, { type: 'result' }>;
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? Number(args[i + 1]) : 0;
};
if (!dir) {
  console.error('usage: npx tsx scripts/explain-draft.ts <stretch or draft folder> --round R --choice C');
  process.exit(2);
}
const round = opt('round'),
  choice = opt('choice');
const read = <T>(p: string): T => JSON.parse(readFileSync(path.join('public/data', p), 'utf8'));
const items = read<Item[]>('items.json'),
  heroes = read<Hero[]>('heroes.json'),
  abilities = read<Ability[]>('abilities.json'),
  config = read<BrawlConfig>('brawl-config.json');
const itemName = (id: number) => (id ? (items.find((i) => i.id === id)?.name ?? `#${id}`) : '?');
const heroName = (id: number) => (id ? (heroes.find((h) => h.id === id)?.name ?? `#${id}`) : 'unread');
let video0 = 0,
  fps = 4;
try {
  const t = JSON.parse(readFileSync(path.join(dir, 'truth.json'), 'utf8'));
  video0 = t.video[0];
  fps = t.fps;
} catch {
  // a session draft folder: frame times are app ms, printed as such
}
const at = (f: number) => (video0 ? `${(video0 + f / fps).toFixed(2)} s` : `frame ${f}`);

const names: { f: number; slot: number; text: string; itemId: number; score: number; readerMs: number }[] = [];
let accepted: Result | null = null;
let lastOfSet: Result | null = null;
let inSet = false;
let inventory: number[] | null = null;
await replayDraft(dir, {
  onMessage: (f, m) => {
    if (m.type === 'name' && inSet)
      names.push({ f, slot: m.slot, text: m.text, itemId: m.itemId, score: m.score, readerMs: m.readerMs });
  },
  onResult: (_f, r) => {
    const mine = r.shop && r.choice === choice && (!round || !r.round || r.round === round);
    if (mine) inSet = true;
    else if (inSet && r.shop && r.choice !== choice) inSet = false;
    if (mine && r.inventory) inventory = r.inventory;
    if (mine && r.accepted && !accepted) accepted = r;
    if (mine && r.live) lastOfSet = r;
  },
});

console.log(`# ${path.basename(dir)} round ${round || '?'} choice ${choice}`);
console.log('\n## name reads per slot (video time, OCR text, item, match score, reader ms)');
for (const slot of [0, 1, 2])
  for (const n of names.filter((x) => x.slot === slot))
    console.log(
      `  slot ${slot + 1}  ${at(n.f)}  "${n.text}"  -> ${itemName(n.itemId)}  score ${n.score.toFixed(2)}  ${Math.round(n.readerMs)} ms`,
    );
const res = (accepted ?? lastOfSet) as Result | null;
if (!res) {
  console.log('\nNo set was accepted for that round and choice.');
  process.exit(1);
}
const self = res.meta?.self ?? 0;
console.log(`\n## hero bar\n  own hero: ${heroName(self)} (id ${self})`);
if (res.meta)
  console.log(
    `  left: ${res.meta.bar.left.map((m) => heroName(m.heroId)).join(', ')} | right: ${res.meta.bar.right.map((m) => heroName(m.heroId)).join(', ')}`,
  );
const cards: Offer[] = res.reads
  .filter((x) => x.present && !x.unsure && x.itemId)
  .map((x) => ({ itemId: x.itemId, enhanced: x.enhanced }));
console.log(`  accepted set: ${res.reads.map((x) => (x.present && !x.unsure ? itemName(x.itemId) : '?')).join(', ')}`);
if (!self) {
  console.log('\nThe own hero was not read: the app would use the last sure hero of the match or the window hero.');
  process.exit(0);
}
const hero = heroes.find((h) => h.id === self)!;
const input: BrawlInput = {
  hero,
  abilities,
  items,
  analytics: read<BrawlAnalytics>(`analytics/brawl/${self}.json`),
  config,
};
const enemies = res.meta ? enemiesFrom(res.meta.bar, self) : [];
const owned = res.inventory ?? inventory ?? [];
const sets: Offer[][] = [[], [], []];
sets[choice - 1] = cards;
const advice = adviseDraft(input, { round: res.round || round, owned, enemies, sets });
console.log(
  `\n## engine (${hero.name}, round ${res.round || round}, vs ${enemies.map(heroName).join(', ') || 'none'}, owned ${owned.map(itemName).join(', ') || 'none'})`,
);
for (const r of advice.sets[choice - 1] ?? []) console.log(`  ${r.item.name.padEnd(24)} score ${r.score.toFixed(2)}`);
console.log(`  pick: ${advice.picks.map((p) => p.item.name).join(', ')}`);
const rr = advice.reroll;
console.log(
  rr
    ? `  re-roll: yes, gain ${rr.gain.toFixed(2)} (best ${rr.currentBest.toFixed(2)}, a fresh set ${rr.expectedBest.toFixed(2)})`
    : '  re-roll: no',
);
process.exit(0);
