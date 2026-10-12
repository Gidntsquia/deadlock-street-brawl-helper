import { describe, expect, it } from 'vitest';
import { GRADES, heroTiers, holdsTopCard, itemTiers } from '../tierlist';
import { heroes, items, tierList } from './testData';

describe('heroTiers', () => {
  const rows = heroTiers(tierList, heroes);

  it('gives every graded hero exactly one grade in S/A/B/C', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(GRADES).toContain(r.grade);
  });

  it('is sorted so grade order is monotone in score', () => {
    for (let i = 1; i < rows.length; i++) expect(rows[i].score).toBeLessThanOrEqual(rows[i - 1].score);
    const rank = new Map(GRADES.map((g, i) => [g, i]));
    for (let i = 1; i < rows.length; i++)
      expect(rank.get(rows[i].grade)!).toBeGreaterThanOrEqual(rank.get(rows[i - 1].grade)!);
  });
});

describe('itemTiers', () => {
  const rows = itemTiers(tierList, items);

  it('gives every graded item exactly one grade in S/A/B/C', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(GRADES).toContain(r.grade);
  });

  it('grades items within their own tier group, each grade non-empty is monotone in score within that tier', () => {
    const byTier = new Map<number, typeof rows>();
    for (const r of rows) {
      const t = r.subject.item_tier;
      const xs = byTier.get(t) ?? [];
      xs.push(r);
      byTier.set(t, xs);
    }
    for (const xs of byTier.values()) {
      const sorted = [...xs].sort((a, b) => b.score - a.score);
      const rank = new Map(GRADES.map((g, i) => [g, i]));
      for (let i = 1; i < sorted.length; i++)
        expect(rank.get(sorted[i].grade)!).toBeGreaterThanOrEqual(rank.get(sorted[i - 1].grade)!);
    }
  });
});

describe('holdsTopCard', () => {
  const grades = new Map([
    [1, 'S'],
    [2, 'A'],
    [3, 'B'],
    [4, 'C'],
  ]);
  it('is true when any card is graded S or A, so no re-roll is called on that set', () => {
    expect(holdsTopCard([3, 2, 4], grades)).toBe(true);
    expect(holdsTopCard([1], grades)).toBe(true);
  });
  it('is false for a set of B, C and ungraded cards', () => {
    expect(holdsTopCard([3, 4, 99], grades)).toBe(false);
    expect(holdsTopCard([], grades)).toBe(false);
  });
});
