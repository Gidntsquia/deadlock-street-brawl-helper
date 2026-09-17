import type { CardRead } from './recognise';

export interface OverlayState {
  reads: CardRead[];
  bestId: number | null;
  frameW: number;
  frameH: number;
}

/** Draws the highlight boxes for the current card reads, scaled from capture-frame pixels to the target
 *  canvas size. Shared by the preview canvas (BrawlView) and the Electron overlay window. */
export function drawReads(
  ctx: CanvasRenderingContext2D,
  reads: CardRead[],
  bestId: number | null,
  scaleX: number,
  scaleY: number,
) {
  for (const read of reads) {
    if (!read.present) continue;
    const isBest = read.itemId === bestId;
    const { x, y, edge } = read.match;
    ctx.lineWidth = isBest ? 4 : 2;
    ctx.strokeStyle = isBest ? '#39ff6a' : 'rgba(255,255,255,.4)';
    ctx.strokeRect(x * scaleX, y * scaleY, edge * scaleX, edge * scaleY);
    if (isBest) {
      ctx.fillStyle = '#39ff6a';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('TAKE', x * scaleX, Math.max(12, y * scaleY - 6));
    }
  }
}
