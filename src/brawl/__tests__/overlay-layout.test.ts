import { describe, expect, it } from 'vitest';
import { drawReads, drawReading, type DrawnRect, type FrameRect, type OverlayTheme } from '../draw';
import { cardSquares, type CardRead } from '../recognise';
import { svgCtx } from '../../../scripts/lib/svgCtx';
import { BRAWL_WEIGHTS, baseScores, pairLifts, scoreOffer } from '../engine';
import { breakdownRows } from '../breakdown';
import { heroByName, inputFor, itemByName } from './testData';

const THEME: OverlayTheme = {
  panel: 'rgba(16,19,20,0.85)',
  teal: '#2ec4b6',
  tealInk: '#06201d',
  text: '#ece6da',
  muted: '#a39e92',
  grey: '#8a9092',
  veil: 'rgba(0,0,0,0.35)',
  dim: 0.6,
};
const FRAME = { w: 2560, h: 1440 };
const SIZES = [
  [1280, 720],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
] as const;

const reads = (enhanced: boolean): CardRead[] =>
  cardSquares(FRAME.w, FRAME.h).map((m, i) => ({
    card: ['left', 'top', 'right'][i]!,
    match: { itemId: i + 1, x: m.x, y: m.y, edge: m.edge, score: 1, margin: 1 },
    present: true,
    itemId: i + 1,
    tier: 1,
    rare: false,
    enhanced,
  }));
const hit = (a: FrameRect, b: FrameRect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

describe.each(SIZES)('overlay layout at %ix%i', (cw, ch) => {
  const sx = cw / FRAME.w;
  const sy = ch / FRAME.h;
  const scores = { 1: 3.21, 2: 4.56, 3: 2.1 };
  const grades = { 1: 'B', 2: 'S', 3: 'C' };
  for (const enhanced of [false, true]) {
    for (const reroll of [false, true]) {
      it(`plates stay apart, inside the canvas and clear of the Reading sign (enhanced ${enhanced}, reroll ${reroll})`, () => {
        const { ctx } = svgCtx(cw, ch);
        const drawn: DrawnRect[] = drawReads(
          ctx,
          reads(enhanced),
          reroll ? null : 2,
          sx,
          sy,
          FRAME.w,
          FRAME.h,
          reroll,
          scores,
          null,
          grades,
          THEME,
          { 1: 0.74, 2: 0.31, 3: 1.05 },
        );
        const plates = drawn.filter((d) => d.kind !== 'reroll').map((d) => d.plate!);
        expect(plates).toHaveLength(3);
        for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(hit(plates[i]!, plates[j]!)).toBe(false);
        if (enhanced) expect(drawn.filter((d) => d.kind !== 'reroll').every((d) => d.chip)).toBe(true);
        const { ctx: c2 } = svgCtx(cw, ch);
        const sign = drawReading(c2, cardSquares(FRAME.w, FRAME.h)[1]!, sx, sy, THEME);
        for (const p of plates) expect(hit(sign, p)).toBe(false);
        const inside = (r: FrameRect) => r.x0 >= 0 && r.y0 >= 0 && r.x1 <= FRAME.w && r.y1 <= FRAME.h;
        for (const r of [...plates, sign]) expect(inside(r)).toBe(true);
        const rr = drawn.find((d) => d.kind === 'reroll');
        if (reroll) expect(inside(rr!.plate!)).toBe(true);
        else expect(rr).toBeUndefined();
      });
    }
  }
  it('puts the Reading sign above the middle plate by at least 0.35 plate heights', () => {
    const { ctx } = svgCtx(cw, ch);
    const drawn = drawReads(
      ctx,
      reads(false),
      2,
      sx,
      sy,
      FRAME.w,
      FRAME.h,
      false,
      { 1: 1, 2: 2, 3: 3 },
      null,
      {},
      THEME,
    );
    const plate = drawn[1]!.plate!;
    const sign = drawReading(svgCtx(cw, ch).ctx, cardSquares(FRAME.w, FRAME.h)[1]!, sx, sy, THEME);
    const h = (plate.y1 - plate.y0) * sy;
    expect((plate.y0 - sign.y1) * sy).toBeGreaterThanOrEqual(Math.max(6, Math.round(h * 0.35)) - 1);
  });
});

describe('Enhanced cell number', () => {
  const infernus = inputFor(heroByName('Infernus').id);
  const bases = baseScores(infernus);
  const pair = pairLifts(infernus);
  const state = { round: 1, owned: [], enemies: [], sets: [] };
  for (const name of ['Improved Spirit', 'Extra Regen', 'Extra Charge']) {
    it(`equals score(enhanced) - score(plain) and the tooltip Enhanced row (${name})`, () => {
      const item = itemByName(name);
      const plain = scoreOffer(infernus, bases, pair, state, { itemId: item.id, enhanced: false });
      const enh = scoreOffer(infernus, bases, pair, state, { itemId: item.id, enhanced: true });
      expect(enh.enhancedBonus).toBeCloseTo(enh.score - plain.score, 10);
      expect(plain.enhancedBonus).toBe(0);
      expect(enh.enhancedBonus).toBeGreaterThanOrEqual(BRAWL_WEIGHTS.enhanced - 1e-9);
      const rows = breakdownRows(enh.parts, enh.score, enh.known, enh.enhancedBonus);
      const row = rows.find((r) => r.label === 'Enhanced')!;
      expect(row.cents / 100).toBeCloseTo(Math.round(enh.enhancedBonus * 100) / 100, 2);
      expect(rows.reduce((a, r) => a + r.cents, 0)).toBe(Math.round(enh.score * 100));
      // Hero fit is the not-enhanced fit
      const fit = rows.find((r) => r.label === 'Hero fit')?.cents ?? 0;
      const plainFit =
        breakdownRows(plain.parts, plain.score, plain.known).find((r) => r.label === 'Hero fit')?.cents ?? 0;
      expect(Math.abs(fit - plainFit)).toBeLessThanOrEqual(1);
    });
  }
});
