// Computes the engine's independent verdict for each labelled frame in scripts/win/frames/labels.json,
// using the same adviseDraft() the app itself calls -- run in-process (not by shelling out to
// scripts/brawl-cli.ts) so the numbers can't drift from a stale CLI flag/parsing path, and written to
// logs/win-e2e-verdicts.json for the Windows-side harness (scripts/win/e2e-main.cjs) to read, since it
// runs against a synced copy that has no access back to this WSL process. Run from repo root:
//   npx tsx scripts/win/compute-verdicts.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { adviseDraft, type BrawlInput } from '../../src/brawl';
import type { Ability, Hero, Item } from '../../src/types';
import type { BrawlAnalytics, BrawlConfig } from '../../src/brawl/types';

const read = <T>(p: string): T => JSON.parse(readFileSync(`public/data/${p}`, 'utf8'));
const labels = JSON.parse(readFileSync('scripts/win/frames/labels.json', 'utf8'));

const items = read<Item[]>('items.json'),
  heroes = read<Hero[]>('heroes.json'),
  abilities = read<Ability[]>('abilities.json'),
  config = read<BrawlConfig>('brawl-config.json');

const byName = (name: string) => {
  const it = items.find((i) => i.name.toLowerCase() === name.trim().toLowerCase());
  if (!it) throw new Error(`unknown item "${name}"`);
  return it.id;
};

const out: Record<
  string,
  { verdict: string; pickId: number | null; rerollExpected: number | null; rerollCurrent: number | null }
> = {};

for (const [frame, label] of Object.entries<{
  hero: string;
  round: number;
  choice: number;
  cards: { left: string; top: string; right: string };
}>(labels)) {
  if (frame.startsWith('_')) continue;
  const hero = heroes.find((h) => h.name.toLowerCase() === label.hero.toLowerCase());
  if (!hero) throw new Error(`unknown hero "${label.hero}"`);
  const input: BrawlInput = {
    hero,
    abilities,
    items,
    analytics: read<BrawlAnalytics>(`analytics/brawl/${hero.id}.json`),
    config,
  };
  const set = [label.cards.left, label.cards.top, label.cards.right].map((n) => ({
    itemId: byName(n),
    enhanced: false,
  }));
  const advice = adviseDraft(input, { round: label.round, owned: [], enemies: [], sets: [set] });
  const reroll = advice.reroll && advice.reroll.set === 0 ? advice.reroll : null;
  const pick = advice.picks[0] ?? null;
  out[frame] = {
    verdict: reroll ? 'RE-ROLL' : pick ? items.find((i) => i.id === pick.item.id)!.name : '?',
    pickId: pick?.item.id ?? null,
    rerollExpected: reroll?.expectedBest ?? null,
    rerollCurrent: reroll?.currentBest ?? null,
  };
}

mkdirSync('logs', { recursive: true });
writeFileSync('logs/win-e2e-verdicts.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
