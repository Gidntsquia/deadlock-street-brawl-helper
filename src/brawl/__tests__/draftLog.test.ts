import { describe, expect, it } from 'vitest';
import { DraftLog } from '../draftLog';
import type { StatFrame } from '../sessionStats';

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

describe('DraftLog', () => {
  it('keeps a first full frame and a few light ones, then the frame after accept', () => {
    const log = new DraftLog();
    const got: string[] = [];
    for (let t = 0; t <= 2000; t += 100) {
      const s = log.wantFrame(t);
      if (s) got.push(`${t}:${s}`);
      if (t === 800) log.push(f(t, { accepted: true, live: true }), '1,2,3', t);
      else log.push(f(t, { live: t > 800 }), '1,2,3', t);
    }
    expect(got[0]).toBe('0:full');
    expect(got.slice(1).every((g) => g.endsWith('light'))).toBe(true);
    expect(got.some((g) => g.startsWith('900:'))).toBe(true); // right after accept
    expect(got.length).toBeLessThanOrEqual(10);
  });

  it('ends the draft at the pick and reports its stats', () => {
    const log = new DraftLog();
    log.wantFrame(0);
    expect(log.push(f(0), '', 0)).toBeNull();
    expect(log.push(f(600, { accepted: true, live: true }), '1,2,3', 600)).toBeNull();
    const end = log.push(f(1500, { picked: true }), '1,2,3', 1500)!;
    expect(end).toMatchObject({ round: 1, choice: 1 });
    expect(end.stats.adviceMs).toBe(600);
  });

  it('ends a draft that never got plates only if it was up a while', () => {
    const a = new DraftLog();
    a.push(f(0), '', 0);
    a.push(f(200), '', 200);
    expect(a.push(f(300, { shop: false }), '', 300)).toBeNull();
    const b = new DraftLog();
    for (let t = 0; t <= 1500; t += 100) b.push(f(t), '', t);
    const end = b.push(f(1600, { shop: false }), '', 1600)!;
    expect(end.stats.adviceMs).toBeNull();
  });

  it('splits at a second accepted set (a re-roll)', () => {
    const log = new DraftLog();
    log.push(f(0, { accepted: true, live: true }), '1,2,3', 0);
    const end = log.push(f(900, { accepted: true, live: true, items: [4, 5, 6] }), '4,5,6', 900);
    expect(end).not.toBeNull();
  });
});
