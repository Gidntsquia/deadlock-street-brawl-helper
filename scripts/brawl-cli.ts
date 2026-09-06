// Street Brawl draft advisor CLI.
//   npm run brawl -- --hero 1 --round 2 --owned "Extra Charge,Mystic Burst" --enemies "Lash,Seven" \
//       --set "Boundless Spirit,Titanic Magazine,Shrink Ray" --set "Improved Spirit+,Bullet Resilience,Restorative Locket"
//   Items by name (case-insensitive) or id; a trailing "+" marks an enhanced card. Up to three --set arguments.
//   npm run brawl -- --hero 1 --pool           top items per tier for the hero (sanity check of the base scores)
//   npm run brawl -- --hero 1 --validate       held-out pick-percentile check against the user's brawl matches
//   npm run brawl -- --validate                same for every hero that appears in the held-out file
import { readFileSync, existsSync } from 'node:fs';
import { adviseDraft, baseScores, roundTiers, type BrawlInput, type Offer } from '../src/brawl';
import { validateBrawlPicks } from '../src/validation/brawl';

const read = (p: string) => JSON.parse(readFileSync(`public/data/${p}`, 'utf8'));
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const opts = (k: string) => args.flatMap((a, i) => (a === `--${k}` ? [args[i + 1]] : []));
const asJson = args.includes('--json');

const items = read('items.json'), heroes = read('heroes.json'), abilities = read('abilities.json'), config = read('brawl-config.json'), manifest = read('manifest.json');
const heroByName = (s: string) => heroes.find((h: any) => h.id === Number(s) || h.name.toLowerCase() === s.trim().toLowerCase());
const itemByName = (s: string) => items.find((i: any) => i.id === Number(s) || i.name.toLowerCase() === s.trim().toLowerCase());
const loadInput = (heroId: number): BrawlInput => {
  const hero = heroes.find((h: any) => h.id === heroId);
  if (!hero) throw new Error(`hero ${heroId} not in snapshot`);
  return { hero, abilities, items, analytics: read(`analytics/brawl/${heroId}.json`), config };
};
const parseOffer = (s: string): Offer => { const enhanced = /\+$/.test(s.trim()); const it = itemByName(s.trim().replace(/\+$/, '')); if (!it) throw new Error(`unknown item "${s}"`); return { itemId: it.id, enhanced }; };
const list = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

if (args.includes('--validate')) {
  const file = manifest.brawl?.user_file ?? 'validation/brawl-267836488.json'; // the fetch writes manifest.brawl only when it completes
  if (!existsSync(`public/data/${file}`)) throw new Error('no brawl validation file; run `npm run fetch-data -- --brawl`');
  const data = read(file);
  const heroIds: number[] = opt('hero') ? [heroByName(opt('hero')!).id] : [...new Set<number>(data.matches.map((m: any) => m.hero_id))];
  const rows = [];
  for (const id of heroIds) {
    if (!existsSync(`public/data/analytics/brawl/${id}.json`)) continue;
    const input = loadInput(id);
    const v = validateBrawlPicks(input, data);
    rows.push({ hero: input.hero.name, matches: v.matches, picks: v.picks.length, meanPercentile: v.meanPercentile, popOnly: v.meanPopPercentile, topThird: v.topThird });
    if (!asJson && opt('hero')) for (const p of v.picks) console.log(`  ${String(p.match_id).padEnd(10)} r${p.round} ${p.item.name.padEnd(24)} T${p.item.item_tier} pct ${(p.percentile * 100).toFixed(0).padStart(3)}  pop-only ${(p.popPercentile * 100).toFixed(0).padStart(3)}  pool ${p.poolSize}`);
  }
  if (asJson) console.log(JSON.stringify(rows));
  else {
    console.log('# Street Brawl held-out pick percentile (0.5 = random, ~0.75 = always the engine\'s best of 3)');
    for (const r of rows) console.log(`  ${r.hero.padEnd(12)} ${String(r.matches).padStart(3)} matches ${String(r.picks).padStart(4)} picks  engine ${(r.meanPercentile * 100).toFixed(0)}%  popularity-only ${(r.popOnly * 100).toFixed(0)}%  top-third ${(r.topThird * 100).toFixed(0)}%`);
    const all = rows.reduce((a, r) => ({ n: a.n + r.picks, s: a.s + r.meanPercentile * r.picks, p: a.p + r.popOnly * r.picks }), { n: 0, s: 0, p: 0 });
    if (all.n) console.log(`  overall      ${all.n} picks  engine ${(all.s / all.n * 100).toFixed(0)}%  popularity-only ${(all.p / all.n * 100).toFixed(0)}%`);
  }
  process.exit(0);
}

const hero = heroByName(opt('hero') ?? '1');
if (!hero) throw new Error(`unknown hero ${opt('hero')}`);
const input = loadInput(hero.id);

if (args.includes('--pool')) {
  const enemies = list(opt('enemies')).map((e) => heroByName(e)?.id).filter((x): x is number => !!x);
  const bases = baseScores(input, enemies);
  for (const t of [1, 2, 3, 4, 5]) {
    const xs = [...bases.values()].filter((b) => b.item.item_tier === t && b.stat).sort((a, b) => b.base - a.base);
    console.log(`\n## ${hero.name} tier ${t} (${xs.length} items with brawl data)`);
    for (const b of xs.slice(0, 12)) console.log(`  ${b.item.name.padEnd(24)} ${b.item.item_slot_type.padEnd(8)} sc${b.base.toFixed(2)} use${(b.pop * 100).toFixed(0).padStart(3)} wr${(b.stat!.wins / b.stat!.matches * 100).toFixed(1)} lift${b.winLift.toFixed(2)} kit${b.kit.toFixed(2)}${enemies.length ? ` vs${b.counter.toFixed(2)}` : ''} n=${b.stat!.matches}`);
  }
  process.exit(0);
}

const round = Number(opt('round') ?? 1);
const owned = list(opt('owned')).map((s) => { const it = itemByName(s); if (!it) throw new Error(`unknown item "${s}"`); return it.id as number; });
const enemies = list(opt('enemies')).map((e) => { const h = heroByName(e); if (!h) throw new Error(`unknown hero "${e}"`); return h.id as number; });
const sets = opts('set').map((s) => list(s).map(parseOffer));
if (!sets.length) throw new Error('give at least one --set "A,B,C" (or --pool / --validate)');
const advice = adviseDraft(input, { round, owned, enemies, sets });
if (asJson) { console.log(JSON.stringify({ picks: advice.picks.map((p) => p.item.id), reroll: advice.reroll?.set ?? null, sets: advice.sets.map((s) => s.map((r) => [r.item.id, +r.score.toFixed(3)])) })); process.exit(0); }
const tiers = roundTiers(input, round);
console.log(`# ${hero.name}, round ${round} (${config.gold_per_round[round - 1]} souls)${enemies.length ? `, vs ${enemies.map((e) => heroes.find((h: any) => h.id === e).name).join(', ')}` : ''}${owned.length ? `, holding ${owned.map((id) => items.find((i: any) => i.id === id).name).join(', ')}` : ''}`);
advice.sets.forEach((set, i) => {
  console.log(`\n## set ${i + 1}${tiers[i] ? ` (tier ${tiers[i].normal}, rare -> ${tiers[i].rare})` : ''}`);
  for (const r of set) {
    const pick = advice.picks.some((p) => p === r);
    const parts = Object.entries(r.parts).filter(([, v]) => Math.abs(v) >= 0.005).map(([k, v]) => `${k}${v >= 0 ? '+' : ''}${v.toFixed(2)}`).join(' ');
    console.log(`  ${pick ? '>>' : '  '} ${(r.item.name + (r.enhanced ? '+' : '')).padEnd(26)} T${r.item.item_tier} ${r.item.item_slot_type.padEnd(8)} sc${r.score.toFixed(2)}  ${parts}`);
    if (r.why.length) console.log(`       ${r.why.join('; ')}`);
  }
});
console.log(`\npick: ${advice.picks.map((p) => p.item.name + (p.enhanced ? '+' : '')).join(' / ')}`);
if (advice.reroll) console.log(`reroll set ${advice.reroll.set + 1}: its best card scores ${advice.reroll.currentBest.toFixed(2)}, a fresh set is expected to offer ${advice.reroll.expectedBest.toFixed(2)} (rare and enhanced slots keep their bonus through the re-roll; an unseen card is tier ${advice.reroll.pool.rareTier} with ${(advice.reroll.pool.pRare * 100).toFixed(0)}% chance)${advice.reroll.holdValue ? `; holding the re-roll for a later set is worth ${advice.reroll.holdValue.toFixed(2)}` : ''}`);
else console.log('reroll: keep all three sets');
