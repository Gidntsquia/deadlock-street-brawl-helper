import { describe, expect, it } from 'vitest';
import { brawlAbilityOrder } from '../abilities';
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
