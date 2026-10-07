import { describe, expect, it } from 'vitest';
import {
  abilityPanelFor,
  brawlAbilityOrder,
  customOrderProblem,
  customRoundPoints,
  standardCustom,
} from '../abilities';
import { CLOSE_FRAMES, initialTip, stepTip, TIP_MS } from '../abilityPanelTimer';
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
    const T = CLOSE_FRAMES * 100;
    const closed = run([
      [true, 0],
      ...Array.from({ length: CLOSE_FRAMES }, (_, i): [boolean, number] => [false, (i + 1) * 100]),
    ]);
    expect(closed.tip).toEqual({ value: 'Afterburn', endsAt: T + TIP_MS });
    expect(stepTip(closed, false, T + TIP_MS - 1, null).tip).not.toBeNull();
    const done = stepTip(closed, false, T + TIP_MS, null);
    expect(done.tip).toBeNull();
    expect(stepTip(done, false, T + TIP_MS + 5000, 'Afterburn').tip).toBeNull(); // no reappearing until next draft
  });

  it('ends at once when a draft reopens, and a one-frame blink does not start a tip', () => {
    const closed = run([
      [true, 0],
      ...Array.from({ length: CLOSE_FRAMES }, (_, i): [boolean, number] => [false, (i + 1) * 100]),
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
    expect(overlayHasContent({ draft: false, panel: null })).toBe(false);
    expect(overlayHasContent({ draft: true, panel: null })).toBe(true);
    expect(overlayHasContent({ draft: false, panel: { round: 1, slots: [], evidence: '' } })).toBe(true);
  });
});

describe('abilityPanelFor', () => {
  const hero = heroByName('Infernus');
  const input = inputFor(hero.id);
  const order = brawlAbilityOrder(input);
  const panel = (round: number) => abilityPanelFor(order, hero, input.abilities, round);
  const COST = { 0: 5, 1: 2, 2: 1 } as const;
  const sum = (round: number, state: string) =>
    panel(round).slots.reduce(
      (n, sl) => n + sl.tiers.reduce((m, st, k) => m + (st === state ? COST[k as 0 | 1 | 2] : 0), 0),
      0,
    );

  it('lists the hero abilities in bar order with key caps and icons', () => {
    const p = panel(1);
    expect(p.slots).toHaveLength(4);
    p.slots.forEach((s, i) => {
      expect(s.name).toBe(input.abilities.find((a) => a.class_name === hero.abilities[i])!.name);
      expect(s.icon).toMatch(/^img\//);
    });
    expect(p.slots.map((s) => s.key)).toEqual(['Q', 'E', 'R', 'F']);
  });

  it('spends 6/6/5/5/10 points a round without overspending, and all 32 by round 5', () => {
    const pts = [6, 6, 5, 5, 10];
    let carried = 0;
    let cum = 0;
    pts.forEach((p, i) => {
      expect(panel(i + 1).points).toBe(p);
      const now = sum(i + 1, 'now');
      cum += p;
      expect(sum(i + 1, 'done')).toBe(carried);
      expect(carried + now).toBeLessThanOrEqual(cum);
      carried += now;
    });
    expect(carried).toBe(32);
    expect(sum(5, 'later')).toBe(0);
    expect(sum(1, 'done')).toBe(0);
    expect(sum(1, 'now')).toBeGreaterThan(1);
  });
});

describe('custom ability order', () => {
  const hero = heroByName('Infernus');
  const input = inputFor(hero.id);
  const order = brawlAbilityOrder(input);
  // R1: 3 in 2, 3 in 4. R2: 5 in 2, 1 in 3. R3: 5 in 4. R4: 2 in 3, 3 in 1. R5: the rest.
  const mine = [4, 4, 5, 1, 1, 2, 2, 4, 5, 1, 1, 3];

  it('is valid and spends each round exactly', () => {
    expect(customOrderProblem(mine)).toBeNull();
    expect(customRoundPoints(mine)).toEqual([6, 6, 5, 5, 10]);
  });

  it('drives the panel', () => {
    const p = abilityPanelFor(order, hero, input.abilities, 2, mine);
    expect(p.evidence).toBe('Your order');
    // tiers are listed 5/2/1 top to bottom
    expect(p.slots.map((s) => s.tiers)).toEqual([
      ['later', 'later', 'later'],
      ['now', 'done', 'done'],
      ['later', 'later', 'now'],
      ['later', 'done', 'done'],
    ]);
  });

  it('rejects overspending and tiers out of order, and the panel falls back to the standard order', () => {
    expect(customOrderProblem([1, 1, 1, 1, 1, 1, 5, 5, 5, 5, 5, 5])).toMatch(/^Round 1/);
    expect(customOrderProblem([2, 1, 5, 1, 1, 2, 2, 4, 5, 1, 3, 3])).toMatch(/^Ability 1/);
    const bad = abilityPanelFor(order, hero, input.abilities, 1, [5, 5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(bad).toEqual(abilityPanelFor(order, hero, input.abilities, 1));
  });

  it('starts the editor from the standard order', () => {
    const std = standardCustom(order, hero);
    expect(customOrderProblem(std)).toBeNull();
    expect(abilityPanelFor(order, hero, input.abilities, 3, std).slots).toEqual(
      abilityPanelFor(order, hero, input.abilities, 3).slots,
    );
  });
});
