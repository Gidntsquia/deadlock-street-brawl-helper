import { describe, expect, it } from 'vitest';
import { HeroEvidence } from '../heroEvidence';

describe('match-bound hero evidence', () => {
  it('uses loading text ahead of portraits, while a manual pick wins both', () => {
    const evidence = new HeroEvidence();
    expect(evidence.observeLoading(67, 0)).toBe(67);
    evidence.confirmNewMatch(10);
    expect(evidence.resolve(1, 76, false, 20).heroId).toBe(67);
    expect(evidence.resolve(1, 76, true, 20).heroId).toBe(76);
  });
  it('stages a new loading hero until a later match is confirmed and never carries the prior name', () => {
    const evidence = new HeroEvidence();
    evidence.observeLoading(67, 0);
    evidence.confirmNewMatch(10);
    expect(evidence.observeLoading(64, 20)).toBe(0);
    expect(evidence.resolve(1, 1, false, 25).heroId).toBe(67);
    evidence.confirmNewMatch(30);
    expect(evidence.resolve(1, 76, false, 40).heroId).toBe(64);
    evidence.confirmNewMatch(50);
    expect(evidence.resolve(0, 76, false, 60)).toEqual({ heroId: 76, source: 'selected' });
  });
  it('keeps a sure same-match portrait through obstruction and expires stale loading text', () => {
    const evidence = new HeroEvidence();
    evidence.observeLoading(67, 0);
    evidence.confirmNewMatch(3_600_001);
    expect(evidence.resolve(64, 1, false, 3_600_002).heroId).toBe(64);
    expect(evidence.resolve(0, 1, false, 3_600_003)).toEqual({ heroId: 64, source: 'kept' });
  });
});
