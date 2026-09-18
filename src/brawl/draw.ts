import type { CardRead } from './recognise';
import { rerollButtonRect } from './recognise';

export interface OverlayAdviceCard {
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
  abilityLine: string;
  status: string;
}

export interface OverlayState {
  reads: CardRead[];
  bestId: number | null;
  reroll: boolean;
  frameW: number;
  frameH: number;
  advice: OverlayAdvice | null;
}

/** One box `drawReads` actually stroked, in capture-frame px (unscaled by scaleX/scaleY) — so a caller that
 *  knows the canvas's own scale relative to the frame can turn these back into canvas px, and something that
 *  only has frame-px labels (e.g. the e2e harness comparing against `scripts/win/frames/labels.json`) can
 *  compare directly without redoing the scale math. */
export interface DrawnRect {
  kind: 'card' | 'best' | 'reroll';
  card: string | null; // read.card ("left"/"top"/"right") for card/best, null for reroll
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Draws the highlight boxes for the current card reads, scaled from capture-frame pixels to the target
 *  canvas size. Shared by the preview canvas (BrawlView) and the Electron overlay window. When `reroll`
 *  is true, no card is boxed as best (the engine says re-roll, not take): the "Use Re-Roll" button is
 *  boxed instead, at its position in the `frameW`x`frameH` capture frame, so the box on the game always
 *  matches the advice. Returns every box actually stroked, in frame px, for callers (e.g. the e2e harness)
 *  that need to verify what was drawn without re-deriving it from the reads. */
export function drawReads(
  ctx: CanvasRenderingContext2D,
  reads: CardRead[],
  bestId: number | null,
  scaleX: number,
  scaleY: number,
  frameW: number,
  frameH: number,
  reroll = false,
): DrawnRect[] {
  const drawn: DrawnRect[] = [];
  for (const read of reads) {
    if (!read.present) continue;
    const isBest = !reroll && read.itemId === bestId;
    const { x, y, edge } = read.match;
    ctx.lineWidth = isBest ? 4 : 2;
    ctx.strokeStyle = isBest ? '#39ff6a' : 'rgba(255,255,255,.4)';
    ctx.strokeRect(x * scaleX, y * scaleY, edge * scaleX, edge * scaleY);
    if (isBest) {
      ctx.fillStyle = '#39ff6a';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('TAKE', x * scaleX, Math.max(12, y * scaleY - 6));
    }
    drawn.push({ kind: isBest ? 'best' : 'card', card: read.card, x0: x, y0: y, x1: x + edge, y1: y + edge });
  }
  if (reroll) {
    const rect = rerollButtonRect(frameW, frameH);
    const x0 = rect.x0 * scaleX,
      y0 = rect.y0 * scaleY,
      x1 = rect.x1 * scaleX,
      y1 = rect.y1 * scaleY;
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ffb020';
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = '#ffb020';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('RE-ROLL', x0, Math.max(12, y0 - 6));
    drawn.push({ kind: 'reroll', card: null, x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 });
  }
  return drawn;
}
