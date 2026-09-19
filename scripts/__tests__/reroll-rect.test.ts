import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { BRAWL_LAYOUT, REROLL_SEARCH, findRerollButton } from '../../src/brawl/recognise';

// Outline of the "Use Re-Roll" pill, measured by hand from the pixels of each frame (bright ridge columns/rows),
// as [x0, y0, x1, y1] in that frame's own px. Tolerance is 3 px at 1920 wide, scaled with the frame.
const FRAMES: [string, number, number, number, number][] = [
  ['public/demo/choice1.png', 889, 711, 1111, 782],
  ['public/demo/choice2.png', 889, 711, 1111, 782],
  ['public/demo/draft-r2c1.png', 569, 455, 711, 500],
  ['public/demo/draft-r1c2.png', 569, 454, 711, 500],
  ['public/demo/draft-r2c3-reroll.png', 569, 455, 711, 500],
];

describe('findRerollButton on the real draft frames', () => {
  it.each(FRAMES)('%s: rect sits on the pill outline', async (file, x0, y0, x1, y1) => {
    const { data, info } = await sharp(path.join(__dirname, '..', '..', file))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const W = info.width;
    const sx = W / BRAWL_LAYOUT.ref.width,
      sy = info.height / BRAWL_LAYOUT.ref.height;
    const ox = Math.round(REROLL_SEARCH.x0 * sx),
      oy = Math.round(REROLL_SEARCH.y0 * sy);
    const w = Math.round((REROLL_SEARCH.x1 - REROLL_SEARCH.x0) * sx),
      h = Math.round((REROLL_SEARCH.y1 - REROLL_SEARCH.y0) * sy);
    const win = new Uint8Array(w * h * 4);
    for (let r = 0; r < h; r++) win.set(data.subarray(((oy + r) * W + ox) * 4, ((oy + r) * W + ox + w) * 4), r * w * 4);
    const found = findRerollButton(win, w, h, ox, oy, W);
    expect(found).not.toBeNull();
    const tol = (3 * W) / 1920;
    expect(Math.abs(found!.x0 - x0)).toBeLessThanOrEqual(tol);
    expect(Math.abs(found!.y0 - y0)).toBeLessThanOrEqual(tol);
    expect(Math.abs(found!.x1 - x1)).toBeLessThanOrEqual(tol);
    expect(Math.abs(found!.y1 - y1)).toBeLessThanOrEqual(tol);
  });
});
