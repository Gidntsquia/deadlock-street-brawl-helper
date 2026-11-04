import type { Ability, Hero } from '../types';
import type { BrawlInput } from './types';

type Support = { matches: number; winRate: number };

export interface RoundAbilityPlan {
  /** Upgrade tiers held at the end of this round, in the hero's ability-bar order. */
  levels: number[];
  support: Support;
}

export interface BrawlAbilityOrder {
  /** Earlier purchase paths do not split the evidence for a later round-end target. */
  rounds: (RoundAbilityPlan | null)[];
}

/** Fewest matches that must back the same round-end target. */
export const MIN_ORDER_MATCHES = 100;

const shrunk = (wins: number, matches: number, mean: number, k: number) =>
  ((wins + k * mean) / (matches + k)) * Math.log(1 + matches);

/** Groups observations by the upgrades held at the end of each round, independently of the path to that state.
 *  A short record contributes only while the round's end can be determined. Exhausting a record with enough
 *  points for another upgrade leaves an unknown continuation, never a completed or template-filled round. */
export function brawlAbilityOrder(input: BrawlInput): BrawlAbilityOrder {
  const ids = input.hero.abilities.slice(0, 4).map((cls) => input.abilities.find((a) => a.class_name === cls)?.id);
  const positions = new Map(ids.map((id, i) => [id, i]));
  const empty = (): BrawlAbilityOrder => ({ rounds: AP_PER_ROUND.map(() => null) });
  if (ids.length !== 4 || ids.includes(undefined) || positions.size !== 4) return empty();
  const groups = AP_PER_ROUND.map(() => new Map<string, { levels: number[]; matches: number; wins: number }>());
  for (const s of input.analytics.ability_order_stats ?? []) {
    if (
      !s.abilities.length ||
      s.abilities.length > 12 ||
      !Number.isInteger(s.matches) ||
      s.matches <= 0 ||
      !Number.isFinite(s.wins) ||
      s.wins < 0 ||
      s.wins > s.matches ||
      s.abilities.some((id) => !positions.has(id) || s.abilities.filter((x) => x === id).length > 3)
    )
      continue;
    const levels = [0, 0, 0, 0];
    let at = 0;
    let spent = 0;
    let cap = 0;
    for (let r = 0; r < AP_PER_ROUND.length; r++) {
      cap += AP_PER_ROUND[r]!;
      while (at < s.abilities.length) {
        const a = positions.get(s.abilities[at]!)!;
        const cost = PILL_COST[levels[a]!]!;
        if (spent + cost > cap) break;
        spent += cost;
        levels[a] = levels[a]! + 1;
        at++;
      }
      // Without a recorded next upgrade, spare points that could buy one leave the target unknown.
      if (at === s.abilities.length && levels.some((n) => n < 3 && PILL_COST[n]! <= cap - spent)) break;
      const key = levels.join(',');
      const group = groups[r]!.get(key) ?? { levels: [...levels], matches: 0, wins: 0 };
      group.matches += s.matches;
      group.wins += s.wins;
      groups[r]!.set(key, group);
    }
  }
  let previous = [0, 0, 0, 0];
  return {
    rounds: groups.map((group) => {
      const pool = [...group.entries()];
      const matches = pool.reduce((n, [, s]) => n + s.matches, 0);
      const mean = matches ? pool.reduce((n, [, s]) => n + s.wins, 0) / matches : 0.5;
      const k = Math.max(50, 0.05 * Math.max(1, ...pool.map(([, s]) => s.matches)));
      const best = pool
        .filter(([, s]) => s.matches >= MIN_ORDER_MATCHES && s.levels.every((n, a) => n >= previous[a]!))
        .map(([key, s]) => ({ key, ...s, score: shrunk(s.wins, s.matches, mean, k) }))
        .sort((a, b) => b.score - a.score || b.matches - a.matches || a.key.localeCompare(b.key))[0];
      if (!best) return null;
      // Keep the targets followable without undoing an earlier recommended upgrade. Evidence is still pooled
      // from every observed path reaching this state, not just paths following our earlier recommendation.
      previous = best.levels;
      return { levels: best.levels, support: { matches: best.matches, winRate: best.wins / best.matches } };
    }),
  };
}

/** Index of the order step nearest this draft choice, for highlighting the ability-order list. */
export const abilityStepIndex = (round: number, choice: number) => (round - 1) * 3 + choice - 1;

/** Ability points Street Brawl hands out per round (rounds 1-5; deadlock.wiki "Street Brawl", `m_vecAPPerRound`). */
export const AP_PER_ROUND = [6, 6, 5, 5, 10] as const;
/** Cost of the tier 1 / 2 / 3 point pill. Four abilities fully upgraded cost 32, the five rounds' total. */
const PILL_COST = [1, 2, 5] as const;

/** Automatic targets use `now` for every tier held by round end and `later` for the rest. A custom order also
 *  distinguishes tiers bought in an earlier round (`done`, dark with a check). */
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
  /** Automatic advice highlights the whole target at the end of the round. */
  target?: boolean;
}

/** The one evidence line under the panel title. */
export const evidenceLine = (support: Support | null): string =>
  support && support.matches >= MIN_ORDER_MATCHES
    ? `${support.matches} matches, ${Math.round(support.winRate * 100)}% win rate`
    : 'No reliable order';

/** Labels under the four abilities, left to right: their bar position, not the player's own keybinds. */
export const ABILITY_KEYS = ['1', '2', '3', '4'] as const;

function reliablePlan(plan: RoundAbilityPlan | null | undefined, round: number): plan is RoundAbilityPlan {
  return (
    !!plan &&
    plan.support.matches >= MIN_ORDER_MATCHES &&
    plan.levels.length === 4 &&
    plan.levels.every((n) => Number.isInteger(n) && n >= 0 && n <= 3) &&
    plan.levels.reduce((n, level) => n + PILL_COST.slice(0, level).reduce((sum, cost) => sum + cost, 0), 0) <=
      AP_PER_ROUND.slice(0, round).reduce((n, points) => n + points, 0)
  );
}

/** A player's own order for one hero: the round (1-5) that buys each pill, 12 numbers in bar order, tier 1/2/3 per
 *  ability (index `ability * 3 + tier - 1`). `NOT_BOUGHT` (0) marks a pill the editor has not placed yet; an order with
 *  one is not valid (the panel then uses the standard order). Orders saved before 0 existed load unchanged. */
export type CustomOrder = number[];

export const NOT_BOUGHT = 0;

/** Cost of the pill at `index` of a `CustomOrder`. */
export const pillCost = (index: number): number => PILL_COST[index % 3]!;

/** Seed the editor only when every round has a supported target and the targets form a valid complete plan.
 *  Incompatible independent targets or unknown rounds start an empty editor, never a manufactured continuation. */
export function standardCustom(order: BrawlAbilityOrder, _hero: Hero): CustomOrder {
  const empty = () => Array<number>(12).fill(NOT_BOUGHT);
  const result = empty();
  const previous = [0, 0, 0, 0];
  for (let r = 1; r <= 5; r++) {
    const plan = order.rounds[r - 1];
    if (!reliablePlan(plan, r) || plan.levels.some((level, a) => level < previous[a]!)) return empty();
    plan.levels.forEach((level, a) => {
      for (let t = previous[a]!; t < level; t++) result[a * 3 + t] = r;
      previous[a] = level;
    });
  }
  return customOrderProblem(result) ? empty() : result;
}

/** Why the pills placed so far cannot be followed, or null: a tier bought (or bought earlier) than the one under it,
 *  or a round that spends more points than it and the earlier rounds hand out. Unplaced pills are ignored. */
export function customPartialProblem(custom: CustomOrder): string | null {
  if (custom.length !== 12 || custom.some((r) => !Number.isInteger(r) || r < NOT_BOUGHT || r > 5))
    return 'Pick a round for every point.';
  for (let a = 0; a < 4; a++) {
    const [t1, t2, t3] = custom.slice(a * 3, a * 3 + 3) as [number, number, number];
    const early = (lo: number, hi: number) => hi !== NOT_BOUGHT && (lo === NOT_BOUGHT || hi < lo);
    if (early(t1, t2) || early(t2, t3))
      return `Ability ${a + 1}: a ${early(t2, t3) ? 5 : 2} point upgrade comes before the one under it.`;
  }
  let cap = 0;
  let spent = 0;
  for (let r = 1; r <= 5; r++) {
    cap += AP_PER_ROUND[r - 1]!;
    spent += custom.reduce((n, at, k) => n + (at === r ? pillCost(k) : 0), 0);
    if (spent > cap) return `Round ${r}: ${spent} points spent by now, only ${cap} handed out.`;
  }
  return null;
}

/** Why a custom order cannot be followed, or null when it can: a pill with no round, a tier bought before the one
 *  under it, or a round that spends more points than it and the earlier rounds hand out. */
export function customOrderProblem(custom: CustomOrder): string | null {
  return customPartialProblem(custom) ?? (custom.includes(NOT_BOUGHT) ? 'Pick a round for every point.' : null);
}

/** Points left to spend by the end of `round` (they carry over): handed out in rounds 1..round minus spent in them. */
export const customPointsLeft = (custom: CustomOrder, round: number): number =>
  AP_PER_ROUND.slice(0, round).reduce((n, p) => n + p, 0) -
  custom.reduce((n, at, k) => n + (at !== NOT_BOUGHT && at <= round ? pillCost(k) : 0), 0);

/** Points the custom order spends in each round 1-5. */
export const customRoundPoints = (custom: CustomOrder): number[] =>
  [1, 2, 3, 4, 5].map((r) => custom.reduce((n, at, k) => n + (at === r ? pillCost(k) : 0), 0));

/** Automatic advice is the whole target at the end of this round; it makes no claim about earlier purchases.
 *  A complete user-defined order retains its explicit per-round highlights. */
export function abilityPanelFor(
  order: BrawlAbilityOrder,
  hero: Hero,
  abilities: Ability[],
  round: number,
  custom?: CustomOrder | null,
): AbilityPanelData {
  const mine = custom && !customOrderProblem(custom) ? custom : null;
  const plan = order.rounds[round - 1];
  const reliable = reliablePlan(plan, round);
  const slots = hero.abilities.slice(0, 4).map((cls, a): PanelSlot => {
    const at = (tier: number): PointState => {
      if (!mine) return reliable && tier <= plan.levels[a]! ? 'now' : 'later';
      const r = mine[a * 3 + tier - 1]!;
      return r > round ? 'later' : r === round ? 'now' : 'done';
    };
    const ability = abilities.find((ab) => ab.class_name === cls);
    return {
      name: ability?.name ?? cls,
      icon: ability?.image_webp ?? '',
      key: ABILITY_KEYS[a]!,
      tiers: [at(3), at(2), at(1)],
    };
  });
  return {
    round,
    points: AP_PER_ROUND[round - 1] ?? 0,
    slots,
    evidence: mine ? 'Your order' : evidenceLine(reliable ? plan.support : null),
    target: !mine,
  };
}
