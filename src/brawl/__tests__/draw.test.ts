import { describe, expect, it, vi } from 'vitest';
import { drawReads } from '../draw';
import type { CardRead } from '../recognise';
import { REROLL_BUTTON } from '../recognise';

const read = (itemId: number, x: number): CardRead => ({
  card: 'x',
  match: { itemId, x, y: 100, edge: 50, score: 1, margin: 0.5 },
  present: true,
  itemId,
  tier: 1,
  rare: false,
  enhanced: false,
});

function stubCtx() {
  return {
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    font: '',
  } as unknown as CanvasRenderingContext2D & {
    strokeRect: ReturnType<typeof vi.fn>;
    fillText: ReturnType<typeof vi.fn>;
  };
}

describe('drawReads', () => {
  it('boxes the best card and labels it TAKE when reroll is false', () => {
    const ctx = stubCtx();
    const reads = [read(1, 10), read(2, 200)];
    drawReads(ctx, reads, 1, 1, 1, 2560, 1440, false);
    expect(ctx.strokeRect).toHaveBeenCalledTimes(2);
    const takeCalls = ctx.fillText.mock.calls.filter((c) => c[0] === 'TAKE');
    expect(takeCalls.length).toBe(1);
    const rerollCalls = ctx.fillText.mock.calls.filter((c) => c[0] === 'RE-ROLL');
    expect(rerollCalls.length).toBe(0);
  });

  it('boxes the re-roll button and skips TAKE when reroll is true', () => {
    const ctx = stubCtx();
    const reads = [read(1, 10), read(2, 200)];
    drawReads(ctx, reads, 1, 1, 1, 2560, 1440, true);
    const takeCalls = ctx.fillText.mock.calls.filter((c) => c[0] === 'TAKE');
    expect(takeCalls.length).toBe(0);
    const rerollCalls = ctx.fillText.mock.calls.filter((c) => c[0] === 'RE-ROLL');
    expect(rerollCalls.length).toBe(1);
    const rerollRect = ctx.strokeRect.mock.calls.find(([x0, y0]) => x0 === REROLL_BUTTON.x0 && y0 === REROLL_BUTTON.y0);
    expect(rerollRect).toBeDefined();
  });

  it('returns the drawn rects in frame px, tagged best/card/reroll', () => {
    const ctx = stubCtx();
    const reads = [read(1, 10), read(2, 200)];
    const drawn = drawReads(ctx, reads, 1, 2, 2, 2560, 1440, false);
    expect(drawn).toEqual([
      { kind: 'best', card: 'x', x0: 10, y0: 100, x1: 60, y1: 150 },
      { kind: 'card', card: 'x', x0: 200, y0: 100, x1: 250, y1: 150 },
    ]);
  });

  it('includes a reroll rect at REROLL_BUTTON when reroll is true, no card marked best', () => {
    const ctx = stubCtx();
    const reads = [read(1, 10), read(2, 200)];
    const drawn = drawReads(ctx, reads, 1, 1, 1, 2560, 1440, true);
    expect(drawn.filter((d) => d.kind === 'best')).toHaveLength(0);
    expect(drawn.find((d) => d.kind === 'reroll')).toEqual({
      kind: 'reroll',
      card: null,
      x0: REROLL_BUTTON.x0,
      y0: REROLL_BUTTON.y0,
      x1: REROLL_BUTTON.x1,
      y1: REROLL_BUTTON.y1,
    });
  });
});
