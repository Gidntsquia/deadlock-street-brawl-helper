import type { Ability, AbilityOrderStat, AbilityStep, Hero } from '../types';
import type { BrawlInput } from './types';

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
  const byId = new Map(input.abilities.map((a) => [a.id, a]));
  const sig = input.abilities.filter((a) => input.hero.abilities.includes(a.class_name));
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

  if (!chosen.length) {
    const ids = input.hero.abilities
      .map((c) => sig.find((a) => a.class_name === c)?.id)
      .filter((x): x is number => !!x);
    const seq = [...ids];
    for (let t = 0; t < 3; t++) for (const id of ids) seq.push(id);
    return { steps: stepsFor(seq, byId), support: null, alternatives: [] };
  }
  return { steps: stepsFor(chosen, byId), support, alternatives: [] };
}

/** Index of the order step nearest this draft choice, for highlighting the ability-order list. */
export const abilityStepIndex = (round: number, choice: number) => (round - 1) * 3 + choice - 1;

/** Ability points Street Brawl hands out per round (rounds 1-5; deadlock.wiki "Street Brawl", `m_vecAPPerRound`). */
export const AP_PER_ROUND = [6, 6, 5, 5, 10] as const;
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

/** A player's own order for one hero: the round (1-5) that buys each pill, 12 numbers in bar order, tier 1/2/3 per
 *  ability (index `ability * 3 + tier - 1`). */
export type CustomOrder = number[];

/** The standard order as a `CustomOrder`, the starting point of the editor. */
export function standardCustom(order: BrawlAbilityOrder, hero: Hero): CustomOrder {
  const rounds = pillRounds(order, hero);
  return hero.abilities.slice(0, 4).flatMap((cls) => [1, 2, 3].map((t) => rounds.get(`${cls}:${t}`) ?? 5));
}

/** Why a custom order cannot be followed, or null when it can: a tier bought before the one under it, or a round
 *  that spends more points than it and the earlier rounds hand out. */
export function customOrderProblem(custom: CustomOrder): string | null {
  if (custom.length !== 12 || custom.some((r) => !Number.isInteger(r) || r < 1 || r > 5))
    return 'Pick a round for every point.';
  for (let a = 0; a < 4; a++) {
    const [t1, t2, t3] = custom.slice(a * 3, a * 3 + 3) as [number, number, number];
    if (t2 < t1 || t3 < t2)
      return `Ability ${a + 1}: a ${t3 < t2 ? 5 : 2} point upgrade comes before the one under it.`;
  }
  let cap = 0;
  let spent = 0;
  for (let r = 1; r <= 5; r++) {
    cap += AP_PER_ROUND[r - 1]!;
    spent += custom.reduce((n, at, k) => n + (at === r ? PILL_COST[k % 3]! : 0), 0);
    if (spent > cap) return `Round ${r}: ${spent} points spent by now, only ${cap} handed out.`;
  }
  return null;
}

/** Points the custom order spends in each round 1-5. */
export const customRoundPoints = (custom: CustomOrder): number[] =>
  [1, 2, 3, 4, 5].map((r) => custom.reduce((n, at, k) => n + (at === r ? PILL_COST[k % 3]! : 0), 0));

/** The standard order's points as the panel shows them for `round`: pills bought with this round's points are
 *  `now`, those bought earlier `done`, the rest `later`. A valid `custom` order replaces the standard one. */
export function abilityPanelFor(
  order: BrawlAbilityOrder,
  hero: Hero,
  abilities: Ability[],
  round: number,
  custom?: CustomOrder | null,
): AbilityPanelData {
  const mine = custom && !customOrderProblem(custom) ? custom : null;
  const reliable = !!order.support && order.support.matches >= MIN_ORDER_MATCHES;
  const rounds = mine
    ? new Map(
        hero.abilities
          .slice(0, 4)
          .flatMap((cls, a) => [1, 2, 3].map((t) => [`${cls}:${t}`, mine[a * 3 + t - 1]!] as const)),
      )
    : reliable
      ? pillRounds(order, hero)
      : new Map<string, number>();
  const slots = hero.abilities.slice(0, 4).map((cls, i): PanelSlot => {
    const at = (tier: number): PointState => {
      const r = rounds.get(`${cls}:${tier}`);
      return r === undefined || r > round ? 'later' : r === round ? 'now' : 'done';
    };
    const ability = abilities.find((a) => a.class_name === cls);
    return {
      name: ability?.name ?? cls,
      icon: ability?.image_webp ?? '',
      key: ABILITY_KEYS[i]!,
      tiers: [at(3), at(2), at(1)],
    };
  });
  return {
    round,
    points: AP_PER_ROUND[round - 1] ?? 0,
    slots,
    evidence: mine ? 'Your order' : evidenceLine(order.support),
  };
}

/** The active ability order as ability ids in upgrade order (what `item_stats_by_order` is keyed on): a valid custom
 *  order sorted by round, then tier, then bar position; else the default (best blended) order's steps. */
export function orderAbilityIds(
  order: BrawlAbilityOrder,
  hero: Hero,
  abilities: Ability[],
  custom?: CustomOrder | null,
): number[] {
  if (!custom || customOrderProblem(custom)) return order.steps.map((s) => s.ability.id);
  const pills = hero.abilities.slice(0, 4).flatMap((cls, a) => {
    const id = abilities.find((x) => x.class_name === cls)?.id;
    return id === undefined ? [] : [1, 2, 3].map((t) => ({ id, a, t, r: custom[a * 3 + t - 1]! }));
  });
  return pills.sort((x, y) => x.r - y.r || x.t - y.t || x.a - y.a).map((p) => p.id);
}
