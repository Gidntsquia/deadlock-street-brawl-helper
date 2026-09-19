import { describe, expect, it } from 'vitest';
import { abilityStepIndex, abilityTargetFor, brawlAbilityOrder } from '../abilities';
import { initialTip, stepTip, TIP_MS } from '../abilityTip';
import { overlayHasContent } from '../overlayContent';
import { heroByName, inputFor } from './testData';

describe('ability tip lifecycle', () => {
  const run = (frames: [boolean, number][], cur: string | null = 'Afterburn') => {
    let s = initialTip<string>();
    for (const [shop, t] of frames) s = stepTip(s, shop, t, cur);
    return s;
  };

  it('is 15 s by default, starts only after a draft closes, and expires on its own', () => {
    expect(TIP_MS).toBe(15_000);
    expect(run([[false, 0]]).tip).toBeNull(); // never saw a draft: nothing to show
    const closed = run([
      [true, 0],
      [false, 100],
      [false, 200],
    ]); // two non-draft frames = closed
    expect(closed.tip).toEqual({ value: 'Afterburn', endsAt: 200 + TIP_MS });
    expect(stepTip(closed, false, 200 + TIP_MS - 1, null).tip).not.toBeNull();
    const done = stepTip(closed, false, 200 + TIP_MS, null);
    expect(done.tip).toBeNull();
    expect(stepTip(done, false, 200 + TIP_MS + 5000, 'Afterburn').tip).toBeNull(); // no reappearing until next draft
  });

  it('ends at once when a draft reopens, and a one-frame blink does not start a tip', () => {
    const closed = run([
      [true, 0],
      [false, 100],
      [false, 200],
    ]);
    expect(stepTip(closed, true, 1000, 'Afterburn').tip).toBeNull();
    expect(
      run([
        [true, 0],
        [false, 100],
        [true, 200],
      ]).tip,
    ).toBeNull();
  });

  it('draws nothing unless on the draft or the tip is running', () => {
    expect(overlayHasContent(null)).toBe(false);
    expect(overlayHasContent({ draft: false, tip: null })).toBe(false);
    expect(overlayHasContent({ draft: true, tip: null })).toBe(true);
    expect(overlayHasContent({ draft: false, tip: { slot: 0 } })).toBe(true);
  });
});

describe('abilityTargetFor', () => {
  it("names the step the ability list marks `now` and its slot on the hero's bar", () => {
    const hero = heroByName('Infernus');
    const order = brawlAbilityOrder(inputFor(hero.id));
    for (const [round, choice] of [
      [1, 1],
      [1, 2],
      [2, 1],
    ] as const) {
      const step = order.steps[abilityStepIndex(round, choice)];
      const t = abilityTargetFor(order, hero, round, choice);
      expect(t?.name).toBe(step.ability.name);
      expect(hero.abilities[t!.slot]).toBe(step.ability.class_name);
    }
  });
});
