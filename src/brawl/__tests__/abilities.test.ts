import { describe, expect, it } from 'vitest';
import { brawlAbilityOrder } from '../abilities';
import { heroByName, inputFor } from './testData';

const infernus = inputFor(heroByName('Infernus').id);

describe('brawlAbilityOrder', () => {
  it("returns a sequence covering most of the game, only the hero's own abilities, unlocks before upgrades", () => {
    const order = brawlAbilityOrder(infernus);
    expect(order.steps.length).toBeGreaterThanOrEqual(7);

    const sigIds = new Set(
      infernus.abilities.filter((a) => infernus.hero.abilities.includes(a.class_name)).map((a) => a.id),
    );
    for (const step of order.steps) expect(sigIds.has(step.ability.id)).toBe(true);

    const firstIndexByAbility = new Map<number, number>();
    for (const step of order.steps)
      if (!firstIndexByAbility.has(step.ability.id)) firstIndexByAbility.set(step.ability.id, step.index);
    for (const step of order.steps) {
      if (step.kind === 'unlock') continue;
      expect(step.index).toBeGreaterThan(firstIndexByAbility.get(step.ability.id)!);
    }

    expect(order.support).not.toBeNull();
    expect(order.support!.matches).toBeGreaterThan(0);
  });
});
