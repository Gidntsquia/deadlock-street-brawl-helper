import { describe, expect, it } from 'vitest';
import { GRADES, heroTiers, itemTiers } from '../tierlist';
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
