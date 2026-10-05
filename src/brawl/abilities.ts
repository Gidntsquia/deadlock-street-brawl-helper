import type { Ability, AbilityOrderStat, AbilityStep, Hero } from '../types';
import type { BrawlInput } from './types';

export interface BrawlAbilityOrder {
  steps: AbilityStep[];
  support: { matches: number; winRate: number } | null;
  /** Number of steps supported by the observed prefix; remaining steps are deterministic fallback. */
  supportedSteps?: number;
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
    if (n > 2) return;
    // Every ability starts unlocked in Street Brawl, so an ability's first appearance is its tier-1 point.
    const kind = n === 0 ? 'tier1' : n === 1 ? 'tier2' : 'tier3';
    steps.push({ ability: a, kind, index });
  });
  return steps;
};

/** Fewest matches that must back the chosen order; below this the panel says there is no reliable order. */
export const MIN_ORDER_MATCHES = 100;

const shrunk = (wins: number, matches: number, mean: number, k: number) =>
  ((wins + k * mean) / (matches + k)) * Math.log(1 + matches);

/** Builds the standard order one step at a time from every recorded sequence. Each step keeps only the sequences
 *  that start with the steps already chosen, so a short sequence counts toward the early steps it covers and a long
 *  one toward all of its steps. The next ability is the one whose continuations have the best shrunk win rate x
 *  log(matches). It stops when fewer than MIN_ORDER_MATCHES back the next step; `support` is the matches and win
 *  rate of every sequence that starts with the whole chosen order. */
export function brawlAbilityOrder(input: BrawlInput): BrawlAbilityOrder {
  const stats: AbilityOrderStat[] = input.analytics.ability_order_stats ?? [];
  const sig = heroBarAbilities(input.hero, input.abilities);
  const byId = new Map(sig.map((a) => [a.id, a]));
  const sigIds = new Set(sig.map((a) => a.id));
  const usable = stats.filter((s) => s.abilities.length > 0 && s.abilities.every((id) => sigIds.has(id)));
  const totalW = usable.reduce((a, s) => a + s.wins, 0);
  const totalM = usable.reduce((a, s) => a + s.matches, 0);
  const mean = totalM ? totalW / totalM : 0.5;
  const K = Math.max(50, 0.05 * Math.max(1, ...usable.map((s) => s.matches)));

  const chosen: number[] = [];
  let pool = usable;
  let support: { matches: number; winRate: number } | null = null;
  const count = (id: number) => ({ id, uses: chosen.filter((c) => c === id).length });
  for (let step = 0; step < 12; step++) {
    const groups = new Map<number, { wins: number; matches: number }>();
    for (const s of pool) {
      const id = s.abilities[step];
      if (id === undefined || count(id).uses >= 3) continue;
      const g = groups.get(id) ?? { wins: 0, matches: 0 };
      g.wins += s.wins;
      g.matches += s.matches;
      groups.set(id, g);
    }
    const best = [...groups.entries()]
      .filter(([, g]) => g.matches >= MIN_ORDER_MATCHES)
      .map(([id, g]) => ({ id, g, score: shrunk(g.wins, g.matches, mean, K) }))
      .sort((a, b) => b.score - a.score || a.id - b.id)[0];
    if (!best) break;
    chosen.push(best.id);
    pool = pool.filter((s) => s.abilities[step] === best.id);
    support = { matches: best.g.matches, winRate: best.g.wins / best.g.matches };
  }

  const supportedSteps = chosen.length;
  // Finish the legal prefix in bar order, tier by tier. Evidence applies only to the prefix above.
  for (const tier of [1, 2, 3])
    for (const ability of sig) if (chosen.filter((id) => id === ability.id).length < tier) chosen.push(ability.id);
  return { steps: stepsFor(chosen, byId), support, supportedSteps, alternatives: [] };
}

/** Shared deterministic bar order for both the reference list and the round panel. */
export function heroBarAbilities(hero: Hero, abilities: Ability[]): Ability[] {
  return hero.abilities
    .slice(0, 4)
    .map((className) => abilities.find((ability) => ability.class_name === className))
    .filter((ability): ability is Ability => !!ability);
}

export function abilityOrderEvidence(order: BrawlAbilityOrder): string {
  const evidence = evidenceLine(order.support);
  const supported = order.supportedSteps ?? order.steps.length;
  return order.support && supported < order.steps.length
    ? `${evidence}; first ${supported} upgrades supported, remaining upgrades use fallback order`
    : evidence;
}

/** Index of the order step nearest this draft choice, for highlighting the ability-order list. */
export const abilityStepIndex = (round: number, choice: number) => (round - 1) * 3 + choice - 1;

/** Ability points Street Brawl hands out per round (rounds 1-5; deadlock.wiki "Street Brawl", `m_vecAPPerRound`). */
const AP_PER_ROUND = [6, 6, 5, 5, 10] as const;
/** Cost of the tier 1 / 2 / 3 point pill. Four abilities fully upgraded cost 32, the five rounds' total. */
const PILL_COST = [1, 2, 5] as const;

/** How a point looks in the ability panel: spent this round (`now`, highlighted), spent in an earlier round
 *  (`done`, dark with a check), or not yet spent (`later`). */
export type PointState = 'now' | 'done' | 'later';

interface PanelSlot {
  name: string;
  icon: string; // app-relative image path
  key: string;
  /** Point pills top to bottom: cost 5 (tier 3), cost 2 (tier 2), cost 1 (tier 1). */
  tiers: [PointState, PointState, PointState];
}

/** The ability upgrade panel for one round: the hero's four abilities in bar order with each point's state. */
export interface AbilityPanelData {
  availablePoints?: number | null;
  round: number;
  /** Ability points this round hands out (6/6/5/5/10). */
  points: number;
  slots: PanelSlot[];
  /** `<n> matches, <w>% win rate`, or `No reliable order` (then nothing is highlighted). */
  evidence: string;
}

/** The one evidence line under the panel title. */
export const evidenceLine = (support: BrawlAbilityOrder['support']): string =>
  support && support.matches >= MIN_ORDER_MATCHES
    ? `${support.matches} matches, ${Math.round(support.winRate * 100)}% win rate`
    : 'No reliable order';

/** Key caps under the four abilities, left to right (the third is a guess: the reference shot hides it). */
const ABILITY_KEYS = ['Q', 'E', 'R', 'F'] as const;

/** Which round (1-5) buys each pill, keyed `<class_name>:<tier 1-3>`. Follows the standard order strictly; a pill
 *  that does not fit waits and the unspent points carry to the next round. If the order ends early, the rest are
 *  bought tier 1s first, then tier 2s, then tier 3s, in bar order, so rounds 1-5 always spend all 32. */
function pillRounds(order: BrawlAbilityOrder, hero: Hero): Map<string, number> {
  const classes = hero.abilities.slice(0, 4);
  const queue: string[] = [];
  const add = (k: string) => {
    if (!queue.includes(k)) queue.push(k);
  };
  for (const st of order.steps) {
    const tier = st.kind === 'tier2' ? 2 : st.kind === 'tier3' ? 3 : 1;
    if (classes.includes(st.ability.class_name)) add(`${st.ability.class_name}:${tier}`);
  }
  for (const tier of [1, 2, 3]) for (const c of classes) add(`${c}:${tier}`);
  const out = new Map<string, number>();
  let spent = 0;
  let cap = 0;
  AP_PER_ROUND.forEach((pts, r) => {
    cap += pts;
    while (queue.length) {
      const cost = PILL_COST[Number(queue[0]!.split(':')[1]) - 1]!;
      if (spent + cost > cap) break;
      out.set(queue.shift()!, r + 1);
      spent += cost;
    }
  });
  return out;
}

/** The standard order's points as the panel shows them for `round`: pills bought with this round's points are
 *  `now`, those bought earlier `done`, the rest `later`. */
export function abilityPanelFor(
  order: BrawlAbilityOrder,
  hero: Hero,
  abilities: Ability[],
  round: number,
): AbilityPanelData {
  const reliable = !!order.support && order.support.matches >= MIN_ORDER_MATCHES;
  const rounds = reliable ? pillRounds(order, hero) : new Map<string, number>();
  const slots = heroBarAbilities(hero, abilities).map((ability, i): PanelSlot => {
    const cls = ability.class_name;
    const at = (tier: number): PointState => {
      const r = rounds.get(`${cls}:${tier}`);
      return r === undefined || r > round ? 'later' : r === round ? 'now' : 'done';
    };
    return {
      name: ability?.name ?? cls,
      icon: ability?.image_webp ?? '',
      key: ABILITY_KEYS[i]!,
      tiers: [at(3), at(2), at(1)],
    };
  });
  return { round, points: AP_PER_ROUND[round - 1] ?? 0, slots, evidence: abilityOrderEvidence(order) };
}
