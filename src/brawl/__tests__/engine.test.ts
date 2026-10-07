import { describe, expect, it } from 'vitest';
import {
  ACTIVE_OVERFLOW_PENALTY,
  BRAWL_WEIGHTS,
  adviseDraft,
  baseScores,
  pairLifts,
  roundTiers,
  scoreOffer,
  unknownCeiling,
} from '../engine';
import { heroByName, inputFor, itemByName, items } from './testData';

const infernus = inputFor(heroByName('Infernus').id);

describe('adviseDraft: rare tier bump', () => {
  it('a median tier-bumped (rare) card outscores the best normal card of the tier below it', () => {
    const bases = baseScores(infernus);
    const byTier = (t: number) =>
      [...bases.values()].filter((b) => b.item.item_tier === t).sort((a, b) => a.base - b.base);
    const tier2Best = byTier(2).at(-1)!;
    const tier3 = byTier(3);
    const tier3Median = tier3[Math.floor(tier3.length / 2)];
    expect(tier3Median.base).toBeGreaterThan(tier2Best.base);
  });
});

describe('scoreOffer: enhanced', () => {
  it('adds BRAWL_WEIGHTS.enhanced plus the upgrade carry to the enhanced part of the score', () => {
    const bases = baseScores(infernus);
    const pair = pairLifts(infernus);
    const state = { round: 1, owned: [], enemies: [], sets: [] };
    const item = itemByName('Improved Spirit');
    const plain = scoreOffer(infernus, bases, pair, state, { itemId: item.id, enhanced: false });
    const enhanced = scoreOffer(infernus, bases, pair, state, { itemId: item.id, enhanced: true });
    expect(plain.parts.enhanced).toBe(0);
    const carry = bases.get(item.id)!.carry;
    expect(carry).toBeGreaterThan(0); // Improved Spirit builds into Boundless Spirit
    expect(enhanced.parts.enhanced).toBeCloseTo(BRAWL_WEIGHTS.enhanced + BRAWL_WEIGHTS.enhancedCarry * carry, 10);
    expect(enhanced.score).toBeGreaterThan(plain.score);
  });

  it('values an enhanced card by the best item it upgrades into, since the enhancement survives the upgrade', () => {
    const bases = baseScores(infernus);
    expect(bases.get(itemByName('Grit').id)!.carryInto?.item_tier).toBe(4);
    expect(bases.get(itemByName('Healbane').id)!.carry).toBe(0); // builds into nothing
    const pair = pairLifts(infernus);
    const state = { round: 1, owned: [], enemies: [], sets: [] };
    const score = (name: string, enhanced = false) =>
      scoreOffer(infernus, bases, pair, state, { itemId: itemByName(name).id, enhanced }).score;
    // a good enhanced 800 card beats a strong rare tier-2 card; a weak one does not
    expect(score('Extra Spirit', true)).toBeGreaterThan(score('Healbane'));
    expect(score('Mystic Burst', true)).toBeLessThan(score('Healbane'));
  });

  it('re-rolls a round-1 set whose enhanced 800 card is weak, to draw another enhanced 800 card', () => {
    const set = ['Healbane', 'Mystic Burst', 'Mystic Regeneration'].map((n) => ({
      itemId: itemByName(n).id,
      enhanced: n === 'Mystic Burst',
    }));
    const advice = adviseDraft(infernus, { round: 1, owned: [], enemies: [], sets: [set, [], []] });
    expect(advice.reroll?.set).toBe(0);
    // the same set without the enhanced slot is kept
    const plain = set.map((o) => ({ ...o, enhanced: false }));
    expect(adviseDraft(infernus, { round: 1, owned: [], enemies: [], sets: [plain, [], []] }).reroll).toBeNull();
  });
});

describe('adviseDraft: reroll', () => {
  it('suggests a reroll with positive gain when the set is far below its tier median', () => {
    const bases = baseScores(infernus);
    const layout = roundTiers(infernus, 2);
    const tier = layout[0].normal;
    const weakest = [...bases.values()]
      .filter((b) => b.item.item_tier === tier)
      .sort((a, b) => a.base - b.base)
      .slice(0, 3)
      .map((b) => ({ itemId: b.item.id }));
    const advice = adviseDraft(infernus, { round: 2, owned: [], enemies: [], sets: [weakest, [], []] });
    expect(advice.reroll).not.toBeNull();
    expect(advice.reroll!.gain).toBeGreaterThan(0);
  });

  it('is advised more readily on the last choice, where nothing is left to save it for', () => {
    const bases = baseScores(infernus);
    const layout = roundTiers(infernus, 2);
    const tier = layout[2].normal;
    const sorted = [...bases.values()].filter((b) => b.item.item_tier === tier).sort((a, b) => a.base - b.base);
    const gains: (number | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const sets: { itemId: number }[][] = [[], [], []];
      sets[i] = [0.2, 0.3, 0.4].map((q) => ({ itemId: sorted[Math.floor(sorted.length * q)].item.id }));
      const adv = adviseDraft(infernus, { round: 2, owned: [], enemies: [], sets });
      gains.push(adv.reroll ? adv.reroll.gain - adv.reroll.holdValue : null);
      if (i === 2) expect(adv.reroll!.holdValue).toBe(0);
    }
    expect(gains[2]).not.toBeNull();
    if (gains[0] !== null) expect(gains[2]!).toBeGreaterThan(gains[0]);
  });

  it('README example (Infernus round 2, Improved Spirit set) keeps the set and picks Improved Spirit', () => {
    const set = ['Improved Spirit', "Enchanter's Emblem", 'Swift Striker'].map((n) => ({ itemId: itemByName(n).id }));
    const advice = adviseDraft(infernus, { round: 2, owned: [], enemies: [], sets: [set, [], []] });
    expect(advice.reroll).toBeNull();
    expect(advice.picks[0].item.name).toBe('Improved Spirit');
  });
});

describe('scoreOffer: active overflow', () => {
  it('penalises a 5th active item by ACTIVE_OVERFLOW_PENALTY', () => {
    const bases = baseScores(infernus);
    const pair = pairLifts(infernus);
    const actives = items.filter((i) => i.is_active_item).slice(0, 5);
    const state = { round: 1, owned: actives.slice(0, 4).map((i) => i.id), enemies: [], sets: [] };
    const r = scoreOffer(infernus, bases, pair, state, { itemId: actives[4].id });
    expect(r.parts.active).toBeCloseTo(BRAWL_WEIGHTS.active - ACTIVE_OVERFLOW_PENALTY, 10);
  });
});

describe('scoreOffer: duplicate', () => {
  it('penalises an owned item offered again by BRAWL_WEIGHTS.dup', () => {
    const bases = baseScores(infernus);
    const pair = pairLifts(infernus);
    const item = itemByName('Improved Spirit');
    const state = { round: 1, owned: [item.id], enemies: [], sets: [] };
    const r = scoreOffer(infernus, bases, pair, state, { itemId: item.id });
    expect(r.parts.dup).toBeCloseTo(-BRAWL_WEIGHTS.dup, 10);
  });
});

describe('baseScores: enemy counter', () => {
  it('gives at least one item a non-zero counter term against a known enemy', () => {
    const seven = heroByName('Seven');
    const bases = baseScores(infernus, [seven.id]);
    const hasCounter = [...bases.values()].some((b) => b.counter !== 0);
    expect(hasCounter).toBe(true);
  });
});

describe('unknownCeiling: the take-mark rule with an unread card', () => {
  const state = (offer: { itemId: number; enhanced: boolean }) => ({
    round: 1,
    owned: [] as number[],
    enemies: [] as number[],
    sets: [[offer], [], []],
  });
  it('is at least the score of any real card of that set, so a weaker sure card is not marked', () => {
    const adv = adviseDraft(infernus, state({ itemId: items.find((i) => i.item_tier === 1)!.id, enhanced: false }));
    const top = adv.sets[0]![0]!.score;
    const ceiling = unknownCeiling(
      infernus,
      state({ itemId: items.find((i) => i.item_tier === 1)!.id, enhanced: false }),
      0,
    );
    expect(ceiling).toBeGreaterThanOrEqual(top);
  });
});
