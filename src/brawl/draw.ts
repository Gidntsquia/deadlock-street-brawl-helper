import type { CardRead } from './recognise';
import { rerollButtonRect } from './recognise';
import type { AbilityPanelData } from './abilities';

export interface OverlayAdviceCard {
  itemId: number;
  name: string;
  score: number;
  enhanced: boolean;
  usage: number;
  winRate: number | null;
}

/** Everything the overlay panel needs to render the same advice as the pop-out, without alt-tabbing:
 *  names not ids, since the overlay window has no access to the item/ability catalog. */
export interface OverlayAdvice {
  hero: string;
  round: number;
  choice: number;
  reroll: { expectedBest: number; currentBest: number } | null;
  ranked: OverlayAdviceCard[];
  status: string;
}

/** Everything the overlay may draw. It draws nothing at all unless `draft` (the item draft screen is on the
 *  frame) or `panel` (the ability panel window is running); see `overlayHasContent`. */
export interface OverlayState {
  reads: CardRead[];
  bestId: number | null;
  reroll: boolean;
  frameW: number;
  frameH: number;
  advice: OverlayAdvice | null;
  draft: boolean;
  panel: AbilityPanelData | null;
  /** The "Use Re-Roll" pill's outline found on the frame (frame px); absent: the nominal layout rect. */
  rerollRect?: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** The blank state: nothing to draw. */
export const BLANK_OVERLAY: OverlayState = {
  reads: [],
  bestId: null,
  reroll: false,
  frameW: 0,
  frameH: 0,
  advice: null,
  draft: false,
  panel: null,
};

export { overlayHasContent } from './overlayContent';

/** One shape `drawReads` actually stroked, in capture-frame px (unscaled by scaleX/scaleY) — so a caller that
 *  knows the canvas's own scale relative to the frame can turn these back into canvas px, and something that
 *  only has frame-px labels (e.g. the e2e harness comparing against `scripts/win/frames/labels.json`) can
 *  compare directly without redoing the scale math. For cards the rect is the bounding box of the large
 *  circle the item sits in; `score` is the number drawn above it (null for the re-roll box). */
export interface DrawnRect {
  kind: 'card' | 'best' | 'reroll';
  card: string | null; // read.card ("left"/"top"/"right") for card/best, null for reroll
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number | null;
}

// The large circle an item sits in, relative to the small icon square the recogniser matches: measured on
// the 2000x1125 reference frames (icon edge ~137px, circle diameter ~352px, circle centre ~37px below the
// icon's centre), so everything scales with the matched icon edge.
const CIRCLE_RADIUS_PER_EDGE = 1.285;
const CIRCLE_CENTRE_DROP_PER_EDGE = 0.27;

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

/** The circle around an item, in the same px space as `match` (frame px). */
export function itemCircle(match: { x: number; y: number; edge: number }): Circle {
  return {
    cx: match.x + match.edge / 2,
    cy: match.y + match.edge / 2 + match.edge * CIRCLE_CENTRE_DROP_PER_EDGE,
    r: match.edge * CIRCLE_RADIUS_PER_EDGE,
  };
}

/** Circle of the item to take. */
export const COLOR_BEST_CIRCLE = '#22e055';
/** Score text of the item to take. */
export const COLOR_BEST_TEXT = '#ffffff';
export const COLOR_OTHER = 'rgba(170,170,170,.85)';
const COLOR_REROLL = '#ffb020';

/** Draws the item circles, scores and (on RE-ROLL) the re-roll box for the current card reads, scaled from
 *  capture-frame pixels to the target canvas size. Shared by the preview canvas (BrawlView) and the Electron
 *  overlay window. Each present card gets an outline around its large circle with `Score: <n>` above it; the
 *  best card has a green circle and white score text, the rest are grey. When `reroll` is true, no card is green (the engine says re-roll, not
 *  take): the "Use Re-Roll" button is boxed instead. `scores` maps itemId to the score the advice panel shows.
 *  Returns every shape actually stroked, in frame px, for callers (e.g. the e2e harness) that need to verify
 *  what was drawn without re-deriving it from the reads. */
export function drawReads(
  ctx: CanvasRenderingContext2D,
  reads: CardRead[],
  bestId: number | null,
  scaleX: number,
  scaleY: number,
  frameW: number,
  frameH: number,
  reroll = false,
  scores: Record<number, number> = {},
  rerollRect: { x0: number; y0: number; x1: number; y1: number } | null = null,
): DrawnRect[] {
  const drawn: DrawnRect[] = [];
  for (const read of reads) {
    if (!read.present) continue;
    const isBest = !reroll && read.itemId === bestId;
    const { cx, cy, r } = itemCircle(read.match);
    ctx.lineWidth = isBest ? 5 : 3;
    ctx.strokeStyle = isBest ? COLOR_BEST_CIRCLE : COLOR_OTHER;
    ctx.beginPath();
    ctx.ellipse(cx * scaleX, cy * scaleY, r * scaleX, r * scaleY, 0, 0, Math.PI * 2);
    ctx.stroke();
    const score = scores[read.itemId];
    if (score !== undefined) {
      ctx.fillStyle = isBest ? COLOR_BEST_TEXT : COLOR_OTHER;
      ctx.font = `bold ${Math.max(12, Math.round(read.match.edge * 0.26 * scaleY))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`Score: ${score.toFixed(2)}`, cx * scaleX, Math.max(14, (cy - r) * scaleY - 6));
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
    drawn.push({
      kind: isBest ? 'best' : 'card',
      card: read.card,
      x0: cx - r,
      y0: cy - r,
      x1: cx + r,
      y1: cy + r,
      score: score ?? null,
    });
  }
  if (reroll) {
    const rect = rerollRect ?? rerollButtonRect(frameW, frameH);
    const x0 = rect.x0 * scaleX,
      y0 = rect.y0 * scaleY,
      x1 = rect.x1 * scaleX,
      y1 = rect.y1 * scaleY;
    ctx.lineWidth = 4;
    ctx.strokeStyle = COLOR_REROLL;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = COLOR_REROLL;
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('RE-ROLL', x0, Math.max(12, y0 - 6));
    drawn.push({ kind: 'reroll', card: null, x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1, score: null });
  }
  return drawn;
}

/** itemId -> score map from the advice ranking, so drawn scores are exactly the panel's numbers. */
export function scoresFromAdvice(advice: OverlayAdvice | null): Record<number, number> {
  const out: Record<number, number> = {};
  for (const r of advice?.ranked ?? []) out[r.itemId] = r.score;
  return out;
}
