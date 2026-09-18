import type { AbilityOrderStat, AbilityStep } from '../types';
import type { BrawlInput } from './types';

const TOP_N = 10; // candidates considered for "prefer the longest sequence" among near-equally-good scores

export interface BrawlAbilityOrder {
  steps: AbilityStep[];
  support: { matches: number; winRate: number } | null;
  alternatives: { steps: AbilityStep[]; matches: number; winRate: number }[];
}

const stepsFor = (seq: number[], byId: Map<number, AbilityStep['ability']>): AbilityStep[] => {
  const seen = new Map<number, number>();
  const steps: AbilityStep[] = [];
  seq.forEach((id, index) => {
    const a = byId.get(id);
    if (!a) return;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 3) return;
    const kind = n === 0 ? 'unlock' : n === 1 ? 'tier1' : n === 2 ? 'tier2' : 'tier3';
    steps.push({ ability: a, kind, index });
  });
  return steps;
};

/** Suggests a full-game ability level-up order from Street Brawl ability-order-stats, ranked by shrunk win
 *  rate x log(matches) like the item build generator's pickAbilityOrder, but without its `>= 8` length
 *  filter (Street Brawl sequences run 7-12 long) and preferring the longest sequence among the top-scoring
 *  ones, so the suggestion covers the whole game instead of stopping early. */
export function brawlAbilityOrder(input: BrawlInput): BrawlAbilityOrder {
  const stats: AbilityOrderStat[] = input.analytics.ability_order_stats ?? [];
  const byId = new Map(input.abilities.map((a) => [a.id, a]));
  const sig = input.abilities.filter((a) => input.hero.abilities.includes(a.class_name));
  const sigIds = new Set(sig.map((a) => a.id));
  const totalW = stats.reduce((a, s) => a + s.wins, 0);
  const totalM = stats.reduce((a, s) => a + s.matches, 0);
  const mean = totalM ? totalW / totalM : 0.5;
  const K = Math.max(50, 0.05 * Math.max(1, ...stats.map((s) => s.matches)));
  const ranked = stats
    .filter((s) => s.abilities.length > 0 && s.abilities.every((id) => sigIds.has(id)))
    .map((s) => ({ s, score: ((s.wins + K * mean) / (s.matches + K)) * Math.log(1 + s.matches) }))
    .sort((a, b) => b.score - a.score || a.s.abilities.join().localeCompare(b.s.abilities.join()));

  if (!ranked.length) {
    const ids = input.hero.abilities
      .map((c) => sig.find((a) => a.class_name === c)?.id)
      .filter((x): x is number => !!x);
    const seq = [...ids];
    for (let t = 0; t < 3; t++) for (const id of ids) seq.push(id);
    return { steps: stepsFor(seq, byId), support: null, alternatives: [] };
  }

  const top = ranked.slice(0, TOP_N);
  const best = [...top].sort((a, b) => b.s.abilities.length - a.s.abilities.length || b.score - a.score)[0];
  const rest = ranked.filter((r) => r !== best).slice(0, 3);

  return {
    steps: stepsFor(best.s.abilities, byId),
    support: { matches: best.s.matches, winRate: best.s.wins / best.s.matches },
    alternatives: rest.map((r) => ({
      steps: stepsFor(r.s.abilities, byId),
      matches: r.s.matches,
      winRate: r.s.wins / r.s.matches,
    })),
  };
}
