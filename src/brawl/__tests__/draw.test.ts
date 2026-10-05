import { describe, expect, it, vi } from 'vitest';
import { drawReads, itemCircle, type OverlayTheme } from '../draw';
import type { CardRead } from '../recognise';
import { cardSlotSelection } from '../../local/cardSlotSelection';

const read = (itemId: number, x: number): CardRead => ({
  card: 'x',
  match: { itemId, x, y: 100, edge: 50, score: 1, margin: 0.5 },
  present: true,
  itemId,
  tier: 1,
  rare: false,
  enhanced: false,
});

const THEME: OverlayTheme = {
  panel: '#101314',
  teal: '#2ec4b6',
  tealInk: '#06201d',
  text: '#ece6da',
  muted: '#a39e92',
  take: '#52e38b',
  takeInk: '#092416',
  reroll: '#f3c969',
  grey: '#8a9092',
  veil: 'rgba(0,0,0,0.35)',
  dim: 0.6,
};

function stubCtx() {
  const ctx = {
    rect: vi.fn(),
    roundRect: vi.fn(),
    ellipse: vi.fn(),
    beginPath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    globalAlpha: 1,
    lastEllipse: false,
    measureText: vi.fn((t: string) => ({ width: t.length * 10 })),
    lineWidth: 0,
    strokeStyle: '' as string,
    fillStyle: '' as string,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    strokes: [] as { color: string; width: number }[],
    fills: [] as string[],
    alphas: [] as number[],
    ellipseFills: [] as string[],
    texts: [] as { text: string; color: string }[],
  };
  ctx.stroke.mockImplementation(() => ctx.strokes.push({ color: ctx.strokeStyle, width: ctx.lineWidth }));
  ctx.fill.mockImplementation(() => {
    ctx.fills.push(ctx.fillStyle);
    ctx.alphas.push(ctx.globalAlpha);
    if (ctx.lastEllipse) ctx.ellipseFills.push(ctx.fillStyle);
  });
  ctx.beginPath.mockImplementation(() => (ctx.lastEllipse = false));
  ctx.ellipse.mockImplementation(() => (ctx.lastEllipse = true));
  ctx.fillText.mockImplementation((text: string) => ctx.texts.push({ text, color: ctx.fillStyle }));
  return ctx as typeof ctx & CanvasRenderingContext2D;
}

const SCORES = { 1: 3.14159, 2: 2.5 };
const GRADES = { 1: 'S', 2: 'B' };
const run = (ctx: CanvasRenderingContext2D, reroll = false, sx = 1, sy = 1) =>
  drawReads(ctx, [read(1, 10), read(2, 200)], 1, sx, sy, 2560, 1440, reroll, SCORES, null, GRADES, THEME);

describe('drawReads', () => {
  it('draws at most one TAKE for duplicated IDs with legacy item-ID-only callers', () => {
    const ctx = stubCtx();
    const drawn = drawReads(ctx, [read(1, 10), read(1, 200)], 1, 1, 1, 2560, 1440, false, SCORES, null, GRADES, THEME);
    expect(drawn.map((rect) => rect.kind)).toEqual(['best', 'card']);
    expect(drawn.map((rect) => rect.readIndex)).toEqual([0, 1]);
    expect(ctx.ellipse).toHaveBeenCalledTimes(1);
    expect(ctx.texts.filter((text) => text.text === 'TAKE')).toHaveLength(1);
  });

  it('draws each duplicate variant score and tier on its own plate and recommends only the stronger enhanced slot', () => {
    const ctx = stubCtx();
    const reads = [
      { ...read(1, 10), card: 'left' },
      { ...read(1, 200), card: 'right', enhanced: true },
    ];
    const card = {
      itemId: 1,
      name: 'Item',
      enhanced: false,
      score: 2,
      grade: 'B',
      usage: 0,
      winRate: null,
      enhancedBonus: 0,
      rows: [],
    };
    const advice = {
      hero: 'Graves',
      round: 4,
      choice: 3,
      reroll: null,
      status: 'Ready',
      ranked: [{ ...card, enhanced: true, score: 5, grade: 'S', enhancedBonus: 3 }, card],
    };
    const slots = cardSlotSelection(reads, 1, advice);
    const drawn = drawReads(ctx, reads, 1, 1, 1, 2560, 1440, false, SCORES, null, GRADES, THEME, slots);
    expect(drawn.map((rect) => [rect.kind, rect.score])).toEqual([
      ['card', 2],
      ['best', 5],
    ]);
    expect(ctx.texts.map((text) => text.text)).toEqual(['B', 'Score: 2.00', 'S', 'Score: 5.00', 'TAKE', 'Enh +3.00']);
    expect(ctx.ellipse).toHaveBeenCalledTimes(1);
    const rerolled = drawReads(ctx, reads, 1, 1, 1, 2560, 1440, true, SCORES, null, GRADES, THEME, slots);
    expect(rerolled.filter((rect) => rect.kind === 'best')).toHaveLength(0);
    expect(rerolled.filter((rect) => rect.kind === 'reroll')).toHaveLength(1);
  });

  it('outlines only the best card, as a circle, and leaves other cards unobscured', () => {
    const ctx = stubCtx();
    const drawn = run(ctx);
    expect(ctx.ellipse).toHaveBeenCalledTimes(1); // one veil, one outline
    expect(ctx.ellipseFills).toEqual([]);
    expect(drawn.map((d) => d.veiled)).toEqual([false, false]);
  });

  it('puts a plate above each card, centred on it, with the tier letter and "Score: <n>"', () => {
    const ctx = stubCtx();
    const drawn = run(ctx);
    expect(ctx.texts.map((t) => t.text)).toEqual(['S', 'Score: 3.14', 'TAKE', 'B', 'Score: 2.50']);
    const { cx, cy, r } = itemCircle({ x: 10, y: 100, edge: 50 });
    const plate = drawn[0].plate!;
    expect((plate.x0 + plate.x1) / 2).toBeCloseTo(cx, 0);
    expect(plate.y1).toBeLessThanOrEqual(cy - r);
    expect(drawn.map((d) => d.score)).toEqual([3.14159, 2.5]);
  });

  it('fills the best plate green with TAKE; other plates keep a thin teal border and their scores', () => {
    const ctx = stubCtx();
    const drawn = run(ctx);
    expect(drawn.map((d) => d.kind)).toEqual(['best', 'card']);
    expect(ctx.strokes[0]).toEqual({ color: THEME.take, width: 3 }); // card outline
    expect(ctx.strokes.slice(1)).toEqual([{ color: THEME.teal, width: 1 }]); // the other plate's border only
    expect(ctx.fills).toContain(THEME.take);
    expect(ctx.texts[1].color).toBe(THEME.takeInk);
    expect(ctx.texts[2]).toEqual({ text: 'TAKE', color: THEME.takeInk });
    expect(ctx.texts[4].color).toBe(THEME.muted);
    expect(ctx.fills).not.toContain(THEME.veil);
    expect(ctx.alphas.every((a) => a === 1)).toBe(true);
  });

  it('shows a ? card without inventing its item identity', () => {
    const ctx = stubCtx();
    const unsure = { ...read(3, 400), unsure: true } as CardRead;
    const drawn = drawReads(ctx, [read(1, 10), unsure], 1, 1, 1, 2560, 1440, false, SCORES, null, GRADES, THEME);
    expect(drawn[1]).toMatchObject({ kind: 'unknown', itemId: null, veiled: false });
    expect(ctx.texts.map((t) => t.text)).toContain('?');
  });

  it('keeps every plate neutral and unobscured when there is no best card and no re-roll', () => {
    const ctx = stubCtx();
    const drawn = drawReads(
      ctx,
      [read(1, 10), read(2, 200)],
      null,
      1,
      1,
      2560,
      1440,
      false,
      SCORES,
      null,
      GRADES,
      THEME,
    );
    expect(drawn.map((d) => d.veiled)).toEqual([false, false]);
    expect(ctx.fills).not.toContain(THEME.take);
  });

  it('adds an Enhanced cell only to enhanced cards, keeps the plate centred, and shows it on neutral plates', () => {
    const ctx = stubCtx();
    const enh = { ...read(2, 700), enhanced: true };
    const drawn = drawReads(ctx, [read(1, 10), enh], 1, 1, 1, 2560, 1440, false, SCORES, null, GRADES, THEME, {
      1: 0,
      2: 0.7391,
    });
    expect(drawn[0].chip).toBeNull();
    expect(drawn[1].chip).not.toBeNull();
    expect(drawn[1].chipText).toBe('Enhanced +0.74');
    const p = drawn[1].plate!;
    const { cx } = itemCircle({ x: 700, y: 100, edge: 50 });
    expect((p.x0 + p.x1) / 2).toBeCloseTo(cx, 0);
    expect(drawn[1].chip!.x1).toBeCloseTo(p.x1, 5);
    expect(drawn[1].veiled).toBe(false);
    const r = drawReads(stubCtx(), [enh], 1, 1, 1, 2560, 1440, true, SCORES, null, GRADES, THEME, { 2: 0.7391 });
    expect(r[0].chipText).toBe('Enhanced +0.74');
  });

  it('shortens the cell to Enh when full cells would make neighbouring plates touch', () => {
    const a = { ...read(1, 10), enhanced: true };
    const b = { ...read(2, 310), enhanced: true };
    const drawn = drawReads(stubCtx(), [a, b], 1, 1, 1, 2560, 1440, false, SCORES, null, GRADES, THEME, {
      1: 0.5,
      2: 0.5,
    });
    expect(drawn[0].chipText).toMatch(/^Enh \+/);
    expect(drawn[0].plate!.x1).toBeLessThan(drawn[1].plate!.x0);
  });

  it('keeps the score text at least 14 px tall', () => {
    const ctx = stubCtx();
    ctx.font = '';
    drawReads(ctx, [read(1, 10)], 1, 0.1, 0.1, 2560, 1440, false, SCORES, null, GRADES, THEME);
    expect(ctx.font).toMatch(/^bold (\d+)px/);
    expect(Number(/(\d+)px/.exec(ctx.font)![1])).toBeGreaterThanOrEqual(14);
  });

  it('on a re-roll call: no best, every card unobscured and neutral, an amber plate of card-plate height and a 4 px outline', () => {
    const ctx = stubCtx();
    const drawn = run(ctx, true);
    expect(drawn.filter((d) => d.kind === 'best')).toHaveLength(0);
    expect(drawn.filter((d) => d.kind !== 'reroll').every((d) => !d.veiled)).toBe(true);
    expect(ctx.strokes.filter((s) => s.width === 4)).toEqual([{ color: THEME.reroll, width: 4 }]);
    expect(ctx.strokes.filter((s) => s.color === THEME.reroll)).toHaveLength(1);
    expect(ctx.texts.filter((t) => t.text === 'TAKE')).toHaveLength(0);
    expect(ctx.texts.filter((t) => t.text === 'RE-ROLL')).toEqual([{ text: 'RE-ROLL', color: THEME.takeInk }]);
    const rr = drawn.find((d) => d.kind === 'reroll')!;
    const card = drawn[0].plate!;
    expect(rr.plate!.y1 - rr.plate!.y0).toBe(card.y1 - card.y0);
    expect(rr.plate!.y1).toBeLessThanOrEqual(rr.y0);
  });

  it('scales plates with the canvas', () => {
    const a = run(stubCtx(), false, 1, 1);
    const b = run(stubCtx(), false, 2, 2);
    const wa = a[0].plate!.x1 - a[0].plate!.x0;
    const wb = b[0].plate!.x1 - b[0].plate!.x0;
    expect(wb / wa).toBeCloseTo(1, 0); // frame px stay put; canvas px double
  });
});
