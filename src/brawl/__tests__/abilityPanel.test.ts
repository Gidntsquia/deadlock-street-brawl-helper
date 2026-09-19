import { describe, expect, it } from 'vitest';
import { abilityPanelFor, brawlAbilityOrder } from '../abilities';
import { initialTip, stepTip, TIP_MS } from '../abilityPanelTimer';
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
    expect(overlayHasContent({ draft: false, panel: null })).toBe(false);
    expect(overlayHasContent({ draft: true, panel: null })).toBe(true);
    expect(overlayHasContent({ draft: false, panel: { round: 1, slots: [] } })).toBe(true);
  });
});

describe('abilityPanelFor', () => {
  const hero = heroByName('Infernus');
  const input = inputFor(hero.id);
  const order = brawlAbilityOrder(input);
  const panel = (round: number) => abilityPanelFor(order, hero, input.abilities, round);
  /** Every point of the panel with its state, flattened, as [abilityName, kind, state]. */
  const points = (round: number) =>
    panel(round).slots.flatMap((s) =>
      (
        [
          ['unlock', s.unlock],
          ['tier3', s.tiers[0]],
          ['tier2', s.tiers[1]],
          ['tier1', s.tiers[2]],
        ] as const
      ).map(([kind, st]) => ({ name: s.name, kind, st })),
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

  it("highlights exactly the order's points for this round, greys earlier ones, leaves later ones", () => {
    const rounds = Math.ceil(order.steps.length / 3);
    for (const round of [1, 2, rounds]) {
      const lo = (round - 1) * 3;
      const expected = order.steps.map((st) => ({
        name: st.ability.name,
        kind: st.kind === 'unlock' ? 'unlock' : st.kind,
        st: st.index >= lo + 3 ? 'later' : st.index >= lo ? 'now' : 'done',
      }));
      const got = points(round);
      for (const e of expected) expect(got).toContainEqual(e);
      const now = got.filter((g) => g.st === 'now');
      expect(now.length).toBe(order.steps.filter((st) => st.index >= lo && st.index < lo + 3).length);
      expect(now.length).toBeGreaterThan(0);
    }
    expect(points(1).some((g) => g.st === 'done')).toBe(false); // round 1: nothing earlier
  });
});
