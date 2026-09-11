import type { Ability, AbilityOrderStat, AbilityStep, Hero } from '../types';

/** Picks the best-supported ability level-up sequence from aggregate ability-order stats. */
export function pickAbilityOrder(hero: Hero, abilities: Ability[], stats: AbilityOrderStat[]): { steps: AbilityStep[]; support: { matches: number; winRate: number } | null } {
  const byId = new Map(abilities.map((a) => [a.id, a]));
  const sig = abilities.filter((a) => hero.abilities.includes(a.class_name));
  const sigIds = new Set(sig.map((a) => a.id));
  const totalW = stats.reduce((a, s) => a + s.wins, 0), totalM = stats.reduce((a, s) => a + s.matches, 0);
  const mean = totalM ? totalW / totalM : 0.5;
  const K = Math.max(50, 0.05 * Math.max(1, ...stats.map((s) => s.matches)));
  // score = shrunk win rate * log(matches): favours sequences that are both common and winning
  const ranked = stats
    .filter((s) => s.abilities.length >= 8 && s.abilities.every((id) => sigIds.has(id)))
    .map((s) => ({ s, score: ((s.wins + K * mean) / (s.matches + K)) * Math.log(1 + s.matches) }))
    .sort((a, b) => b.score - a.score || a.s.abilities.join().localeCompare(b.s.abilities.join()));
  let seq: number[];
  let support: { matches: number; winRate: number } | null = null;
  if (ranked.length) {
    seq = ranked[0].s.abilities;
    support = { matches: ranked[0].s.matches, winRate: ranked[0].s.wins / ranked[0].s.matches };
  } else {
    // fallback: unlock 1,2,3, ult, then round-robin upgrades
    const ids = hero.abilities.map((c) => sig.find((a) => a.class_name === c)?.id).filter((x): x is number => !!x);
    seq = [...ids];
    for (let t = 0; t < 3; t++) for (const id of ids) seq.push(id);
  }
  const seen = new Map<number, number>();
  const steps: AbilityStep[] = [];
  seq.forEach((id, index) => {
    const a = byId.get(id); if (!a) return;
    const n = seen.get(id) ?? 0; seen.set(id, n + 1);
    const kind = n === 0 ? 'unlock' : n === 1 ? 'tier1' : n === 2 ? 'tier2' : 'tier3';
    if (n > 3) return;
    steps.push({ ability: a, kind, index });
  });
  return { steps, support };
}
