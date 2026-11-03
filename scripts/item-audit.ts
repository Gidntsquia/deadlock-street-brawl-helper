// Item audit (plans/ITEM-AUDIT.md section 2): per hero and tier, the engine's top 3 (plain score, round 3, no enemies,
// nothing owned) against the API's pick rate and win rate. Prints the count of type (a) suspects: a top 3 item ranked
// above another item of the same tier that the API shows both more picked and better winning (both with 200 or more
// matches), and the type (b) counts (in the top 3 only through `kit` / `active`).
// Usage: npx tsx scripts/item-audit.ts [--data public/data] [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import type { Ability, Hero, Item } from '../src/types';
import type { BrawlAnalytics, BrawlConfig, BrawlInput } from '../src/brawl/types';
import { baseScores, pairLifts, scoreOffer } from '../src/brawl/engine';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1]! : d;
};
const dir = arg('--data', 'public/data');
const read = <T>(p: string): T => JSON.parse(readFileSync(`${dir}/${p}`, 'utf8'));
const heroes = read<Hero[]>('heroes.json');
const items = read<Item[]>('items.json');
const abilities = read<Ability[]>('abilities.json');
const config = read<BrawlConfig>('brawl-config.json');
const MIN = 200;

let suspectsA = 0;
let kitB = 0;
let activeB = 0;
let heroCount = 0;
const rows: { hero: string; tier: number; top3: string[]; suspects: string[] }[] = [];
for (const hero of heroes) {
  let analytics: BrawlAnalytics;
  try {
    analytics = read<BrawlAnalytics>(`analytics/brawl/${hero.id}.json`);
  } catch {
    continue;
  }
  heroCount++;
  const input: BrawlInput = { hero, abilities, items, analytics, config };
  const bases = baseScores(input);
  const pair = pairLifts(input);
  const state = { round: 3, owned: [], enemies: [], sets: [] };
  const stat = new Map(analytics.item_stats.map((s) => [s.item_id, s]));
  const heroMatches = Math.max(1, ...analytics.item_stats.map((s) => s.matches));
  for (const tier of [1, 2, 3, 4]) {
    const scored = [...bases.values()]
      .filter((b) => b.item.item_tier === tier && !b.item.disabled && !/^upgrade_|Disabled/.test(b.item.name))
      .map((b) => ({ b, r: scoreOffer(input, bases, pair, state, { itemId: b.item.id, enhanced: false }) }))
      .sort((x, y) => y.r.score - x.r.score || x.b.item.id - y.b.item.id);
    const top = scored.slice(0, 3);
    const suspects: string[] = [];
    for (const t of top) {
      const ts = stat.get(t.b.item.id);
      if (!ts || ts.matches < MIN) continue;
      const worse = scored.slice(scored.indexOf(t) + 1).filter((o) => {
        const os = stat.get(o.b.item.id);
        return os && os.matches >= MIN && os.matches > ts.matches && os.wins / os.matches > ts.wins / ts.matches;
      });
      if (worse.length) {
        suspectsA++;
        suspects.push(`${t.b.item.name} above ${worse.map((w) => w.b.item.name).join(', ')}`);
      }
    }
    const topWithout = (term: 'kit' | 'active') =>
      new Set(
        [...scored]
          .sort((x, y) => y.r.score - y.r.parts[term] - (x.r.score - x.r.parts[term]) || x.b.item.id - y.b.item.id)
          .slice(0, 3)
          .map((o) => o.b.item.id),
      );
    const noKit = topWithout('kit');
    const noActive = topWithout('active');
    for (const t of top) {
      if (t.r.parts.kit > 0 && !noKit.has(t.b.item.id)) kitB++;
      if (t.r.parts.active > 0 && !noActive.has(t.b.item.id)) activeB++;
    }
    rows.push({ hero: hero.name, tier, top3: top.map((t) => t.b.item.name), suspects });
  }
  void heroMatches;
}
console.log(
  `data ${dir}: ${heroCount} heroes, type (a) suspects ${suspectsA}, type (b) kit ${kitB}, active ${activeB}`,
);
const out = arg('--json', '');
if (out)
  writeFileSync(out, JSON.stringify({ heroes: heroCount, a: suspectsA, bKit: kitB, bActive: activeB, rows }, null, 1));
