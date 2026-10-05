import { describe, expect, it } from 'vitest';
import type { CardRead } from '../recognise';
import { emptyStable, HOLD_FRAMES, stabilise } from '../stabilise';

const card = (x: number, present = true, id = 7): CardRead => ({
  card: 'left',
  match: { itemId: id, score: 0.9, margin: 0.2, x, y: 100, edge: 100 },
  present,
  itemId: present ? id : 0,
  tier: 1,
  rare: false,
  enhanced: false,
});

describe('stabilise', () => {
  it('ignores small wobble and follows a real move once two frames agree', () => {
    let s = stabilise(emptyStable(), [card(500)]);
    s = stabilise(s, [card(503)]);
    expect(s.reads[0]!.match.x).toBe(500);
    s = stabilise(s, [card(600)]);
    expect(s.reads[0]!.match.x).toBe(500);
    s = stabilise(s, [card(601)]);
    expect(s.reads[0]!.match.x).toBe(601);
  });
  it('a matcher flipping between two positions never moves the circle', () => {
    let s = stabilise(emptyStable(), [card(500)]);
    for (let i = 0; i < 10; i++) {
      s = stabilise(s, [card(i % 2 ? 500 : 520)]);
      expect(s.reads[0]!.match.x).toBe(500);
    }
  });
  it('with hold set, keeps a hidden card for as long as the hover lasts', () => {
    let s = stabilise(emptyStable(), [card(500)]);
    for (let i = 0; i < HOLD_FRAMES * 4; i++) s = stabilise(s, [card(0, false)], true);
    expect(s.reads[0]!.present).toBe(true);
  });
  it('holds a card through a short miss, then drops it', () => {
    let s = stabilise(emptyStable(), [card(500)]);
    for (let i = 0; i < HOLD_FRAMES; i++) {
      s = stabilise(s, [card(0, false)]);
      expect(s.reads[0]!.present).toBe(true);
    }
    s = stabilise(s, [card(0, false)]);
    expect(s.reads[0]!.present).toBe(false);
  });
  it('adopts a different item at once', () => {
    let s = stabilise(emptyStable(), [card(500)]);
    s = stabilise(s, [card(500, true, 9)]);
    expect(s.reads[0]!.itemId).toBe(9);
  });
});
