import { describe, expect, it } from 'vitest';
import { analyseDraft, type StatFrame } from '../sessionStats';

const f = (t: number, o: Partial<StatFrame> = {}): StatFrame => ({
  t,
  shop: true,
  live: false,
  accepted: false,
  picked: false,
  spent: false,
  round: 1,
  choice: 1,
  items: [1, 2, 3],
  unsure: 0,
  tiers: [1, 1, 1],
  ...o,
});

describe('analyseDraft', () => {
  it('measures time to advice and finds a steady set clean', () => {
    const s = analyseDraft([f(0), f(300), f(800, { accepted: true, live: true }), f(900, { live: true })]);
    expect(s).toMatchObject({ adviceMs: 800, changes: 0, dropouts: 0, fallback: false, items: [1, 2, 3] });
  });
  it('counts a change within a set and a drop-out', () => {
    const live = { live: true };
    const s = analyseDraft([
      f(0),
      f(500, { accepted: true, live: true }),
      f(600, { ...live, tiers: [2, 1, 1] }),
      f(700, { live: false, items: [1, 0, 3], unsure: 0 }),
    ]);
    expect(s.changes).toBe(1);
    expect(s.dropouts).toBe(1);
  });
  it('does not count a pick or a new label as a drop-out', () => {
    expect(analyseDraft([f(0, { accepted: true, live: true }), f(100, { live: false, picked: true })]).dropouts).toBe(
      0,
    );
    expect(analyseDraft([f(0, { accepted: true, live: true }), f(100, { live: false, choice: 2 })]).dropouts).toBe(0);
  });
  it('flags a fallback and lets a question mark turn real once', () => {
    const s = analyseDraft([
      f(0),
      f(2500, { accepted: true, live: true, items: [1, 0, 3], unsure: 1 }),
      f(2600, { live: true, items: [1, 2, 3], unsure: 0 }),
    ]);
    expect(s.fallback).toBe(true);
    expect(s.unsure).toBe(1);
    expect(s.changes).toBe(0);
  });
});
