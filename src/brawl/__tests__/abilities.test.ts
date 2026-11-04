import { describe, expect, it } from 'vitest';
import { AP_PER_ROUND, abilityPanelFor, brawlAbilityOrder, standardCustom } from '../abilities';
import { heroByName, inputFor } from './testData';

const hero = heroByName('Infernus');
const base = inputFor(hero.id);
const ids = hero.abilities.map((cls) => base.abilities.find((a) => a.class_name === cls)!.id);
const [a, b, c, d] = ids as [number, number, number, number];
const seq = [a, b, c, d, a, b, c, d, a, b, c, d];
const equivalent = [d, c, b, a, a, b, c, d, a, b, c, d];
const different = [a, a, a, b, b, b, c, c, c, d, d, d];
const converging = [b, b, b, a, a, a, c, c, c, d, d, d];
const stat = (abilities: number[], matches: number, wins: number) => ({
  abilities,
  matches,
  wins,
  losses: matches - wins,
  players: matches,
});
const withStats = (stats: ReturnType<typeof stat>[]) => ({
  ...base,
  analytics: { ...base.analytics, ability_order_stats: stats },
});

describe('round-end ability targets', () => {
  it('builds supported targets within each round budget and never recommends undoing a tier', () => {
    const order = brawlAbilityOrder(base);
    let previous = [0, 0, 0, 0];
    let cap = 0;
    for (const [r, plan] of order.rounds.entries()) {
      cap += AP_PER_ROUND[r]!;
      expect(plan).not.toBeNull();
      expect(plan!.support.matches).toBeGreaterThanOrEqual(100);
      expect(plan!.levels.every((n, i) => n >= previous[i]! && n <= 3)).toBe(true);
      const spent = plan!.levels.reduce((n, level) => n + [0, 1, 3, 8][level]!, 0);
      expect(spent).toBeLessThanOrEqual(cap);
      previous = plan!.levels;
    }
  });

  it('pools different purchase orders within a round before applying the sample minimum', () => {
    const order = brawlAbilityOrder(withStats([stat(seq, 60, 40), stat(equivalent, 60, 50)]));
    expect(order.rounds[0]).toEqual({ levels: [2, 1, 1, 1], support: { matches: 120, winRate: 0.75 } });
    expect(brawlAbilityOrder(withStats([stat(equivalent, 60, 50), stat(seq, 60, 40)]))).toEqual(order);
  });

  it('merges paths that differ through round 2 but reach the same state at round 3', () => {
    const order = brawlAbilityOrder(withStats([stat(different, 60, 40), stat(converging, 60, 50)]));
    expect(order.rounds[0]).toBeNull();
    expect(order.rounds[1]).toBeNull();
    expect(order.rounds[2]).toEqual({ levels: [3, 3, 1, 0], support: { matches: 120, winRate: 0.75 } });
  });

  it('pools paths with different first-round targets as soon as they converge in round 2', () => {
    const other = [b, b, a, a, a, b, c, c, c, d, d, d];
    const order = brawlAbilityOrder(withStats([stat(different, 60, 40), stat(other, 60, 50)]));
    expect(order.rounds[0]).toBeNull();
    expect(order.rounds[1]).toEqual({ levels: [3, 2, 0, 0], support: { matches: 120, winRate: 0.75 } });
  });

  it('sums wins and matches instead of averaging the purchase orders win rates', () => {
    const order = brawlAbilityOrder(withStats([stat(seq, 60, 48), stat(equivalent, 140, 70)]));
    expect(order.rounds[0]!.support).toEqual({ matches: 200, winRate: 118 / 200 });
  });

  it('allows equal sample sizes when the same observations support different round-end states', () => {
    const order = brawlAbilityOrder(withStats([stat(seq, 200, 120)]));
    expect(order.rounds.map((p) => p!.support.matches)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(order.rounds.map((p) => p!.levels.join(','))).size).toBe(5);
  });

  it('keeps different round-end states separate even though both finish fully upgraded', () => {
    const order = brawlAbilityOrder(withStats([stat(seq, 60, 40), stat(different, 60, 50)]));
    expect(order.rounds[2]).toBeNull();
    expect(order.rounds[4]).toEqual({ levels: [3, 3, 3, 3], support: { matches: 120, winRate: 0.75 } });
  });

  it('counts a short record for a completed round, without manufacturing later targets', () => {
    const order = brawlAbilityOrder(withStats([stat(different.slice(0, 7), 100, 70), stat(converging, 30, 20)]));
    expect(order.rounds[2]).toEqual({ levels: [3, 3, 1, 0], support: { matches: 130, winRate: 90 / 130 } });
    expect(order.rounds[3]).toBeNull();
    expect(order.rounds[4]).toBeNull();
    expect(standardCustom(order, hero)).toEqual(Array(12).fill(0));
    const panel = abilityPanelFor(order, hero, base.abilities, 4);
    expect(panel.slots).toHaveLength(4);
    expect(panel.slots.every((slot) => slot.tiers.every((tier) => tier === 'later'))).toBe(true);
    expect(panel.evidence).toBe('No reliable order');
  });

  it('does not count an exhausted prefix while another upgrade could still fit in that round', () => {
    const order = brawlAbilityOrder(withStats([stat([a, a, b, b, a], 5000, 4000)]));
    expect(order.rounds[0]!.support.matches).toBe(5000);
    expect(order.rounds.slice(1)).toEqual([null, null, null, null]);
  });

  it('does not add incomplete popular prefixes to later-state evidence', () => {
    const order = brawlAbilityOrder(
      withStats([stat([a, b], 10000, 8000), stat(different, 1000, 500), stat(seq, 500, 400)]),
    );
    expect(order.rounds[2]).toEqual({ levels: [3, 2, 2, 2], support: { matches: 500, winRate: 0.8 } });
  });

  it('balances sample size and win rate rather than selecting a rare perfect result', () => {
    const order = brawlAbilityOrder(withStats([stat(seq, 100, 100), stat(different, 10000, 6000)]));
    expect(order.rounds[2]).toEqual({ levels: [3, 3, 1, 0], support: { matches: 10000, winRate: 0.6 } });
  });

  it('keeps the original 100-match boundary', () => {
    const order = brawlAbilityOrder(withStats([stat(seq, 100, 60)]));
    expect(order.rounds.every((p) => p?.support.matches === 100)).toBe(true);
    expect(abilityPanelFor(order, hero, base.abilities, 1).slots).toHaveLength(4);
  });

  it.each([
    { name: 'empty data', stats: [] },
    { name: 'an unfinished first round', stats: [stat([a, b], 5000, 4000)] },
    { name: 'below the sample minimum', stats: [stat(seq, 99, 80)] },
  ])('shows missing data without manufacturing upgrades: $name', ({ stats }) => {
    const order = brawlAbilityOrder(withStats(stats));
    expect(order.rounds).toEqual([null, null, null, null, null]);
    expect(standardCustom(order, hero)).toEqual(Array(12).fill(0));
    for (const r of [1, 2, 3, 4, 5]) {
      const panel = abilityPanelFor(order, hero, base.abilities, r);
      expect(panel.round).toBe(r);
      expect(panel.evidence).toBe('No reliable order');
      expect(panel.slots).toHaveLength(4);
      expect(panel.slots.every((slot) => slot.tiers.every((tier) => tier === 'later'))).toBe(true);
    }
  });

  it('rejects records containing a foreign ability or a fourth tier', () => {
    const foreign = base.abilities.find((ab) => !ids.includes(ab.id))!.id;
    const order = brawlAbilityOrder(
      withStats([stat([foreign, ...seq.slice(1)], 1000, 900), stat([a, a, a, a, b, b, c, c, c, d, d, d], 1000, 900)]),
    );
    expect(order.rounds.every((p) => p === null)).toBe(true);
  });

  it('shows the cumulative target without inventing an earlier upgrade history', () => {
    const order = brawlAbilityOrder(withStats([stat(seq, 60, 40), stat(equivalent, 60, 50)]));
    const panel = abilityPanelFor(order, hero, base.abilities, 3);
    expect(panel.target).toBe(true);
    expect(panel.slots.map((s) => s.tiers)).toEqual([
      ['now', 'now', 'now'],
      ['later', 'now', 'now'],
      ['later', 'now', 'now'],
      ['later', 'now', 'now'],
    ]);
    expect(panel.evidence).toBe('120 matches, 75% win rate');
  });
});
