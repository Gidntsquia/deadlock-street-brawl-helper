import type { Ability, AbilityOrderStat, AbilityStep, Hero } from '../types';
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

/** Street Brawl gives roughly one ability point per draft choice: round 1 choice 1 is step 1, and so on. */
export const abilityStepIndex = (round: number, choice: number) => (round - 1) * 3 + choice - 1;

/** How a point looks in the ability panel: spent this round (`now`, highlighted), spent in an earlier round
 *  (`done`, dark with a check), or not yet spent (`later`). */
export type PointState = 'now' | 'done' | 'later';

export interface PanelSlot {
  name: string;
  icon: string; // app-relative image path
  key: string;
  unlock: PointState;
  /** Point pills top to bottom: cost 5 (tier 3), cost 2 (tier 2), cost 1 (tier 1). */
  tiers: [PointState, PointState, PointState];
}

/** The ability upgrade panel for one round: the hero's four abilities in bar order with each point's state. */
export interface AbilityPanelData {
  round: number;
  slots: PanelSlot[];
}

/** Key caps under the four abilities, left to right (the third is a guess: the reference shot hides it). */
export const ABILITY_KEYS = ['Q', 'E', 'R', 'F'] as const;

/** The standard order's points as the panel shows them for `round`: the three steps the order spends this round
 *  are `now`, earlier steps `done`, later ones `later`. Unlocks are separate from the three tier points. */
export function abilityPanelFor(
  order: BrawlAbilityOrder,
  hero: Hero,
  abilities: Ability[],
  round: number,
): AbilityPanelData {
  const first = (round - 1) * 3;
  const stateOf = (index: number | undefined): PointState =>
    index === undefined || index >= first + 3 ? 'later' : index >= first ? 'now' : 'done';
  const slots = hero.abilities.slice(0, 4).map((cls, i): PanelSlot => {
    const steps = order.steps.filter((s) => s.ability.class_name === cls);
    const at = (kind: AbilityStep['kind']) => stateOf(steps.find((s) => s.kind === kind)?.index);
    const ability = abilities.find((a) => a.class_name === cls);
    return {
      name: ability?.name ?? cls,
      icon: ability?.image_webp ?? '',
      key: ABILITY_KEYS[i]!,
      unlock: at('unlock'),
      tiers: [at('tier3'), at('tier2'), at('tier1')],
    };
  });
  return { round, slots };
}
