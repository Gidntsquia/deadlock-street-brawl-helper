// Does the Order term change rankings? Replays the 9 fixture card sets as one hero under two full ability orders
// (and none) and counts drafts whose best card differs. Usage: npx tsx scripts/order-check.ts [heroId]
import { readFileSync } from 'node:fs';
import { adviseDraft, type BrawlInput } from '../src/brawl';
import type { Ability, Hero, Item } from '../src/types';
import type { BrawlAnalytics, BrawlConfig } from '../src/brawl/types';

const read = <T>(p: string): T => JSON.parse(readFileSync(`public/data/${p}`, 'utf8'));
const heroId = Number(process.argv[2] ?? 1);
const hero = read<Hero[]>('heroes.json').find((h) => h.id === heroId)!;
const input: BrawlInput = {
  hero,
  abilities: read<Ability[]>('abilities.json'),
  items: read<Item[]>('items.json'),
  analytics: read<BrawlAnalytics>(`analytics/brawl/${heroId}.json`),
  config: read<BrawlConfig>('brawl-config.json'),
};
const labels = JSON.parse(readFileSync('scripts/fixtures/brawl-cards/labels.json', 'utf8')) as Record<
  string,
  { item_id: number }
>;
const orders = (input.analytics.item_stats_by_order ?? []).map((o) => o.order);
const draftIds = [...new Set(Object.keys(labels).map((k) => k.split('-')[0]))];
let changed = 0;
for (const d of draftIds) {
  const set = ['left', 'top', 'right'].map((p) => ({ itemId: labels[`${d}-${p}`]!.item_id }));
  const pick = (order?: number[]) =>
    adviseDraft(input, { round: 2, owned: [], enemies: [], order, sets: [set] }).picks[0]?.item.name;
  const picks = [undefined, ...orders].map(pick);
  const diff = new Set(picks).size > 1;
  if (diff) changed++;
  console.log(d, diff ? 'CHANGES' : 'same', picks.join(' | '));
}
console.log(`${changed} of ${draftIds.length} drafts change their best card under some stored order`);
