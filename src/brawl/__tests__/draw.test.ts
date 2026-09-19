import { describe, expect, it, vi } from 'vitest';
import { COLOR_BEST, COLOR_OTHER, drawReads, itemCircle } from '../draw';
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
  const ctx = {
    strokeRect: vi.fn(),
    ellipse: vi.fn(),
    beginPath: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    lineWidth: 0,
    strokeStyle: '' as string,
    fillStyle: '' as string,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    // colour in force at each stroke()/fillText() call
    strokes: [] as string[],
    fills: [] as string[],
  };
  ctx.stroke.mockImplementation(() => ctx.strokes.push(ctx.strokeStyle));
  ctx.fillText.mockImplementation(() => ctx.fills.push(ctx.fillStyle));
  return ctx as typeof ctx & CanvasRenderingContext2D;
}

const SCORES = { 1: 3.14159, 2: 2.5 };

describe('drawReads', () => {
  it('outlines each card around its large circle, not the icon square', () => {
    const ctx = stubCtx();
    const drawn = drawReads(ctx, [read(1, 10), read(2, 200)], 1, 1, 1, 2560, 1440, false, SCORES);
    expect(ctx.ellipse).toHaveBeenCalledTimes(2);
    expect(ctx.strokeRect).not.toHaveBeenCalled();
    const { cx, cy, r } = itemCircle({ x: 10, y: 100, edge: 50 });
    expect(ctx.ellipse.mock.calls[0].slice(0, 4)).toEqual([cx, cy, r, r]);
    expect(drawn[0]).toMatchObject({ x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r });
    // the circle is much larger than the 50px icon
    expect(drawn[0].x1 - drawn[0].x0).toBeGreaterThan(2 * 50);
  });

  it('draws each card score above its circle', () => {
    const ctx = stubCtx();
    const drawn = drawReads(ctx, [read(1, 10), read(2, 200)], 1, 1, 1, 2560, 1440, false, SCORES);
    const texts = ctx.fillText.mock.calls.map((c) => c[0]);
    expect(texts).toEqual(['3.14', '2.50']);
    const { cx, cy, r } = itemCircle({ x: 10, y: 100, edge: 50 });
    const [, tx, ty] = ctx.fillText.mock.calls[0];
    expect(tx).toBe(cx);
    expect(ty).toBeLessThan(cy - r + 1);
    expect(drawn.map((d) => d.score)).toEqual([3.14159, 2.5]);
  });

  it('draws the best card white and the others grey', () => {
    const ctx = stubCtx();
    const drawn = drawReads(ctx, [read(1, 10), read(2, 200)], 1, 1, 1, 2560, 1440, false, SCORES);
    expect(ctx.strokes).toEqual([COLOR_BEST, COLOR_OTHER]);
    expect(ctx.fills).toEqual([COLOR_BEST, COLOR_OTHER]);
    expect(drawn.map((d) => d.kind)).toEqual(['best', 'card']);
  });

  it('draws no white card and boxes the re-roll button when reroll is true', () => {
    const ctx = stubCtx();
    const drawn = drawReads(ctx, [read(1, 10), read(2, 200)], 1, 1, 1, 2560, 1440, true, SCORES);
    expect(ctx.strokes.filter((c) => c === COLOR_BEST)).toHaveLength(0);
    expect(ctx.fills.filter((c) => c === COLOR_BEST)).toHaveLength(0);
    expect(drawn.filter((d) => d.kind === 'best')).toHaveLength(0);
    expect(ctx.fillText.mock.calls.filter((c) => c[0] === 'RE-ROLL')).toHaveLength(1);
    const rerollRect = ctx.strokeRect.mock.calls.find(([x0, y0]) => x0 === REROLL_BUTTON.x0 && y0 === REROLL_BUTTON.y0);
    expect(rerollRect).toBeDefined();
    expect(drawn.find((d) => d.kind === 'reroll')).toEqual({
      kind: 'reroll',
      card: null,
      x0: REROLL_BUTTON.x0,
      y0: REROLL_BUTTON.y0,
      x1: REROLL_BUTTON.x1,
      y1: REROLL_BUTTON.y1,
      score: null,
    });
  });

  it('scales the circle to the canvas', () => {
    const ctx = stubCtx();
    drawReads(ctx, [read(1, 10)], 1, 2, 3, 2560, 1440, false, SCORES);
    const { cx, cy, r } = itemCircle({ x: 10, y: 100, edge: 50 });
    expect(ctx.ellipse.mock.calls[0].slice(0, 4)).toEqual([cx * 2, cy * 3, r * 2, r * 3]);
  });
});
