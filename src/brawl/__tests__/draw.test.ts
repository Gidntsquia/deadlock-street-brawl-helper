import { describe, expect, it, vi } from 'vitest';
import { drawReads, itemCircle, type OverlayTheme } from '../draw';
import type { CardRead } from '../recognise';

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
  it('outlines only the best card, as a circle, and veils the other card only', () => {
    const ctx = stubCtx();
    const drawn = run(ctx);
    expect(ctx.ellipse).toHaveBeenCalledTimes(2); // one veil, one outline
    expect(ctx.ellipseFills).toEqual([THEME.veil]);
    expect(drawn.map((d) => d.veiled)).toEqual([false, true]);
  });

  it('puts a plate above each card, centred on it, with the tier letter and "Score: <n>"', () => {
    const ctx = stubCtx();
    const drawn = run(ctx);
    expect(ctx.texts.map((t) => t.text)).toEqual(['S', 'Score: 3.14', 'B', 'Score: 2.50']);
    const { cx, cy, r } = itemCircle({ x: 10, y: 100, edge: 50 });
    const plate = drawn[0].plate!;
    expect((plate.x0 + plate.x1) / 2).toBeCloseTo(cx, 0);
    expect(plate.y1).toBeLessThanOrEqual(cy - r);
    expect(drawn.map((d) => d.score)).toEqual([3.14159, 2.5]);
  });

  it('fills the best plate teal with dark text and a 3 px outline; the other plate is grey, dimmed and has no teal', () => {
    const ctx = stubCtx();
    const drawn = run(ctx);
    expect(drawn.map((d) => d.kind)).toEqual(['best', 'card']);
    expect(ctx.strokes[0]).toEqual({ color: THEME.teal, width: 3 }); // card outline
    expect(ctx.strokes.slice(1)).toEqual([{ color: THEME.grey, width: 1 }]); // the other plate's border only
    expect(ctx.fills).toContain(THEME.teal);
    expect(ctx.texts[1].color).toBe(THEME.tealInk);
    expect(ctx.texts[3].color).toBe(THEME.muted);
    // everything drawn for the non-best plate (after the best plate's three fills) is at the dim opacity, no teal
    const i = ctx.fills.indexOf(THEME.veil) + 1;
    const rest = ctx.fills.slice(i + 2); // skip best plate + badge
    expect(rest).not.toContain(THEME.teal);
    expect(ctx.alphas.slice(i + 2).every((a) => a === THEME.dim)).toBe(true);
    expect(ctx.texts.filter((t) => t.color === THEME.teal || t.color === THEME.tealInk).length).toBe(2);
  });

  it('shows a ? card grey and veiled next to a best card', () => {
    const ctx = stubCtx();
    const unsure = { ...read(3, 400), unsure: true } as CardRead;
    const drawn = drawReads(ctx, [read(1, 10), unsure], 1, 1, 1, 2560, 1440, false, SCORES, null, GRADES, THEME);
    expect(drawn[1]).toMatchObject({ kind: 'unknown', veiled: true });
    expect(ctx.texts.map((t) => t.text)).toContain('?');
  });

  it('greys every plate and veils nothing when there is no best card and no re-roll', () => {
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
    expect(ctx.fills).not.toContain(THEME.teal);
  });

  it('adds an Enhanced cell only to enhanced cards, keeps the plate centred, and shows it on grey plates', () => {
    const ctx = stubCtx();
    const enh = { ...read(2, 700), enhanced: true };
    const drawn = drawReads(ctx, [read(1, 10), enh], 1, 1, 1, 2560, 1440, false, SCORES, null, GRADES, THEME, {
      1: 0,
      2: 0.7391,
    });
    expect(drawn[0].chip).toBeNull();
    expect(drawn[1].chip).not.toBeNull();
    expect(drawn[1].chipText).toBe('Enhanced: (+0.74)');
    const p = drawn[1].plate!;
    const { cx } = itemCircle({ x: 700, y: 100, edge: 50 });
    expect((p.x0 + p.x1) / 2).toBeCloseTo(cx, 0);
    expect(drawn[1].chip!.x1).toBeCloseTo(p.x1, 5);
    expect(drawn[1].veiled).toBe(true);
    const r = drawReads(stubCtx(), [enh], 1, 1, 1, 2560, 1440, true, SCORES, null, GRADES, THEME, { 2: 0.7391 });
    expect(r[0].chipText).toBe('Enhanced: (+0.74)');
  });

  it('shortens the cell to Enh when full cells would make neighbouring plates touch', () => {
    const a = { ...read(1, 10), enhanced: true };
    const b = { ...read(2, 280), enhanced: true };
    const drawn = drawReads(stubCtx(), [a, b], 1, 1, 1, 2560, 1440, false, SCORES, null, GRADES, THEME, {
      1: 0.5,
      2: 0.5,
    });
    expect(drawn[0].chipText).toMatch(/^Enh: \(\+/);
    expect(drawn[0].plate!.x1).toBeLessThan(drawn[1].plate!.x0);
  });

  it('keeps the score text at least 14 px tall', () => {
    const ctx = stubCtx();
    ctx.font = '';
    drawReads(ctx, [read(1, 10)], 1, 0.1, 0.1, 2560, 1440, false, SCORES, null, GRADES, THEME);
    expect(ctx.font).toMatch(/^bold (\d+)px/);
    expect(Number(/(\d+)px/.exec(ctx.font)![1])).toBeGreaterThanOrEqual(14);
  });

  it('on a re-roll call: no best, every card veiled and grey, a teal plate of card-plate height and a 4 px outline', () => {
    const ctx = stubCtx();
    const drawn = run(ctx, true);
    expect(drawn.filter((d) => d.kind === 'best')).toHaveLength(0);
    expect(drawn.filter((d) => d.kind !== 'reroll').every((d) => d.veiled)).toBe(true);
    expect(ctx.strokes.filter((s) => s.width === 4)).toEqual([{ color: THEME.teal, width: 4 }]);
    expect(ctx.strokes.filter((s) => s.color === THEME.teal)).toHaveLength(1);
    expect(ctx.texts.filter((t) => t.text === 'RE-ROLL')).toEqual([{ text: 'RE-ROLL', color: THEME.tealInk }]);
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
