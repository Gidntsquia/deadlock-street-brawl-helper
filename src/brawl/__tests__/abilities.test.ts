import { describe, expect, it } from 'vitest';
import { abilityPanelFor, brawlAbilityOrder } from '../abilities';
import { heroByName, inputFor } from './testData';

const infernus = inputFor(heroByName('Infernus').id);

describe('brawlAbilityOrder', () => {
  it("returns a sequence covering most of the game, only the hero's own abilities, tiers in order, no unlocks", () => {
    const order = brawlAbilityOrder(infernus);
    expect(order.steps.length).toBeGreaterThanOrEqual(7);

    const sigIds = new Set(
      infernus.abilities.filter((a) => infernus.hero.abilities.includes(a.class_name)).map((a) => a.id),
    );
    for (const step of order.steps) expect(sigIds.has(step.ability.id)).toBe(true);

    // No unlock steps; each ability's points come as tier1, tier2, tier3 in that order.
    const seen = new Map<number, number>();
    for (const step of order.steps) {
      const n = seen.get(step.ability.id) ?? 0;
      expect(step.kind).toBe(['tier1', 'tier2', 'tier3'][n]);
      seen.set(step.ability.id, n + 1);
    }

    expect(order.support).not.toBeNull();
    expect(order.support!.matches).toBeGreaterThan(0);
  });
});

describe('step-by-step order', () => {
  const hero = heroByName('Infernus');
  const base = inputFor(hero.id);
  const ids = base.abilities.filter((a) => hero.abilities.includes(a.class_name)).map((a) => a.id);
  const [a, b, c] = ids as [number, number, number];
  const withStats = (stats: { abilities: number[]; wins: number; matches: number }[]) =>
    ({ ...base, analytics: { ...base.analytics, ability_order_stats: stats } }) as typeof base;

  it('counts short sequences toward the early steps they cover', () => {
    // [a,b] alone is the most played: it must lead the first two steps even though [a,c,c,c] is longer.
    const order = brawlAbilityOrder(
      withStats([
        { abilities: [a, b], wins: 300, matches: 600 },
        { abilities: [a, b, c], wins: 40, matches: 80 },
        { abilities: [a, c, c], wins: 90, matches: 150 },
      ]),
    );
    expect(order.steps.map((s) => s.ability.id)).toEqual([a, b]);
    expect(order.support).toEqual({ matches: 680, winRate: 340 / 680 });
  });

  it('gives no reliable order when too few matches back it', () => {
    const order = brawlAbilityOrder(withStats([{ abilities: [a, b], wins: 20, matches: 60 }]));
    expect(order.support).toBeNull();
    const panel = abilityPanelFor(order, hero, base.abilities, 1);
    expect(panel.evidence).toBe('No reliable order');
    expect(panel.slots.every((s) => s.tiers.every((t) => t === 'later'))).toBe(true);
  });

  it('writes the evidence line and the round of the panel it is asked for', () => {
    const order = brawlAbilityOrder(base);
    for (const r of [1, 2, 3, 4, 5]) {
      const p = abilityPanelFor(order, hero, base.abilities, r);
      expect(p.round).toBe(r);
      expect(p.evidence).toMatch(/^\d+ matches, \d+% win rate$/);
    }
  });
});
