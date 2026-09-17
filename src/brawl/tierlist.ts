import type { Hero, Item } from '../types';

/** public/data/analytics/brawl/tier-list.json, written by scripts/fetch-data.mjs (`--brawl-tierlist`). */
export interface BrawlTierListData {
  fetched_at: string;
  game_mode: 'street_brawl';
  /** Both ends of the window the numbers cover; hero counts and item counts share it. */
  min_unix_timestamp: number;
  max_unix_timestamp: number | null;
  window_days: number;
  /** hero-games in the window: the denominator for every usage figure here */
  hero_games: number;
  heroes: { hero_id: number; wins: number; losses: number; matches: number }[];
  items: { item_id: number; wins: number; losses: number; matches: number; players: number }[];
}

export type Grade = 'S' | 'A' | 'B' | 'C';
export const GRADES: Grade[] = ['S', 'A', 'B', 'C'];

export interface TierEntry<T> {
  subject: T;
  matches: number;
  winRate: number; // wins / matches
  usage: number; // share of hero-games the subject appeared in
  score: number; // combined z-score, the value the grade is cut from
  grade: Grade;
}

// Win rate is the outcome and carries most of the weight; usage is what the population thinks, which
// catches subjects whose win rate is flattered or punished by who plays them.
const W_WIN = 0.7;
const W_USE = 0.3;
// Matches of pull toward the population win rate. Every row in the snapshot has thousands of games, so
// this changes nothing today; it keeps a thin sample from grading S off a lucky streak.
const PRIOR = 500;
// Cut points on the combined z-score. Over a roughly normal population this lands ~13% S, ~25% A, ~35% B.
const CUTS: [Grade, number][] = [
  ['S', 1.15],
  ['A', 0.35],
  ['B', -0.6],
];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Standard scores; a population with no spread scores flat rather than dividing by zero. */
function z(xs: number[]): number[] {
  if (xs.length < 2) return xs.map(() => 0);
  const m = sum(xs) / xs.length;
  const sd = Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / xs.length);
  return sd ? xs.map((x) => (x - m) / sd) : xs.map(() => 0);
}
const gradeOf = (score: number): Grade => CUTS.find(([, cut]) => score >= cut)?.[0] ?? 'C';

interface Row<T> {
  subject: T;
  wins: number;
  matches: number;
}

/** Grades one population against itself: both inputs are standardised, mixed, then cut into S/A/B/C. */
function rank<T>(rows: Row<T>[], games: number): TierEntry<T>[] {
  if (!rows.length) return [];
  const base = sum(rows.map((r) => r.wins)) / Math.max(1, sum(rows.map((r) => r.matches)));
  const win = z(rows.map((r) => (r.wins + PRIOR * base) / (r.matches + PRIOR)));
  // usage spans an order of magnitude between the most and least drafted, so standardise the log
  const use = z(rows.map((r) => Math.log(Math.max(1, r.matches) / games)));
  const score = z(rows.map((_, i) => W_WIN * win[i] + W_USE * use[i]));
  return rows
    .map((r, i) => ({
      subject: r.subject,
      matches: r.matches,
      winRate: r.wins / r.matches,
      usage: r.matches / games,
      score: score[i],
      grade: gradeOf(score[i]),
    }))
    .sort((a, b) => b.score - a.score);
}

/** Every hero graded against the rest of the roster. */
export function heroTiers(data: BrawlTierListData, heroes: Hero[]): TierEntry<Hero>[] {
  const byId = new Map(heroes.map((h) => [h.id, h]));
  const rows: Row<Hero>[] = [];
  for (const s of data.heroes) {
    const hero = byId.get(s.hero_id);
    if (hero && s.matches > 0) rows.push({ subject: hero, wins: s.wins, matches: s.matches });
  }
  return rank(rows, data.hero_games);
}

/**
 * Every draftable item graded against the other items of its own draft tier. Tier decides which round an
 * item can even appear in, so a tier 1 item and a tier 5 item are never the same choice; grading across
 * all of them would just sort by tier. The grade answers "of the tier N cards, how good is this one".
 */
export function itemTiers(data: BrawlTierListData, items: Item[]): TierEntry<Item>[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const groups = new Map<number, Row<Item>[]>();
  for (const s of data.items) {
    const item = byId.get(s.item_id);
    if (!item || item.disabled || item.item_tier < 1 || s.matches <= 0) continue;
    const g = groups.get(item.item_tier) ?? [];
    g.push({ subject: item, wins: s.wins, matches: s.matches });
    groups.set(item.item_tier, g);
  }
  return [...groups.values()].flatMap((g) => rank(g, data.hero_games)).sort((a, b) => b.score - a.score);
}

export const byGrade = <T>(rows: TierEntry<T>[]) =>
  GRADES.map((grade) => ({ grade, rows: rows.filter((r) => r.grade === grade) }));
